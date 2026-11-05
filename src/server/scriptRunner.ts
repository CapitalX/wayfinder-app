import { randomUUID } from 'node:crypto';
import { instances, settings, type Instance } from './db.ts';
import { parse as parseAccess } from './access.ts';
import { clearFacts } from './facts.ts';
import { lockInstance } from './instanceLock.ts';
import { sn, table } from './sn.ts';

export const RUNNER_SERVICE = 'wayfinder_script_runner';
// The collector lives inside the evaluated global script, so it does not depend on REST-handler local variables.
export const RUNNER_SCRIPT = String.raw`(function process(request, response) {
    if (!gs.hasRole('admin')) {
        response.setStatus(403);
        response.setBody({ error: 'The admin role is required.' });
        return;
    }
    var body = request.body.data;
    if (!body || typeof body.script !== 'string' || !body.script.length || body.script.length > 100000) {
        response.setStatus(400);
        response.setBody({ error: 'Supply a script of 1-100000 characters.' });
        return;
    }
    var start = new Date().getTime();
    // Capture direct logging calls; leave quoted text and comments intact.
    var source = body.script.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\bgs\s*\.\s*(?:print|info|log|warn|error|debug)\s*\()/g, function (text, call) { return call ? '__wfPrint(' : text; });
    var wrapped = '(function () {\n' +
        'var output = [], result = null, error = null;\n' +
        'function __wfPrint() { var parts = []; for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i])); output.push(parts.join(" ")); }\n' +
        'try { result = (function () { return eval(' + JSON.stringify(source) + '); })(); if (result === undefined) result = null; }\n' +
        'catch (e) { error = { message: String(e.message || e), line: e.lineNumber || null }; }\n' +
        'try { if (JSON.stringify(result) === undefined) result = String(result); } catch (e) { result = String(result); }\n' +
        'return JSON.stringify({ output: output, result: result, error: error });\n' +
        '})()';
    var captured;
    try { captured = JSON.parse(String(GlideEvaluator.evaluateString(wrapped))); }
    catch (e) { captured = { output: [], result: null, error: { message: String(e.message || e), line: e.lineNumber || null } }; }
    captured.ms = new Date().getTime() - start;
    response.setBody(captured);
})(request, response);`;

const DEFINITION = { name: 'Wayfinder script runner', service_id: RUNNER_SERVICE, sys_scope: 'global', active: true, is_versioned: false };
const operation = (definition: string) => ({ name: 'Run script', web_service_definition: definition, sys_scope: 'global', http_method: 'POST', relative_path: '/run', active: true,
  requires_authentication: true, requires_acl_authorization: false, operation_script: RUNNER_SCRIPT });
// Accept saved ACL IDs from older installations so their approved removal remains possible.
const TABLES = ['sys_ws_definition', 'sys_security_acl', 'sys_ws_operation'] as const;
type RunnerTable = typeof TABLES[number];
type Records = Partial<Record<RunnerTable, string>>;
const id = /^[0-9a-f]{32}$/;
const pathPattern = /^\/api\/[a-zA-Z0-9_]+\/wayfinder_script_runner\/run$/;
export const RUNNER_MISSING = "The script runner isn't set up on this instance. Offer setup_script_runner so the user can approve its installation, or use Set up script runner in Settings.";

export function runnerRecords(inst: Instance): Records {
  const records = JSON.parse(inst.script_runner_records || '{}');
  if (!records || Array.isArray(records) || typeof records !== 'object' || Object.entries(records).some(([k, v]) => !TABLES.includes(k as RunnerTable) || typeof v !== 'string' || !id.test(v))) throw new Error('Invalid saved script runner records.');
  return records;
}
export function runnerCard(action: 'setup' | 'remove', inst: Instance) {
  const records = runnerRecords(inst);
  return { kind: 'script-runner', action, instance: inst.url, scope: 'global',
    why: action === 'setup' ? "Installs an authenticated, admin-only endpoint that can execute any server-side script as the calling admin. Uses Global's default update set, then restores the account's application and update set. Reuses an identical installation or replaces an empty leftover definition." : 'Deletes only the saved runner records. Other Wayfinder installations sharing this runner will also lose access.',
    records: action === 'setup' ? [
      { table: 'sys_ws_definition', name: DEFINITION.name },
      { table: 'sys_ws_operation', name: 'POST /run · authentication required · script checks admin role (no separate ACL)' },
    ] : TABLES.filter((t) => records[t]).map((t) => ({ table: t, sys_id: records[t] })),
    ...(action === 'setup' ? { script: RUNNER_SCRIPT } : {}),
  };
}
function current(inst: Instance): Instance {
  const now = instances.get(inst.id);
  if (!now || now.status !== 'active' || now.url !== inst.url) throw new Error('The instance changed. Ask again.');
  if (!settings.get().writeEnabled) throw new Error('Instance writes are off in Settings.');
  return now;
}
const matches = (row: Record<string, unknown>, expected: Record<string, unknown>) => Object.entries(expected).every(([k, v]) => String(row[k]) === String(v));
const read = async (inst: Instance, name: RunnerTable, sysId: string) => (await table(inst, name, `sys_id=${sysId}`, '', 1))[0];
function requireMatch(row: Record<string, unknown> | undefined, expected: Record<string, unknown>) {
  if (!row || !matches(row, expected)) throw new Error('The existing script runner differs from Wayfinder\'s exact script or security settings. Refusing to reuse or overwrite it.');
}
function globalPath(definition: Record<string, any>, namespace: string) {
  const path = `${String(definition.base_uri).replace(/\/$/, '')}/run`;
  // Custom Global APIs live under the instance's company code (e.g. /api/1234567/...), not the scope name, so the
  // namespace segment isn't checked; the definition's own scope must be Global.
  void namespace;
  if (definition.sys_scope !== 'global' || !pathPattern.test(path))
    throw new Error('ServiceNow placed the script runner outside Global: expected global scope and a global base_uri.');
  return path;
}
async function verify(inst: Instance, definition: Record<string, any>, namespace: string) {
  const path = globalPath(definition, namespace);
  requireMatch(definition, DEFINITION);
  if (!id.test(definition.sys_id)) throw new Error('The definition has an invalid sys_id.');
  const ops = await table(inst, 'sys_ws_operation', `web_service_definition=${definition.sys_id}`, '', 2);
  if (ops.length !== 1 || !id.test(ops[0].sys_id)) throw new Error('The existing script runner must have exactly one operation.');
  const op = ops[0];
  requireMatch(op, operation(definition.sys_id));
  return { path, records: { sys_ws_definition: definition.sys_id, sys_ws_operation: op.sys_id } as Records };
}

// Own the placement lock here: policy and Settings must not hold it while calling maintenance.
async function inGlobal<T>(inst: Instance, expected: string | null | undefined, work: (now: Instance, namespace: string) => Promise<T>): Promise<T> {
  const release = await lockInstance(inst.id, randomUUID());
  const restore: (() => Promise<unknown>)[] = [];
  const errors: string[] = [];
  let result!: T;
  try {
    inst = current(inst);
    if (expected !== undefined && (inst.script_runner_records ?? null) !== expected) throw new Error('The saved script runner records changed. Ask again.');
    const me = parseAccess(inst)?.userId;
    if (!me || !id.test(me)) throw new Error('Check access in Settings first, so Wayfinder knows which account to set.');
    const [global] = await table(inst, 'sys_scope', 'sys_id=global', 'scope', 1);
    if (!global?.scope || !/^[a-zA-Z0-9_]+$/.test(global.scope)) throw new Error('Cannot determine the Global API namespace.');
    let sets = await table(inst, 'sys_update_set', 'is_default=true^state=in progress^application=global', 'sys_id', 2);
    if (!sets.length) sets = await table(inst, 'sys_update_set', 'is_default=true^state=in progress^applicationISEMPTY', 'sys_id', 2);
    if (sets.length !== 1 || !id.test(sets[0].sys_id)) throw new Error("Cannot identify Global's default update set.");
    // Snapshot both before changing either, including duplicate preferences and missing rows.
    const prefs = [];
    for (const [name, value] of [['apps.current_app', 'global'], ['sys_update_set', sets[0].sys_id]]) {
      const rows = await table(inst, 'sys_user_preference', `user=${me}^name=${name}`, 'sys_id,value', 100);
      if (rows.length === 100 || rows.some((r) => !id.test(r.sys_id))) throw new Error(`Cannot safely save ${name} preferences.`);
      prefs.push({ name, value, rows });
    }
    for (const { name, value, rows } of prefs) {
      if (!rows.length) {
        const row = (await sn(inst, '/api/now/table/sys_user_preference', { method: 'POST', body: { user: me, name, value, type: 'string' } })).result;
        if (!row || !id.test(row.sys_id)) throw new Error(`No sys_id returned for ${name}; check the account's preferences before retrying.`);
        restore.push(() => sn(inst, `/api/now/table/sys_user_preference/${row.sys_id}`, { method: 'DELETE' }));
      }
      for (const row of rows) if (row.value !== value) {
        restore.push(() => sn(inst, `/api/now/table/sys_user_preference/${row.sys_id}`, { method: 'PATCH', body: { value: row.value } }));
        await sn(inst, `/api/now/table/sys_user_preference/${row.sys_id}`, { method: 'PATCH', body: { value } });
      }
      const switched = await table(inst, 'sys_user_preference', `user=${me}^name=${name}`, 'value', 100);
      if (!switched.length || switched.some((r) => r.value !== value)) throw new Error(`ServiceNow did not switch ${name} to Global's placement.`);
    }
    result = await work(inst, global.scope);
  } catch (e) { errors.push((e as Error).message); }
  finally {
    // Restore the application first, then its update set, even when a preceding restore fails.
    for (const undo of restore) {
      try { await undo(); } catch (e) { errors.push(`Could not restore account placement: ${(e as Error).message}`); }
    }
    clearFacts(inst.id);
    release();
  }
  if (errors.length) throw new Error(errors.join(' '));
  return result;
}

async function deleteRecords(inst: Instance, records: Records, rollback = false) {
  // Operation first; keep unfinished IDs if a delete fails, including legacy ACLs.
  for (const name of ['sys_ws_operation', 'sys_security_acl', 'sys_ws_definition'] as const) {
    if (!records[name]) continue;
    if (!rollback) current(inst);
    if (rollback || await read(inst, name, records[name]!)) await sn(inst, `/api/now/table/${name}/${records[name]}`, { method: 'DELETE' });
    delete records[name];
    instances.update(inst.id, { script_runner_records: Object.keys(records).length ? JSON.stringify(records) : null });
  }
}

export async function setupScriptRunner(inst: Instance, expected?: string | null) {
  return inGlobal(inst, expected, async (inst, namespace) => {
    instances.update(inst.id, { script_runner_path: null });
    const found = await table(inst, 'sys_ws_definition', `service_id=${RUNNER_SERVICE}`, '', 2);
    if (found.length > 1) throw new Error('Multiple script runner definitions exist; refusing to choose one.');
    const saved = runnerRecords(inst);
    let definition = found[0];
    if (definition && definition.service_id === RUNNER_SERVICE && id.test(definition.sys_id)) {
      const ops = await table(inst, 'sys_ws_operation', `web_service_definition=${definition.sys_id}`, 'sys_id', 1);
      if (!ops.length && (!Object.keys(saved).length || (Object.keys(saved).length === 1 && saved.sys_ws_definition === definition.sys_id))) {
        current(inst);
        await sn(inst, `/api/now/table/sys_ws_definition/${definition.sys_id}`, { method: 'DELETE' });
        delete saved.sys_ws_definition;
        instances.update(inst.id, { script_runner_records: null });
        definition = undefined;
      }
    }
    const reused = !!definition;
    const created: Records = {};
    try {
      if (!definition) {
        if (Object.keys(saved).length) throw new Error('A partial script runner installation is saved. Remove script runner in Settings before setting it up again.');
        for (const name of ['sys_ws_definition', 'sys_ws_operation'] as const) {
          current(inst);
          const body = name === 'sys_ws_definition' ? DEFINITION : operation(created.sys_ws_definition!);
          const row = (await sn(inst, `/api/now/table/${name}`, { method: 'POST', body })).result;
          if (!row || !id.test(row.sys_id)) throw new Error(`The instance did not return a sys_id for ${name}. Check the instance before retrying setup.`);
          created[name] = row.sys_id;
          instances.update(inst.id, { script_runner_records: JSON.stringify(created) });
          const actual = await read(inst, name, row.sys_id);
          if (name === 'sys_ws_definition' && actual) globalPath(actual, namespace);
          requireMatch(actual, body);
        }
        definition = await read(inst, 'sys_ws_definition', created.sys_ws_definition!);
      }
      const checked = await verify(inst, definition, namespace);
      if (Object.entries(saved).some(([key, value]) => checked.records[key as RunnerTable] !== value)) throw new Error('Saved runner IDs differ from the existing installation. Remove the saved runner before setting up again.');
      current(inst);
      instances.update(inst.id, { script_runner_path: checked.path, script_runner_records: JSON.stringify(checked.records) });
      return { ready: true, reused, path: checked.path };
    } catch (e) {
      try { await deleteRecords(inst, created, true); }
      catch (cleanup) { throw new Error(`${(e as Error).message} Rollback failed: ${(cleanup as Error).message}. Saved remaining IDs for removal.`); }
      throw e;
    }
  });
}

export async function removeScriptRunner(inst: Instance, expected = inst.script_runner_records) {
  return inGlobal(inst, expected ?? null, async (inst) => {
    const records = runnerRecords(inst);
    if (!Object.keys(records).length) throw new Error('No saved script runner records to remove.');
    if (records.sys_ws_definition) {
      const ops = await table(inst, 'sys_ws_operation', `web_service_definition=${records.sys_ws_definition}`, 'sys_id', 2);
      if (ops.some((o) => o.sys_id !== records.sys_ws_operation)) throw new Error('This definition has other operations. Refusing to delete records beyond the approved runner.');
    }
    instances.update(inst.id, { script_runner_path: null });
    await deleteRecords(inst, records);
    return { removed: true };
  });
}

export async function runScript(inst: Instance, script: string) {
  inst = current(inst);
  if (!settings.get().scriptingEnabled) throw new Error('Server-side scripting is off in Settings.');
  if (!inst.script_runner_path) throw new Error(RUNNER_MISSING);
  if (!pathPattern.test(inst.script_runner_path)) throw new Error('Invalid saved script runner path. Set up the script runner again.');
  const response = await sn(inst, inst.script_runner_path, { method: 'POST', body: { script } });
  return response.result;
}
