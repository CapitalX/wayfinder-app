import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sn, table } = vi.hoisted(() => ({ sn: vi.fn(), table: vi.fn() }));
vi.mock('../src/server/sn.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/sn.ts')>()), sn, table }));
const { instances, settings } = await import('../src/server/db.ts');
const { instanceServer } = await import('../src/server/instanceTools.ts');
const { RUNNER_SCRIPT, setupScriptRunner, removeScriptRunner, runnerCard } = await import('../src/server/scriptRunner.ts');
const { lockInstance, instanceBusy } = await import('../src/server/instanceLock.ts');
const { scriptRunnerSettings } = await import('../src/server/scriptRunnerSettings.ts');
let inst: ReturnType<typeof instances.create>;
let remote: Record<string, Record<string, any>[]>;
let sequence: number;
const makeId = () => (++sequence).toString(16).padStart(32, '0');
const path = '/api/global/wayfinder_script_runner/run';
const userId = 'a'.repeat(32), defaultSet = 'd'.repeat(32);
const runnerWrites = () => sn.mock.calls.filter((c) => /sys_ws_|sys_security_acl/.test(c[1]));
const preferences = () => remote.sys_user_preference.map((r) => ({ ...r }));
const current = () => instances.get(inst.id)!;
const tools = () => (instanceServer(inst, true).instance as any)._registeredTools;
const call = (name: string, input = {}) => tools()[name].handler(input);
const json = (r: any) => { expect(r.isError, r.content[0].text).not.toBe(true); return JSON.parse(r.content[0].text); };
const request = (body: unknown) => scriptRunnerSettings.request(`/${inst.id}/script-runner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  sn.mockReset(); table.mockReset(); sequence = 0;
  settings.set({ writeEnabled: true, scriptingEnabled: true });
  inst = instances.create({ name: 'Test', url: 'https://dev12345.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'basic', auth_user: 'admin' });
  instances.update(inst.id, { profile: JSON.stringify({ userId }) });
  remote = { sys_ws_definition: [], sys_ws_operation: [], sys_security_acl: [],
    sys_scope: [{ sys_id: 'global', scope: 'global' }],
    sys_update_set: [{ sys_id: defaultSet, application: 'global', is_default: true, state: 'in progress' }],
    sys_user_preference: [
      { sys_id: makeId(), user: userId, name: 'apps.current_app', value: 'b'.repeat(32) },
      { sys_id: makeId(), user: userId, name: 'sys_update_set', value: 'c'.repeat(32) },
    ],
  };
  table.mockImplementation(async (_i, name, query) => (remote[name] ?? []).filter((row) => query.split('^').every((part: string) => {
    if (part.endsWith('ISEMPTY')) return !row[part.slice(0, -7)];
    const [field, value] = part.split('='); return String(row[field]) === value;
  })).map((r) => ({ ...r })));
  sn.mockImplementation(async (_i, target, init) => {
    const [, , , , name, id] = target.split('/');
    if (['sys_ws_definition', 'sys_ws_operation', 'sys_security_acl'].includes(name) && ['POST', 'DELETE'].includes(init?.method)) {
      expect(remote.sys_user_preference.filter((r) => r.name === 'apps.current_app').every((r) => r.value === 'global')).toBe(true);
      expect(remote.sys_user_preference.filter((r) => r.name === 'sys_update_set').every((r) => r.value === defaultSet)).toBe(true);
      expect(instanceBusy(inst.id)).not.toBeNull();
    }
    if (init?.method === 'PATCH') { Object.assign(remote[name].find((r) => r.sys_id === id)!, init.body); return {}; }
    if (init?.method === 'POST' && remote[name]) {
      const row = { ...init.body, sys_id: makeId(), ...(name === 'sys_ws_definition' ? { base_uri: path.slice(0, -4) } : {}) };
      remote[name].push(row); return { result: { ...row } };
    }
    if (init?.method === 'DELETE') { remote[name] = remote[name].filter((r) => r.sys_id !== id); return {}; }
    if (target === path) return { result: { output: ['hello'], result: 42, error: null, ms: 1 } };
    throw new Error(`Unexpected request ${target}`);
  });
});

describe('runner installation and removal', () => {
  it('creates only two global records with authentication and an in-script admin check, then restores placement', async () => {
    const before = preferences();
    expect(json(await call('setup_script_runner'))).toEqual({ ready: true, reused: false, path });
    expect(runnerWrites().map((c) => c[1])).toEqual(['/api/now/table/sys_ws_definition', '/api/now/table/sys_ws_operation']);
    expect(remote.sys_ws_definition[0]).toMatchObject({ service_id: 'wayfinder_script_runner', sys_scope: 'global' });
    expect(remote.sys_ws_operation[0]).toMatchObject({ sys_scope: 'global', requires_authentication: true, requires_acl_authorization: false, operation_script: RUNNER_SCRIPT });
    expect(remote.sys_security_acl).toEqual([]);
    expect(current().script_runner_path).toBe(path);
    expect(Object.keys(JSON.parse(current().script_runner_records!))).toHaveLength(2);
    expect(runnerCard('setup', current())).toMatchObject({ script: RUNNER_SCRIPT, records: [{ table: 'sys_ws_definition' }, { table: 'sys_ws_operation' }] });
    expect(preferences()).toEqual(before);
    expect(instanceBusy(inst.id)).toBeNull();
  });
  it('accepts the company-code namespace ServiceNow gives custom Global APIs', async () => {
    const impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      const result = await impl(...args);
      if (args[1] === '/api/now/table/sys_ws_definition') remote.sys_ws_definition[0].base_uri = '/api/1234567/wayfinder_script_runner';
      return result;
    });
    expect((await setupScriptRunner(inst)).path).toBe('/api/1234567/wayfinder_script_runner/run');
  });
  it('accepts a verified custom Global namespace', async () => {
    remote.sys_scope[0].scope = 'custom_namespace';
    const impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      const result = await impl(...args);
      if (args[1] === '/api/now/table/sys_ws_definition') remote.sys_ws_definition[0].base_uri = '/api/custom_namespace/wayfinder_script_runner';
      return result;
    });
    expect((await setupScriptRunner(inst)).path).toBe('/api/custom_namespace/wayfinder_script_runner/run');
  });
  it('restores duplicate preferences and deletes temporary preferences when originally absent', async () => {
    remote.sys_user_preference.push({ ...remote.sys_user_preference[0], sys_id: makeId(), value: 'e'.repeat(32) });
    const before = preferences();
    await setupScriptRunner(inst);
    expect(preferences()).toEqual(before);
    remote.sys_user_preference = [];
    await removeScriptRunner(current());
    expect(preferences()).toEqual([]);
  });
  it('uses the Global default when its application field is empty', async () => {
    remote.sys_update_set[0].application = '';
    await expect(setupScriptRunner(inst)).resolves.toMatchObject({ ready: true });
  });
  it('reuses an identical installation, including one installed by another Wayfinder', async () => {
    await setupScriptRunner(inst);
    instances.update(inst.id, { script_runner_path: null, script_runner_records: null });
    sn.mockClear();
    expect(await setupScriptRunner(inst)).toEqual({ ready: true, reused: true, path });
    expect(runnerWrites()).toEqual([]);
  });
  it.each(['script', 'authentication', 'authorization', 'extra operation', 'scope', 'definition scope', 'path'])('refuses a changed installation: %s', async (change) => {
    await setupScriptRunner(inst);
    if (change === 'script') remote.sys_ws_operation[0].operation_script += '\n';
    if (change === 'authentication') remote.sys_ws_operation[0].requires_authentication = false;
    if (change === 'authorization') remote.sys_ws_operation[0].requires_acl_authorization = true;
    if (change === 'scope') remote.sys_ws_operation[0].sys_scope = 'x_other';
    if (change === 'definition scope') remote.sys_ws_definition[0].sys_scope = 'x_other';
    if (change === 'extra operation') remote.sys_ws_operation.push({ ...remote.sys_ws_operation[0], sys_id: makeId() });
    if (change === 'path') remote.sys_ws_definition[0].base_uri = '/api/x_other/some_other_service';
    sn.mockClear();
    const before = preferences();
    await expect(setupScriptRunner(inst)).rejects.toThrow();
    expect(current().script_runner_path).toBeNull();
    expect(runnerWrites()).toEqual([]);
    expect(preferences()).toEqual(before);
  });
  it('rolls back a failed operation create and includes the ServiceNow status and message in tool errors', async () => {
    const before = preferences(), impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      if (args[1] === '/api/now/table/sys_ws_operation') throw new Error('POST sys_ws_operation failed (403): Access denied');
      return impl(...args);
    });
    const result = await call('setup_script_runner');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('failed (403): Access denied');
    expect(remote.sys_ws_definition).toEqual([]);
    expect(current()).toMatchObject({ script_runner_path: null, script_runner_records: null });
    expect(preferences()).toEqual(before);
  });
  it('rolls back both created records in reverse order when operation verification fails', async () => {
    const impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      const result = await impl(...args);
      if (args[1] === '/api/now/table/sys_ws_operation') remote.sys_ws_operation[0].requires_authentication = false;
      return result;
    });
    await expect(setupScriptRunner(inst)).rejects.toThrow('security settings');
    expect(runnerWrites().filter((c) => c[2].method === 'DELETE').map((c) => c[1].split('/')[4])).toEqual(['sys_ws_operation', 'sys_ws_definition']);
    expect(current().script_runner_records).toBeNull();
  });
  it.each(['scope', 'base_uri'])('rolls back a definition with non-global %s before creating an operation', async (field) => {
    const before = preferences(), impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      const result = await impl(...args);
      if (args[1] === '/api/now/table/sys_ws_definition') remote.sys_ws_definition[0][field === 'scope' ? 'sys_scope' : field] = field === 'scope' ? 'x_other' : '/api/x_other/some_other_service';
      return result;
    });
    await expect(setupScriptRunner(inst)).rejects.toThrow('outside Global');
    expect(remote.sys_ws_definition).toEqual([]); expect(remote.sys_ws_operation).toEqual([]);
    expect(preferences()).toEqual(before);
  });
  it.each([false, true])('replaces a leftover definition with no operations (saved: %s)', async (saved) => {
    const leftover = { sys_id: makeId(), service_id: 'wayfinder_script_runner', sys_scope: 'x_other' };
    remote.sys_ws_definition.push(leftover);
    if (saved) instances.update(inst.id, { script_runner_records: JSON.stringify({ sys_ws_definition: leftover.sys_id }) });
    expect(await setupScriptRunner(inst)).toMatchObject({ ready: true, reused: false });
    expect(runnerWrites()[0][1]).toBe(`/api/now/table/sys_ws_definition/${leftover.sys_id}`);
    expect(remote.sys_ws_definition).toHaveLength(1);
    expect(remote.sys_ws_definition[0].sys_id).not.toBe(leftover.sys_id);
  });
  it('leaves unrelated empty definitions alone', async () => {
    const other = { sys_id: makeId(), service_id: 'other' };
    remote.sys_ws_definition.push(other);
    await setupScriptRunner(inst);
    expect(remote.sys_ws_definition).toContain(other);
  });
  it('preserves the original error and remaining IDs when rollback fails, then permits cleanup', async () => {
    const before = preferences(), impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      if (args[1] === '/api/now/table/sys_ws_operation') throw new Error('create failed (403): denied');
      if (args[2]?.method === 'DELETE') throw new Error('delete failed (500): unavailable');
      return impl(...args);
    });
    await expect(setupScriptRunner(inst)).rejects.toThrow('create failed (403): denied Rollback failed: delete failed (500): unavailable');
    expect(JSON.parse(current().script_runner_records!)).toEqual({ sys_ws_definition: remote.sys_ws_definition[0].sys_id });
    expect(preferences()).toEqual(before);
    sn.mockImplementation(impl);
    await removeScriptRunner(current());
    expect(current().script_runner_records).toBeNull();
  });
  it('restores an application switch when the update-set switch fails', async () => {
    const before = preferences(), impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      if (args[2]?.body?.value === defaultSet) throw new Error('switch failed (403)');
      return impl(...args);
    });
    await expect(setupScriptRunner(inst)).rejects.toThrow('switch failed (403)');
    expect(preferences()).toEqual(before);
    expect(runnerWrites()).toEqual([]);
    expect(instanceBusy(inst.id)).toBeNull();
  });
  it('reports both the original failure and restoration failure, still restoring the other preference and unlocking', async () => {
    const before = preferences(), impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      if (args[1] === '/api/now/table/sys_ws_operation') throw new Error('create failed (403)');
      if (args[2]?.body?.value === before[0].value) throw new Error('restore failed (500)');
      return impl(...args);
    });
    await expect(setupScriptRunner(inst)).rejects.toThrow('create failed (403) Could not restore account placement: restore failed (500)');
    expect(remote.sys_user_preference[1]).toEqual(before[1]);
    expect(remote.sys_ws_definition).toEqual([]);
    expect(instanceBusy(inst.id)).toBeNull();
  });
  it('deletes a newly created record even when verification cannot read it', async () => {
    const impl = table.getMockImplementation()!;
    table.mockImplementation(async (...args) => args[1] === 'sys_ws_definition' && args[2].startsWith('sys_id=') ? [] : impl(...args));
    await expect(setupScriptRunner(inst)).rejects.toThrow('security settings');
    expect(remote.sys_ws_definition).toEqual([]);
    expect(current().script_runner_records).toBeNull();
  });
  it('refuses a preference switch that ServiceNow silently ignores', async () => {
    const impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => args[2]?.body?.value === 'global' ? {} : impl(...args));
    await expect(setupScriptRunner(inst)).rejects.toThrow('did not switch');
    expect(runnerWrites()).toEqual([]);
  });
  it('deletes only saved IDs, operation first, and restores placement', async () => {
    await setupScriptRunner(inst);
    const before = preferences(), ids = JSON.parse(current().script_runner_records!);
    sn.mockClear();
    expect(json(await call('remove_script_runner', { records: current().script_runner_records }))).toEqual({ removed: true });
    expect(runnerWrites().map((c) => [c[1], c[2]])).toEqual(['sys_ws_operation', 'sys_ws_definition'].map((name) => [`/api/now/table/${name}/${ids[name]}`, { method: 'DELETE' }]));
    expect(current()).toMatchObject({ script_runner_path: null, script_runner_records: null });
    expect(preferences()).toEqual(before);
  });
  it('retains remaining IDs after a failed deletion and restores placement, so removal can resume', async () => {
    await setupScriptRunner(inst);
    const before = preferences(), impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      if (args[2]?.method === 'DELETE' && args[1].includes('sys_ws_definition')) throw new Error('403');
      return impl(...args);
    });
    await expect(removeScriptRunner(current())).rejects.toThrow('403');
    expect(current().script_runner_path).toBeNull();
    expect(Object.keys(JSON.parse(current().script_runner_records!))).toEqual(['sys_ws_definition']);
    expect(preferences()).toEqual(before);
    sn.mockImplementation(impl);
    await removeScriptRunner(current());
    expect(current().script_runner_records).toBeNull();
  });
  it('can still remove saved legacy ACL records', async () => {
    await setupScriptRunner(inst);
    const acl = { sys_id: makeId() };
    remote.sys_security_acl.push(acl);
    instances.update(inst.id, { script_runner_records: JSON.stringify({ ...JSON.parse(current().script_runner_records!), sys_security_acl: acl.sys_id }) });
    await removeScriptRunner(current());
    expect(remote.sys_security_acl).toEqual([]);
  });
  it('refuses stale approvals and definitions with other operations', async () => {
    await setupScriptRunner(inst);
    await expect(removeScriptRunner(inst, '{}')).rejects.toThrow('changed');
    await expect(setupScriptRunner(inst, null)).rejects.toThrow('changed');
    remote.sys_ws_operation.push({ ...remote.sys_ws_operation[0], sys_id: makeId() });
    sn.mockClear();
    await expect(removeScriptRunner(current())).rejects.toThrow('other operations');
    expect(runnerWrites()).toEqual([]);
  });
  it('serializes parallel setup calls to one installation', async () => {
    await Promise.all([setupScriptRunner(inst), setupScriptRunner(inst)]);
    expect(runnerWrites()).toHaveLength(2);
  });
  it('waits for chat placement and holds the same instance lock through restoration', async () => {
    const release = await lockInstance(inst.id, 'other-chat');
    const before = preferences();
    const setup = setupScriptRunner(inst);
    await new Promise((r) => setTimeout(r, 10));
    expect(sn).not.toHaveBeenCalled();
    let releaseRestore!: () => void;
    const restoring = new Promise<void>((r) => { releaseRestore = r; });
    const impl = sn.getMockImplementation()!;
    sn.mockImplementation(async (...args) => {
      if (args[2]?.body?.value === before[0].value) await restoring;
      return impl(...args);
    });
    release();
    await vi.waitFor(() => expect(remote.sys_ws_operation).toHaveLength(1));
    let entered = false;
    const other = lockInstance(inst.id, 'next-chat').then((unlock) => { entered = true; unlock(); });
    await new Promise((r) => setTimeout(r, 10));
    expect(entered).toBe(false);
    releaseRestore();
    await setup; await other;
    expect(preferences()).toEqual(before);
  });
});

describe('running scripts', () => {
  it('posts only the script to the saved endpoint and returns its captured response', async () => {
    const oldTools = tools();
    await setupScriptRunner(inst);
    const result = json(await oldTools.run_script.handler({ script: 'gs.print("hello"); 42;', why: 'Check output' }));
    expect(result).toEqual({ output: ['hello'], result: 42, error: null, ms: 1 });
    expect(sn).toHaveBeenLastCalledWith(expect.objectContaining({ id: inst.id }), path, { method: 'POST', body: { script: 'gs.print("hello"); 42;' } });
  });
  it('masks output, results and exceptions before clipping', async () => {
    await setupScriptRunner(inst);
    sn.mockResolvedValue({ result: { output: ['Authorization: Bearer private-value'], result: { password: 'private-value' }, error: { message: 'password=private-value' }, padding: 'x'.repeat(7000) } });
    const r = await call('run_script', { script: 'x', why: 'test' });
    expect(r.content[0].text).toContain('[masked]'); expect(r.content[0].text).not.toContain('private-value');
    expect(r.content[0].text).toContain('more characters');
  });
  it('refuses scripting off, writes off, missing runner and invalid paths without a request', async () => {
    expect((await call('run_script', { script: 'x', why: 'test' })).content[0].text).toContain('setup_script_runner');
    settings.set({ scriptingEnabled: false });
    expect((await call('run_script', { script: 'x', why: 'test' })).content[0].text).toContain('scripting is off');
    settings.set({ scriptingEnabled: true, writeEnabled: false });
    expect((await call('run_script', { script: 'x', why: 'test' })).content[0].text).toContain('writes are off');
    settings.set({ writeEnabled: true });
    instances.update(inst.id, { script_runner_path: '/api/now/table/sys_user' });
    expect((await call('run_script', { script: 'x', why: 'test' })).isError).toBe(true);
    expect(sn).not.toHaveBeenCalled();
  });
});

describe('installed script', () => {
  const evaluate = (script: unknown, admin = true) => {
    let body: any, status = 200;
    const evaluateString = vi.fn((source: string) => runInNewContext(source));
    runInNewContext(RUNNER_SCRIPT, { gs: { hasRole: (role: string) => admin && role === 'admin' }, request: { body: { data: { script } } }, response: { setStatus: (s: number) => { status = s; }, setBody: (b: any) => { body = b; } }, GlideEvaluator: { evaluateString } });
    return { body, status, evaluateString };
  };
  it('captures all logging calls, every argument, expression results and exceptions', () => {
    const { body } = evaluate(['print', 'info', 'log', 'warn', 'error', 'debug'].map((m) => `gs.${m}('${m}', 2);`).join('\n') + '\n({answer: 42});');
    expect(body.output).toEqual(['print 2', 'info 2', 'log 2', 'warn 2', 'error 2', 'debug 2']);
    expect(body.result).toEqual({ answer: 42 }); expect(body.error).toBeNull(); expect(body.ms).toBeGreaterThanOrEqual(0);
    expect(evaluate('gs.print("before"); throw {message: "oops", lineNumber: 9};').body).toMatchObject({ output: ['before'], error: { message: 'oops', line: 9 } });
    expect(evaluate('(function () { return 7; })();').body.result).toBe(7);
    expect(evaluate('var output = "own"; var result = 7; gs.print(output); result;').body).toMatchObject({ output: ['own'], result: 7 });
  });
  it('preserves logging-looking strings and comments and handles non-JSON results', () => {
    expect(evaluate('/* gs.print("skip"); */ gs.info("gs.print(hi)"); "gs.log(";').body).toMatchObject({ output: ['gs.print(hi)'], result: 'gs.log(' });
    expect(evaluate('var a = {}; a.self = a; a;').body.result).toBe('[object Object]');
  });
  it('refuses non-admin callers and invalid inputs before evaluating', () => {
    const refused = evaluate('42', false); expect(refused.status).toBe(403); expect(refused.evaluateString).not.toHaveBeenCalled();
    for (const input of [null, '', {}, 'x'.repeat(100001)]) { const r = evaluate(input); expect(r.status).toBe(400); expect(r.evaluateString).not.toHaveBeenCalled(); }
  });
});

describe('Settings approval boundary', () => {
  it('previews without writes, then consumes approval exactly once', async () => {
    const preview = await (await request({ action: 'setup' })).json();
    expect(preview.card.script).toBe(RUNNER_SCRIPT); expect(preview.card.records).toHaveLength(2); expect(sn).not.toHaveBeenCalled();
    expect((await request({ action: 'setup', confirm: true })).status).toBe(409);
    expect((await request({ action: 'setup', confirm: true, plan_id: preview.plan_id })).status).toBe(200);
    expect((await request({ action: 'setup', confirm: true, plan_id: preview.plan_id })).status).toBe(409);
    const removal = await (await request({ action: 'remove' })).json();
    expect(removal.card.records.map((r: any) => r.sys_id)).toHaveLength(2);
    expect((await request({ action: 'remove', confirm: true, plan_id: removal.plan_id })).status).toBe(200);
    expect(current().script_runner_records).toBeNull();
  });
  it('rechecks approved IDs after waiting for another chat', async () => {
    const preview = await (await request({ action: 'setup' })).json();
    const release = await lockInstance(inst.id, 'other-chat');
    const response = request({ action: 'setup', confirm: true, plan_id: preview.plan_id });
    await new Promise((r) => setTimeout(r, 10));
    instances.update(inst.id, { script_runner_records: JSON.stringify({ sys_ws_definition: 'f'.repeat(32) }) });
    release();
    expect((await response).status).toBe(502);
    expect(sn).not.toHaveBeenCalled();
  });
  it('binds action, address, IDs, expiry, and current settings to the preview', async () => {
    let p = await (await request({ action: 'setup' })).json();
    expect((await request({ action: 'remove', confirm: true, plan_id: p.plan_id })).status).toBe(409);
    instances.update(inst.id, { url: 'https://dev54321.service-now.com' });
    expect((await request({ action: 'setup', confirm: true, plan_id: p.plan_id })).status).toBe(409);
    p = await (await request({ action: 'setup' })).json();
    settings.set({ writeEnabled: false });
    expect((await request({ action: 'setup', confirm: true, plan_id: p.plan_id })).status).toBe(403);
    settings.set({ writeEnabled: true });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 600001);
    expect((await request({ action: 'setup', confirm: true, plan_id: p.plan_id })).status).toBe(409);
    vi.restoreAllMocks(); expect(sn).not.toHaveBeenCalled();
  });
});
