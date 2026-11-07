import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { apps, audit, chats, specHash, instances, settings, fullPermissions, type App } from './db.ts';
import { GATED, gateMessage, missingChecks } from './buildGate.ts';
import { TABLE_NAME, table as table_ } from './sn.ts';
import { PDI_WRITE_TOOLS } from './pdiTools.ts';
import { BUILD_WRITE_TOOLS, SANDBOX, buildState, installPreview, readSpec } from './buildTools.ts';
import { can, parse as parseAccess } from './access.ts';
import { INSTANCE_READS, INSTANCE_WRITES } from './instanceReads.ts';
import { skillAllowed } from './skills.ts';
import { writeGate } from './placement.ts';
import { currentUpdateSet, landsIn, noteText } from './facts.ts';
import { WRITES_IN, refusal } from './modeTools.ts';
import type { Mode } from './prompts.ts';
import { chatPlacement, ensurePlace } from './placement.ts';
import { holdFor, lockInstance } from './instanceLock.ts';
import { CREDENTIAL_TABLES, scrub } from './scrub.ts';
import { runnerCard } from './scriptRunner.ts';
import { toolServers } from './toolServers.ts';

// Decides every tool call. Reads run; instance changes need approval or explicit auto permission.
// Web access is limited to the allowlist; any tool not named here is refused.

export type Emit = (event: Record<string, unknown>) => void;

const pending = new Map<string, { chatId: string; resolve: (allow: boolean) => void }>();

// A click answers a card only from the chat that showed it, so one chat can't approve another chat's change.
export function decide(chatId: string, approvalId: string, allow: boolean): boolean {
  const p = pending.get(approvalId);
  if (!p || p.chatId !== chatId) return false;
  pending.delete(approvalId);
  p.resolve(allow);
  return true;
}

const instanceName = (tool: string) => tool.replace(/^mcp__instance__/, '');
const instanceIsRead = (tool: string) => INSTANCE_READS.has(instanceName(tool));

export function hostAllowed(url: string, allowlist: string[]): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return allowlist.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
}

// Allowlisted names must still point at the public internet: refuse private, loopback, link-local and tailnet
// (100.64.0.0/10) addresses, so a page or a DNS trick can't use web fetch to reach inside the network.
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('fd7a:115c:a1e0');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function resolvesPublic(url: string): Promise<boolean> {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return !privateAddress(host);
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateAddress(a.address));
  } catch { return false; }
}

// A record change, described for the approval card: which table and record (with its number and short description,
// looked up live), the action, and the exact field changes. Every other argument goes on the card too.
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
async function describeChange(toolName: string, input: Record<string, unknown>, instanceId: string | null, chatId?: string): Promise<Record<string, unknown>> {
  const inner = input;
  const name = instanceName(toolName);
  const table = typeof inner.table === 'string' ? inner.table : '';
  const sysId = typeof inner.sys_id === 'string' ? inner.sys_id : '';
  if (!table) return input;
  const action = /delete|remove/i.test(name) ? 'delete' : /create|insert|add/i.test(name) ? 'create' : /script|execute|run_script|background/i.test(name) ? 'script' : 'update';
  const changes = isObject(inner.fields) ? inner.fields : null;
  const { table: _t, sys_id: _s, fields: _f, ...rest } = inner;
  const also = Object.keys(rest).length ? rest : undefined;
  let record: string | undefined;
  // The chat's own instance, not whichever is active: the card describes where this chat's call will run.
  const inst = instanceId ? instances.get(instanceId) : undefined;
  // The record name is looked up before anyone clicks, so only for a plain table name and sys_id.
  const lookupRecord = async () => {
    if (!inst || !TABLE_NAME.test(table) || !/^[0-9a-f]{32}$/.test(sysId)) return;
    try {
      const [r] = await table_(inst, table, `sys_id=${sysId}`, 'number,name,short_description,sys_class_name,title,u_name', 1);
      if (r) record = [r.number || r.name || r.title || r.u_name, r.short_description].filter(Boolean).join(' · ') || undefined;
    } catch { /* the card still shows table and sys_id */ }
  };
  // Where it lands: the chat's own settled place, which the write puts back before it runs (ensurePlace). Read live
  // only without one: then the account's current setting is what the write uses, and another chat may have changed it.
  const p = chatId ? chatPlacement(chatId) : null;
  const own = p?.status === 'settled' && p.instance_id === inst?.id && p.update_set && p.home.place !== 'new-app'
    ? { update_set: p.update_set, application: `${p.home.name} (${p.home.scope})` } : null;
  const [, lands_in] = await Promise.all([lookupRecord(), own ?? (inst ? landsIn(inst).catch(() => null) : null)]);
  return { kind: 'record', action, tool: name, table, sys_id: sysId || undefined, record, lands_in: lands_in ?? undefined, changes, also };
}

const PLAN_GATED = new Set(['mcp__build__write_app_file', 'mcp__build__write_app_files', 'mcp__build__build_app', 'mcp__build__install_app']);

export function makeCanUseTool(chatId: string, instanceId: string | null, emit: Emit, opts: { followup?: boolean; mode?: Mode; toolServerRevisions?: Record<string, string> } = {}): CanUseTool {
  // Instance changes only happen in Build (modeTools.ts); with no mode given (older callers) nothing extra is refused.
  const readOnly = !!opts.mode && !WRITES_IN[opts.mode];
  // `shown` is what the approval card displays; the tool still gets `input` unchanged.
  // An approval covers one exact call: this tool, these arguments (a copy taken when the card is shown, so nothing can
  // change them afterwards) and this instance at this address. Each card is answered once.
  const ask = (toolName: string, raw: Record<string, unknown>, signal: AbortSignal, shown: Record<string, unknown> = raw, stillValid = () => true): Promise<PermissionResult> => {
    if (fullPermissions(instanceId ? instances.get(instanceId) : undefined)) return Promise.resolve(auto(toolName, structuredClone(raw), shown));
    const id = randomUUID();
    const input = structuredClone(raw);
    const where = instanceId ? instances.get(instanceId)?.url : undefined;
    emit({ t: 'approval', id, tool: toolName, input: structuredClone(shown) });
    return new Promise((resolve) => {
      const finish = (allow: boolean, why: string) => {
        if (!pending.has(id) && why !== 'click') return;
        pending.delete(id);
        clearTimeout(timer);
        // The instance moved or was switched off after the card was shown: the approval doesn't carry over.
        const now = instanceId ? instances.get(instanceId) : undefined;
        if (allow && !stillValid()) { allow = false; why = 'tool server changed'; }
        if (allow && instanceId && (now?.url !== where || now?.status !== 'active')) { allow = false; why = 'instance changed'; }
        audit.add(chatId, instanceId, toolName, input, allow ? 'approved' : `denied (${why})`, id);
        emit({ t: 'approval_done', id, decision: allow ? 'allow' : 'deny' });
        resolve(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: why === 'instance changed' ? `The instance changed after the card was shown, so ${toolName} did not run. Ask again.` : `The user did not approve ${toolName}.` });
      };
      const timer = setTimeout(() => finish(false, 'timed out'), 15 * 60_000);
      signal.addEventListener('abort', () => finish(false, 'stopped'));
      pending.set(id, { chatId, resolve: (allow) => finish(allow, 'click') });
    });
  };

  // Auto mode is set by the user in the chat (never by a tool) and expires on its own.
  const autoAllowed = (app: App) => {
    const chat = chats.get(chatId);
    if (!chat || chat.auto_mode === 'ask') return false;
    // Auto mode is for personal developer instances only; anything else always asks.
    if (instanceId && instances.get(instanceId)?.kind === 'other') return false;
    if (!chat.auto_until || chat.auto_until < Date.now()) { chats.update(chatId, { auto_mode: 'ask', auto_until: null, auto_app_id: null }); return false; }
    return chat.auto_mode === 'app' ? chat.auto_app_id === app.id : !!app.project_id && app.project_id === chat.project_id;
  };
  const auto = (toolName: string, input: Record<string, unknown>, shown: Record<string, unknown>): PermissionResult => {
    const id = randomUUID();
    const full = fullPermissions(instanceId ? instances.get(instanceId) : undefined);
    audit.add(chatId, instanceId, toolName, input, full ? 'auto-approved (full permissions)' : 'auto-approved', id);
    emit({ t: 'approval', id, tool: toolName, input: shown, auto: true, full_permissions: full || undefined });
    emit({ t: 'approval_done', id, decision: 'allow' });
    return { behavior: 'allow', updatedInput: input };
  };

  const decideCall: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
    const { allowlist } = settings.get();
    const allow = (updatedInput = input): PermissionResult => ({ behavior: 'allow', updatedInput });
    // A refusal by policy (never shown as a card) is audited too, with the tool call's id, so the log holds every no.
    const deny = (message: string): PermissionResult => {
      audit.add(chatId, instanceId, toolName, input, `refused: ${message.slice(0, 300)}`, toolUseID ?? null);
      return { behavior: 'deny', message };
    };

    const external = /^mcp__([a-z0-9]+(?:_[a-z0-9]+)*)__([^\s]+)$/.exec(toolName);
    const server = external ? toolServers.get(external[1]) : undefined;
    if (server) {
      if (signal.aborted) return deny('This answer was stopped.');
      if (!server.enabled) return deny('This tool server is disabled in Settings.');
      if (readOnly || !settings.get().writeEnabled) return deny('User tool servers may write, so they are off in read-only modes and when changes are off in Settings.');
      const revision = opts.toolServerRevisions?.[server.key] ?? server.revision;
      if (opts.toolServerRevisions && opts.toolServerRevisions[server.key] !== server.revision) return deny('This tool server changed or was unavailable when this answer started. Start another answer.');
      // Third-party schemas vary: check every argument, including nested objects, URLs and scripts.
      const words = JSON.stringify(input).toLowerCase().split(/[^a-z0-9_]+/);
      if (words.some((word) => CREDENTIAL_TABLES.has(word))) return deny('These arguments name a credential table, which Wayfinder does not access.');
      return ask(toolName, input, signal, { kind: 'tool-server', server: server.label, tool: external![2], arguments: scrub(input) },
        () => { const now = toolServers.get(server.key); return !!now?.enabled && now.revision === revision && settings.get().writeEnabled; });
    }
    if (toolName === 'Agent' || toolName === 'Task') return allow();
    // Skills are read-only know-how from Wayfinder's own folders; only the ones this answer was given.
    if (toolName === 'Skill') return skillAllowed(input.skill) ? allow() : deny(`"${String(input.skill ?? '')}" is not one of Wayfinder's skills. Use a name from the Skills list.`);
    if (toolName === 'WebFetch') {
      const url = String(input.url ?? '');
      if (!hostAllowed(url, allowlist)) return deny(`${url} is not on the web allowlist (${allowlist.join(', ')}). Tell the user which domain to add in Settings if they want it.`);
      return (await resolvesPublic(url)) ? allow() : deny(`${url} points at a private or internal address, so it is blocked even though the domain is allowlisted.`);
    }
    if (toolName === 'WebSearch') {
      const asked = Array.isArray(input.allowed_domains) ? (input.allowed_domains as string[]) : [];
      const domains = asked.length ? asked.filter((d) => hostAllowed(`https://${d}`, allowlist)) : allowlist;
      return domains.length ? allow({ ...input, allowed_domains: domains, blocked_domains: undefined }) : deny('None of those domains are on the web allowlist.');
    }
    if (toolName.startsWith('mcp__sndocs__')) return allow();
    if (toolName.startsWith('mcp__project__')) return readOnly && opts.mode !== 'debug' && /__board_(pin|update)$/.test(toolName) ? deny('The board is for Debug and Build chats.') : allow();
    // Read-only modes: anything that could change the instance is refused before it can ask.
    if (readOnly && (PDI_WRITE_TOOLS.has(toolName) || toolName === 'mcp__pdi__placement' || toolName.startsWith('mcp__build__')
      || (toolName.startsWith('mcp__instance__') && !instanceIsRead(toolName)))) return deny(refusal(opts.mode!));
    const instanceWrite = (toolName.startsWith('mcp__instance__') && !instanceIsRead(toolName)) || PDI_WRITE_TOOLS.has(toolName) || BUILD_WRITE_TOOLS.has(toolName)
      || (toolName === 'mcp__pdi__placement' && input.advise_only !== true && fullPermissions(instanceId ? instances.get(instanceId) : undefined));
    if (instanceWrite && !settings.get().writeEnabled) return deny('Allow changes to the instance is off in Settings.');
    // Calls this account can't make are refused before they reach the instance, with the reason.
    const access = can(parseAccess(instanceId ? instances.get(instanceId) : undefined));
    if (PDI_WRITE_TOOLS.has(toolName) && toolName !== 'mcp__pdi__use_update_set' && toolName !== 'mcp__pdi__note_update_set' && !access.install) return deny('This account cannot install plugins or Store apps (no CI/CD access; needs admin or sn_cicd.sys_ci_automation). Give the user the click path instead.');
    if (BUILD_WRITE_TOOLS.has(toolName) && !access.build) return deny('This account cannot install or remove apps on the instance (needs an admin account). The app can still be planned and built here.');
    // Docs and out-of-the-box first, enforced: the build tools wait until this chat has done both checks.
    if (GATED.has(toolName)) {
      const missing = missingChecks(chatId, instanceId ? instances.get(instanceId)?.status === 'active' : false);
      if (missing.length) return deny(gateMessage(missing));
    }
    // The plan is the user's call, enforced here and not only in the chat: no writing, building or installing an app
    // until they've clicked Approve plan on exactly this plan.
    if (PLAN_GATED.has(toolName)) {
      const app = apps.get(String(input.app_id ?? '')) ?? apps.byScope(String(input.app_id ?? ''));
      if (app && app.plan_approved !== specHash(app.spec))
        return deny(`The plan for ${app.name} ${app.plan_approved ? 'changed after it was approved' : 'is not approved yet'}. Stop and ask the user to click Approve plan on the plan card; continue when they have.`);
    }
    if (toolName.startsWith('mcp__build__')) {
      if (!BUILD_WRITE_TOOLS.has(toolName)) return allow();
      // Turning on ATF changes one system property on the instance (it isn't about any app): its own card, and it
      // asks in chat auto mode too (full permissions can auto-approve it). The tool takes no arguments, so it runs with none: nothing unshown rides along.
      if (toolName === 'mcp__build__enable_atf') {
        const inst = instanceId ? instances.get(instanceId) : undefined;
        let from = 'not set';
        if (inst) { try { const [p] = await table_(inst, 'sys_properties', 'name=sn_atf.runner.enabled', 'value', 1); if (p) from = String(p.value); } catch { from = 'unknown'; } }
        return ask(toolName, {}, signal, { kind: 'property', property: 'sn_atf.runner.enabled', from, to: 'true', why: 'Lets the app\'s automated tests run on the instance.' });
      }
      const app = apps.get(String(input.app_id ?? '')) ?? apps.byScope(String(input.app_id ?? ''));
      if (!app) return deny('No such app.');
      const spec = readSpec(app);
      const shown = { app: app.name, scope: app.scope, summary: spec?.summary, tables: spec?.tables.map((t) => t.name) };
      if (toolName === 'mcp__build__remove_app') return ask(toolName, input, signal, shown);
      // After an install the user approved, running that app's own tests is part of validating it (nobody is watching
      // the background check live, so a card would just time out). Anything else in that run still asks.
      if (toolName === 'mcp__build__run_app_tests' && opts.followup && app.status === 'installed') return auto(toolName, input, { ...shown, why: 'post-install validation' });
      if (toolName === 'mcp__build__run_app_tests') return autoAllowed(app) ? auto(toolName, input, shown) : ask(toolName, input, signal, shown);
      // An install approval covers one exact build: the card names it and the tool gets it, so later edits can't ride along.
      const { commit, clean } = await buildState(app);
      if (!commit || !clean || app.status !== 'built') return deny('There are changes since the last good build. Run build_app first, then ask to install again.');
      const preview = await installPreview(app, commit);
      const { commit: _ignored, ...rest } = input;
      // Credentials belong only to the trusted uploader; the warning still describes the preceding build.
      const card = { ...shown, build: commit.slice(0, 7), changes: preview.changes, risks: preview.risks,
        install_gets: 'only the built package; your instance sign-in stays in the trusted uploader',
        ...(SANDBOX ? {} : { sandbox: 'off: the build ran with the Wayfinder user\'s file access' }) };
      // Chat auto mode never covers a flagged install; full permissions still records the scan and exact build.
      if (autoAllowed(app) && !preview.risks.length) return auto(toolName, { ...rest, commit }, card);
      return ask(toolName, { ...rest, commit }, signal, card);
    }
    // A note in the update set: the card shows the exact text and the set it goes to, both read and built here and
    // bound to the call, so the tool can't write anything else or anywhere else. Chat auto mode still asks.
    if (toolName === 'mcp__pdi__note_update_set') {
      const inst = instanceId ? instances.get(instanceId) : undefined;
      const set = inst ? await currentUpdateSet(inst) : null;
      if (!set) return deny('No named update set is current for this account (Default or none), so there is nothing to note. Skip it.');
      const changed = Array.isArray(input.changed) ? input.changed.map(String) : [];
      const note = noteText({ changed, why: String(input.why ?? ''), risk: String(input.risk ?? '') }, new Date(), [parseAccess(inst!)?.user].find((u) => u && u !== 'unknown'));
      return ask(toolName, { changed, why: input.why, risk: input.risk, sys_id: set.sys_id, note }, signal, { kind: 'update-set-note', update_set: set.name, note });
    }
    if (toolName.startsWith('mcp__pdi__')) return PDI_WRITE_TOOLS.has(toolName) ? ask(toolName, input, signal) : allow();
    if (toolName.startsWith('mcp__instance__')) {
      const name = instanceName(toolName);
      const target = String(input.table ?? '').trim().toLowerCase();
      if (CREDENTIAL_TABLES.has(target)) return deny(`${target} holds credentials, so Wayfinder doesn't access it. Read the records that use them instead.`);
      if (instanceIsRead(toolName)) return allow();
      if (!INSTANCE_WRITES.has(name)) return deny(`${toolName} is not available in Wayfinder. Use pdi placement to switch update sets.`);
      const s = settings.get();
      if (!s.writeEnabled) return deny('Instance writes are off in Settings.');
      if (name === 'run_script' && !s.scriptingEnabled) return deny('Server-side scripting is off in Settings.');
      // Runner maintenance has a fixed global scope, like enable_atf; scripts themselves still need placement.
      if (name === 'setup_script_runner' || name === 'remove_script_runner') {
        const inst = instanceId ? instances.get(instanceId) : undefined;
        if (!inst || inst.status !== 'active') return deny('Connect an active instance first.');
        if (name === 'remove_script_runner' && !inst.script_runner_records) return deny('No saved script runner records to remove.');
        return ask(toolName, name === 'remove_script_runner' ? { records: inst.script_runner_records } : {}, signal,
          runnerCard(name === 'setup_script_runner' ? 'setup' : 'remove', inst));
      }
      // Settle where the work lives before any record or script change.
      const blocked = await writeGate(chatId, instanceId ? instances.get(instanceId) : undefined);
      if (blocked) return deny(blocked);
      const exact = structuredClone(input);
      return ask(toolName, exact, signal, await describeChange(toolName, exact, instanceId, chatId));
    }
    return deny(`${toolName} is not available in Wayfinder.`);
  };
  // An allowed instance write holds the instance until its result comes back (agent.ts releases it), so writes from
  // parallel chats take turns; a record or script change first puts this chat's own update set and app back.
  return async (toolName, input, ctx) => {
    const before = instanceId ? instances.get(instanceId) : undefined;
    const result = await decideCall(toolName, input, ctx);
    const instanceWrite = toolName.startsWith('mcp__instance__') && !instanceIsRead(toolName);
    if (result?.behavior !== 'allow' || !instanceId || !(instanceWrite || PDI_WRITE_TOOLS.has(toolName) || BUILD_WRITE_TOOLS.has(toolName))) return result;
    const refuse = (message: string): PermissionResult => {
      audit.add(chatId, instanceId, toolName, input, `refused: ${message.slice(0, 300)}`, ctx.toolUseID ?? null);
      return { behavior: 'deny', message };
    };
    let release: () => void;
    try { release = await lockInstance(instanceId, chatId, ctx.signal); } catch { return refuse(`Stopped while waiting for another chat's change to finish, so ${toolName} did not run.`); }
    const inst = instances.get(instanceId);
    if (fullPermissions(before) && (!fullPermissions(inst) || inst?.url !== before?.url || !settings.get().writeEnabled || ctx.signal.aborted)) {
      release();
      return refuse('Full permissions or the instance changed while this call was waiting, so it did not run.');
    }
    // Maintenance reacquires its own exclusive hold through the Global switch and restoration.
    const maintenance = toolName === 'mcp__instance__setup_script_runner' || toolName === 'mcp__instance__remove_script_runner';
    if (maintenance) { release(); return result; }
    const off = instanceWrite && inst ? await ensurePlace(chatId, inst) : null;
    if (off) { release(); return refuse(off); }
    if (ctx.toolUseID) holdFor(ctx.toolUseID, chatId, release); else release();
    return result;
  };
}
