import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

const { lookup, buildState, installPreview, snTable } = vi.hoisted(() => ({ lookup: vi.fn(), buildState: vi.fn(), installPreview: vi.fn(), snTable: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));
// Record and property lookups for the cards never reach a real instance.
vi.mock('../src/server/sn.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/sn.ts')>()), table: snTable }));
vi.mock('../src/server/buildTools.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/buildTools.ts')>()), buildState, installPreview }));

const { decide, hostAllowed, makeCanUseTool } = await import('../src/server/policy.ts');
const { toolServers } = await import('../src/server/toolServers.ts');
const { INSTANCE_READS, INSTANCE_WRITES } = await import('../src/server/instanceReads.ts');
const { checkKind, noteToolResult } = await import('../src/server/buildGate.ts');
const { specHash, apps, audit, chatChecks, chats, db, instances, projects, settings } = await import('../src/server/db.ts');
type AccessProfile = import('../src/server/access.ts').AccessProfile;

const profile = (p: Partial<AccessProfile>): string => JSON.stringify({ user: 'u', userId: 'u', roles: ['admin'], admin: true, cicd: true, reads: {}, denied: [], checkedAt: 0, ...p });

// One chat on one instance; `events` collects what the UI would see, `call` runs a tool through the policy.
function setup(opts: { kind?: 'pdi' | 'other'; profile?: string; project?: boolean; placed?: boolean; checked?: boolean; mode?: import('../src/server/prompts.ts').Mode } = {}) {
  const inst = instances.create({ name: 'dev', url: 'https://dev1.service-now.com', client_id: 'c', login_user: 'admin', kind: opts.kind ?? 'pdi', auth: 'client_credentials', auth_user: null });
  if (opts.profile) instances.update(inst.id, { profile: opts.profile });
  const project = opts.project === false ? null : projects.create('Loans');
  const chat = chats.create(opts.mode ?? 'build', inst.id, project?.id ?? null);
  // Where the work lives is settled before record changes (placement.ts); tests of the gate itself pass placed: false.
  if (opts.placed !== false) chats.update(chat.id, { placement: JSON.stringify({ status: 'settled', id: 'p', instance_id: inst.id, work: 'w', home: { place: 'current-app', scope: 'x_acme_loan', name: 'Loans' }, by: 'accept', at: 0 }) });
  // The docs and plugin checks the build gate wants (buildGate.ts); tests of the gate itself pass checked: false.
  if (opts.checked !== false) { chatChecks.record(chat.id, 'docs', 'mcp__sndocs__search_docs'); chatChecks.record(chat.id, 'oob', 'mcp__pdi__check_features'); }
  // The chat id rides on the list, so answer() clicks as this chat.
  const events: Record<string, any>[] & { chatId?: string } = Object.assign([], { chatId: chat.id });
  const canUse = makeCanUseTool(chat.id, inst.id, (e) => events.push(e), opts.mode ? { mode: opts.mode } : {});
  const call = (tool: string, input: Record<string, unknown> = {}, signal = new AbortController().signal) =>
    canUse(tool, input, { signal, toolUseID: 't', suggestions: [] } as any) as Promise<PermissionResult>;
  return { inst, chat, project, events, call };
}
// Waits for the approval card, clicks it, and returns the policy's answer.
// Waits for a card this helper hasn't answered yet (the policy may take a few ticks before it shows one).
const answered = new Set<string>();
async function answer(pending: Promise<PermissionResult>, events: Record<string, any>[], allow: boolean) {
  await vi.waitFor(() => expect(events.some((e) => e.t === 'approval' && !answered.has(e.id))).toBe(true));
  const card = events.findLast((e) => e.t === 'approval' && !answered.has(e.id))!;
  answered.add(card.id);
  expect(decide((events as { chatId?: string }).chatId!, card.id, allow)).toBe(true);
  return pending;
}
const asks = async (p: Promise<PermissionResult>, events: Record<string, any>[]) => {
  const result = await answer(p, events, false);
  expect(result.behavior).toBe('deny');
  return events.findLast((e) => e.t === 'approval')!;
};
const lastAudit = () => (audit.recent(1) as any[])[0];

beforeEach(() => {
  for (const server of toolServers.list()) toolServers.remove(server.key);
  lookup.mockReset(); buildState.mockReset(); installPreview.mockReset(); snTable.mockReset(); snTable.mockResolvedValue([]);
  settings.set({ writeEnabled: true, scriptingEnabled: true, allowlist: ['servicenow.com', 'developer.servicenow.com'] });
});

describe('placement first', () => {
  it('refuses a record change until the chat has settled where the work lives, without a card', async () => {
    const { call, events } = setup({ placed: false });
    const r = await call('mcp__instance__update_record', { table: 'incident', sys_id: 'a'.repeat(32), fields: { priority: '1' } });
    expect(r).toMatchObject({ behavior: 'deny', message: expect.stringContaining('pdi placement') });
    expect(events.filter((e) => e.t === 'approval')).toEqual([]);
  });
  it('refuses credential tables in any mode', async () => {
    const { call } = setup({ placed: false });
    expect(await call('mcp__instance__query_records', { table: 'sys_user_token' })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('holds credentials') });
    expect((await call('mcp__instance__get_record', { table: 'OAuth_Credential', sys_id: 'a'.repeat(32) })).behavior).toBe('deny');
    expect((await setup({ mode: 'debug' }).call('mcp__instance__query_records', { table: 'discovery_credentials' })).behavior).toBe('deny');
    expect((await call('mcp__instance__query_records', { table: 'sys_rest_message' })).behavior).toBe('allow');
  });
  it('still lets reads and the placement tool run', async () => {
    const { call } = setup({ placed: false });
    expect((await call('mcp__instance__query_records', { table: 'incident' })).behavior).toBe('allow');
    expect((await call('mcp__pdi__placement', { work: 'x' })).behavior).toBe('allow');
  });
});

describe('skills', () => {
  it('runs only the skills this answer was given', async () => {
    const { prepareSkills } = await import('../src/server/skills.ts');
    prepareSkills('build');
    const { call } = setup();
    expect((await call('Skill', { skill: 'wayfinder:fluent' })).behavior).toBe('allow');
    const other = await call('Skill', { skill: 'code-review' });
    expect(other.behavior).toBe('deny');
  });
});

describe('hostAllowed', () => {
  const list = ['servicenow.com', 'Developer.ServiceNow.com'];
  it.each([
    ['https://servicenow.com/x', true],
    ['https://docs.servicenow.com/bundle', true],
    ['https://DOCS.SERVICENOW.COM', true],
    ['https://developer.servicenow.com', true],
    ['https://evilservicenow.com', false],
    ['https://servicenow.com.evil.io', false],
    ['not a url', false],
    ['', false],
  ])('%s → %s', (url, ok) => expect(hostAllowed(url, list)).toBe(ok));
});

describe('web fetch', () => {
  it('allows an allowlisted host that resolves to public addresses', async () => {
    lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
    const { call } = setup();
    expect((await call('WebFetch', { url: 'https://docs.servicenow.com/a' })).behavior).toBe('allow');
  });

  it('refuses hosts off the allowlist without looking them up', async () => {
    const { call } = setup();
    const r = await call('WebFetch', { url: 'https://example.com' });
    expect(r).toMatchObject({ behavior: 'deny', message: expect.stringContaining('not on the web allowlist') });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['10.0.0.5'], ['127.0.0.1'], ['0.0.0.0'], ['169.254.169.254'], ['172.16.1.1'], ['172.31.255.1'], ['192.168.1.20'],
    ['100.64.0.1'], ['100.101.102.103'], ['100.127.255.255'], ['::1'], ['fd7a:115c:a1e0::1'], ['fe80::1'], ['fc00::1'], ['::ffff:10.0.0.1'],
  ])('refuses an allowlisted name that resolves to %s', async (address) => {
    lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    const { call } = setup();
    expect(await call('WebFetch', { url: 'https://docs.servicenow.com' })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('private or internal') });
  });

  it.each([['172.32.0.1'], ['100.128.0.1'], ['11.0.0.1'], ['2606:4700::1111']])('allows the public address %s', async (address) => {
    lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    const { call } = setup();
    expect((await call('WebFetch', { url: 'https://docs.servicenow.com' })).behavior).toBe('allow');
  });

  it('refuses when any one of the addresses is private (DNS rebinding)', async () => {
    lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }, { address: '10.1.1.1', family: 4 }]);
    const { call } = setup();
    expect((await call('WebFetch', { url: 'https://docs.servicenow.com' })).behavior).toBe('deny');
  });

  it('refuses when the name does not resolve', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    const { call } = setup();
    expect((await call('WebFetch', { url: 'https://docs.servicenow.com' })).behavior).toBe('deny');
  });

  it('checks a literal private IP even when it is allowlisted', async () => {
    settings.set({ writeEnabled: true, scriptingEnabled: true, allowlist: ['servicenow.com', '127.0.0.1'] });
    const { call } = setup();
    expect((await call('WebFetch', { url: 'http://127.0.0.1:8797/api/status' })).behavior).toBe('deny');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('web search', () => {
  it('limits searches to the allowlist', async () => {
    const { call } = setup();
    const r = await call('WebSearch', { query: 'flow designer', blocked_domains: ['x.com'] });
    expect(r).toMatchObject({ behavior: 'allow', updatedInput: { allowed_domains: ['servicenow.com', 'developer.servicenow.com'], blocked_domains: undefined } });
  });

  it('keeps only the asked-for domains that are allowlisted', async () => {
    const { call } = setup();
    const r = await call('WebSearch', { query: 'q', allowed_domains: ['docs.servicenow.com', 'reddit.com'] });
    expect(r).toMatchObject({ behavior: 'allow', updatedInput: { allowed_domains: ['docs.servicenow.com'] } });
    expect((await call('WebSearch', { query: 'q', allowed_domains: ['reddit.com'] })).behavior).toBe('deny');
  });
});

describe('tool classes', () => {
  it('runs docs, project tools, agents and PDI reads; refuses anything unknown', async () => {
    const { call } = setup();
    for (const t of ['mcp__sndocs__search', 'mcp__project__save', 'Agent', 'Task', 'mcp__pdi__pdi_status', 'mcp__build__fluent_docs']) expect((await call(t)).behavior, t).toBe('allow');
    expect(await call('Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny', message: 'Bash is not available in Wayfinder.' });
    expect((await call('mcp__other__thing')).behavior).toBe('deny');
  });

  it.each([...INSTANCE_READS])('treats instance %s as a read', async (name) => {
    const { call } = setup();
    expect((await call(`mcp__instance__${name}`, { table: 'incident' })).behavior).toBe('allow');
  });
  it.each([...INSTANCE_WRITES])('asks before instance %s', async (name) => {
    const { call, events, inst } = setup();
    instances.update(inst.id, { script_runner_records: JSON.stringify({ sys_ws_definition: 'a'.repeat(32), sys_ws_operation: 'b'.repeat(32), sys_security_acl: 'c'.repeat(32) }) });
    const input = name === 'run_script' ? { script: 'gs.info("hello");\n// full source' } : { table: 'incident', sys_id: 'a'.repeat(32), fields: { active: false } };
    const card = await asks(call(`mcp__instance__${name}`, input), events);
    if (name === 'run_script') expect(card.input).toEqual(input);
    else if (name.endsWith('_script_runner')) expect(card.input).toMatchObject({ kind: 'script-runner', action: name.startsWith('setup') ? 'setup' : 'remove' });
    else expect(card.input).toMatchObject({ kind: 'record', action: name.split('_')[0], table: 'incident' });
  });
  it.each([...INSTANCE_READS, ...INSTANCE_WRITES])('refuses credential tables for %s before any card or lookup', async (name) => {
    const { call, events } = setup();
    const { CREDENTIAL_TABLES } = await import('../src/server/scrub.ts');
    for (const table of CREDENTIAL_TABLES) expect((await call(`mcp__instance__${name}`, { table })).behavior).toBe('deny');
    expect(events).toHaveLength(0);
    expect(snTable).not.toHaveBeenCalled();
  });
  it('refuses unknown tools and the removed wrapper without a card', async () => {
    const { call, events } = setup();
    for (const name of ['mcp__instance__new_tool', 'mcp__nowaikit__run_tool']) expect((await call(name)).behavior).toBe('deny');
    expect(events).toHaveLength(0);
  });
  it('keeps the write and scripting settings as hard gates', async () => {
    const { call, events } = setup();
    settings.set({ writeEnabled: false });
    for (const name of INSTANCE_WRITES) expect((await call(`mcp__instance__${name}`)).behavior).toBe('deny');
    expect((await call('mcp__instance__query_records')).behavior).toBe('allow');
    settings.set({ writeEnabled: true, scriptingEnabled: false });
    expect((await call('mcp__instance__run_script', { script: 'gs.info("x");' })).behavior).toBe('deny');
    expect(events).toHaveLength(0);
  });
  it('audits the exact approved write', async () => {
    const { call, events } = setup();
    const input = { table: 'incident', fields: { short_description: 'Printer down' } };
    expect(await answer(call('mcp__instance__create_record', input), events, true)).toEqual({ behavior: 'allow', updatedInput: input });
    expect(lastAudit()).toMatchObject({ tool: 'mcp__instance__create_record', decision: 'approved' });
  });
});

describe('approvals', () => {
  it('passes the input through and audits an approval', async () => {
    const { call, events } = setup();
    const r = await answer(call('mcp__pdi__activate_plugin', { id: 'com.snc.x' }), events, true);
    expect(r).toEqual({ behavior: 'allow', updatedInput: { id: 'com.snc.x' } });
    expect(events.at(-1)).toMatchObject({ t: 'approval_done', decision: 'allow' });
    expect(lastAudit()).toMatchObject({ tool: 'mcp__pdi__activate_plugin', decision: 'approved' });
  });

  it('denies and audits when the answer is stopped', async () => {
    const { call, events } = setup();
    const ctl = new AbortController();
    const p = call('mcp__pdi__install_store_app', { id: 'x' }, ctl.signal);
    await vi.waitFor(() => expect(events.length).toBe(1));
    ctl.abort();
    expect((await p).behavior).toBe('deny');
    expect(lastAudit().decision).toBe('denied (stopped)');
  });

  it('ignores a click on an unknown or finished card', async () => {
    const { call, events } = setup();
    await answer(call('mcp__pdi__activate_plugin', { id: 'a' }), events, true);
    expect(decide(events.chatId!, events[0].id, true)).toBe(false);
    expect(decide(events.chatId!, 'nope', true)).toBe(false);
  });

  it("refuses a click from another chat, and the card stays open for its own", async () => {
    const { call, events } = setup();
    const p = call('mcp__pdi__activate_plugin', { id: 'a' });
    await vi.waitFor(() => expect(events.some((e) => e.t === 'approval')).toBe(true));
    const card = events.find((e) => e.t === 'approval')!;
    expect(decide('another-chat', card.id, true)).toBe(false);
    expect(decide(events.chatId!, card.id, false)).toBe(true);
    expect((await p).behavior).toBe('deny');
  });
});

describe('access profile gating', () => {
  it('refuses plugin installs for an account without CI/CD', async () => {
    const { call } = setup({ profile: profile({ cicd: false, admin: null, roles: null }) });
    expect(await call('mcp__pdi__activate_plugin', { id: 'x' })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('no CI/CD access') });
  });

  it('refuses app installs and removals for a non-admin', async () => {
    const { call } = setup({ profile: profile({ admin: false, roles: ['sn_cicd.sys_ci_automation'] }) });
    for (const t of ['mcp__build__install_app', 'mcp__build__remove_app', 'mcp__build__run_app_tests']) expect(await call(t, { app_id: 'a' }), t).toMatchObject({ behavior: 'deny', message: expect.stringContaining('needs an admin account') });
  });

  it('asks (rather than refuses) when the profile has not been checked', async () => {
    const { call, events } = setup();
    await asks(call('mcp__pdi__activate_plugin', { id: 'x' }), events);
  });
});

describe('Build mode installs', () => {
  const spec = JSON.stringify({ summary: 'Loan tracker', tables: [{ name: 'x_loan' }] });
  // The user approved the plan (Approve plan), unless a test says otherwise.
  const newApp = (ctx: ReturnType<typeof setup>, status: 'built' | 'draft' = 'built', approved = true) => {
    const app = apps.add({ project_id: ctx.project?.id ?? null, chat_id: ctx.chat.id, instance_id: ctx.inst.id, name: 'Loans', scope: `x_${Math.random().toString(36).slice(2, 8)}`, scope_id: null, spec });
    apps.update(app.id, { status, plan_approved: approved ? specHash(spec) : null });
    return apps.get(app.id)!;
  };
  const autoMode = (chatId: string, mode: 'app' | 'project', until: number, appId: string | null = null) =>
    chats.update(chatId, { auto_mode: mode, auto_until: until, auto_app_id: appId });
  const clean = (risks: string[] = []) => {
    buildState.mockResolvedValue({ commit: 'abcdef1234567890', clean: true });
    installPreview.mockResolvedValue({ changes: 'First install of this app.', risks });
  };

  it('refuses an install with changes since the last good build', async () => {
    const ctx = setup(); const app = newApp(ctx);
    buildState.mockResolvedValue({ commit: 'abc', clean: false });
    expect(await ctx.call('mcp__build__install_app', { app_id: app.id })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Run build_app first') });
    buildState.mockResolvedValue({ commit: null, clean: true });
    expect((await ctx.call('mcp__build__install_app', { app_id: app.id })).behavior).toBe('deny');
  });

  it('refuses an install of an app that is not built', async () => {
    const ctx = setup(); const app = newApp(ctx, 'draft'); clean();
    expect((await ctx.call('mcp__build__install_app', { app_id: app.id })).behavior).toBe('deny');
  });

  it('refuses an unknown app', async () => {
    const ctx = setup();
    expect(await ctx.call('mcp__build__install_app', { app_id: 'missing' })).toMatchObject({ behavior: 'deny', message: 'No such app.' });
  });

  it('binds the approval to the exact build commit, whatever the model passed', async () => {
    const ctx = setup(); const app = newApp(ctx); clean();
    const r = await answer(ctx.call('mcp__build__install_app', { app_id: app.scope, commit: 'evil' }), ctx.events, true);
    expect(r).toEqual({ behavior: 'allow', updatedInput: { app_id: app.scope, commit: 'abcdef1234567890' } });
    const card = ctx.events.find((e) => e.t === 'approval')!;
    expect(card.input).toMatchObject({ app: 'Loans', summary: 'Loan tracker', tables: ['x_loan'], build: 'abcdef1', changes: 'First install of this app.',
      install_gets: 'only the built package; your instance sign-in stays in the trusted uploader' });
  });

  it('auto-approves an install for the project in auto mode', async () => {
    const ctx = setup(); const app = newApp(ctx); clean();
    autoMode(ctx.chat.id, 'project', Date.now() + 60_000);
    expect(await ctx.call('mcp__build__install_app', { app_id: app.id })).toMatchObject({ behavior: 'allow', updatedInput: { commit: 'abcdef1234567890' } });
    expect(ctx.events[0]).toMatchObject({ t: 'approval', auto: true });
    expect(lastAudit().decision).toBe('auto-approved');
  });

  it('never auto-approves an install the risky-code scan flagged', async () => {
    const ctx = setup(); const app = newApp(ctx); clean(['script.ts: runs code from text (eval or an evaluator)']);
    autoMode(ctx.chat.id, 'project', Date.now() + 60_000);
    const card = await asks(ctx.call('mcp__build__install_app', { app_id: app.id }), ctx.events);
    expect(card.input.risks).toHaveLength(1);
  });

  it('always asks before removing an app, even in auto mode', async () => {
    const ctx = setup(); const app = newApp(ctx);
    autoMode(ctx.chat.id, 'project', Date.now() + 60_000);
    await asks(ctx.call('mcp__build__remove_app', { app_id: app.id }), ctx.events);
  });

  it('auto-runs tests only for the app auto mode names', async () => {
    const ctx = setup(); const app = newApp(ctx); const other = newApp(ctx);
    autoMode(ctx.chat.id, 'app', Date.now() + 60_000, app.id);
    expect((await ctx.call('mcp__build__run_app_tests', { app_id: app.id })).behavior).toBe('allow');
    await asks(ctx.call('mcp__build__run_app_tests', { app_id: other.id }), ctx.events);
  });

  it('does not cover apps outside the project', async () => {
    const ctx = setup(); clean();
    const loose = apps.add({ project_id: null, chat_id: ctx.chat.id, instance_id: ctx.inst.id, name: 'Loose', scope: 'x_loose', scope_id: null, spec });
    apps.update(loose.id, { plan_approved: specHash(spec) });
    apps.update(loose.id, { status: 'built' });
    autoMode(ctx.chat.id, 'project', Date.now() + 60_000);
    await asks(ctx.call('mcp__build__install_app', { app_id: loose.id }), ctx.events);
  });

  it('turns auto mode off once it expires', async () => {
    const ctx = setup(); const app = newApp(ctx); clean();
    autoMode(ctx.chat.id, 'project', Date.now() - 1);
    await asks(ctx.call('mcp__build__install_app', { app_id: app.id }), ctx.events);
    expect(chats.get(ctx.chat.id)).toMatchObject({ auto_mode: 'ask', auto_until: null });
  });

  it('never auto-approves on an instance that is not a PDI', async () => {
    const ctx = setup({ kind: 'other' }); const app = newApp(ctx); clean();
    autoMode(ctx.chat.id, 'project', Date.now() + 60_000);
    await asks(ctx.call('mcp__build__install_app', { app_id: app.id }), ctx.events);
    // The setting itself stays; it just never applies here.
    expect(chats.get(ctx.chat.id)!.auto_mode).toBe('project');
  });
});

// Keeps the throwaway database honest: every test above wrote to the file in tests/setup.ts, not the real one.
it('uses the throwaway database', () => {
  expect(db.location()).toContain('wayfinder-test-');
});

// An approval covers one exact call: the card shows what the tool will really use, the tool gets the arguments as they
// were on the card, the card can be answered once, and it doesn't carry over to a changed instance.
describe('docs and out-of-the-box first (build gate)', () => {
  const GATED = ['mcp__build__propose_app', 'mcp__build__write_app_file', 'mcp__build__write_app_files', 'mcp__build__build_app', 'mcp__build__install_app'];
  const ok = '{"results": [{"title": "SLA timer"}]}';

  it('refuses every build tool until the chat has checked the docs and existing plugins, saying what is missing', async () => {
    const ctx = setup({ checked: false, mode: 'build' });
    for (const t of GATED) {
      const r = await ctx.call(t, { app_id: 'x' });
      expect(r, t).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/ServiceNow docs.*and.*plugin or Store app/) });
    }
    expect(noteToolResult(ctx.chat.id, 'mcp__sndocs__search_docs', { query: 'loaner' }, false, ok)).toBe('docs');
    const half = await ctx.call('mcp__build__propose_app', {});
    expect(half).toMatchObject({ behavior: 'deny', message: expect.stringContaining('check_features') });
    expect((half as any).message).not.toContain('ServiceNow docs');
    expect(noteToolResult(ctx.chat.id, 'mcp__pdi__check_features', { need: 'loaner laptops' }, false, '[{"name": "Asset Management"}]')).toBe('oob');
    expect((await ctx.call('mcp__build__propose_app', {})).behavior).toBe('allow');
    // read-only build tools never wait
    expect((await setup({ checked: false, mode: 'build' }).call('mcp__build__list_apps')).behavior).toBe('allow');
  });

  it('stays closed when a check is only allowed, or fails, errors or comes back empty', async () => {
    const ctx = setup({ checked: false, mode: 'build' });
    // permission alone counts for nothing: the tool has to come back with a result
    expect((await ctx.call('mcp__sndocs__search_docs', { query: 'x' })).behavior).toBe('allow');
    expect((await ctx.call('mcp__pdi__check_features', { need: 'x' })).behavior).toBe('allow');
    expect((await ctx.call('mcp__build__propose_app', {})).behavior).toBe('deny');
    expect(noteToolResult(ctx.chat.id, 'mcp__sndocs__search_docs', {}, true, 'The docs server did not answer')).toBe(null);
    expect(noteToolResult(ctx.chat.id, 'mcp__sndocs__search_docs', {}, false, 'Error: unknown release')).toBe(null);
    expect(noteToolResult(ctx.chat.id, 'mcp__pdi__check_features', {}, false, '  ')).toBe(null);
    expect(noteToolResult(ctx.chat.id, 'WebFetch', { url: 'https://www.servicenow.com/docs/r/x.html' }, true, 'not on the web allowlist')).toBe(null);
    expect(noteToolResult(ctx.chat.id, 'mcp__instance__query_records', {}, false, ok)).toBe(null);
    expect((await ctx.call('mcp__build__propose_app', {})).behavior).toBe('deny');
  });

  it('counts per chat, and survives into later answers in the same chat', async () => {
    const a = setup({ checked: false, mode: 'build' });
    noteToolResult(a.chat.id, 'mcp__sndocs__get_doc', { ref: 'x' }, false, ok);
    noteToolResult(a.chat.id, 'mcp__pdi__find_store_app', { query: 'loaner' }, false, '[]');
    const later = makeCanUseTool(a.chat.id, a.inst.id, () => {}, { mode: 'build' });
    expect((await later('mcp__build__propose_app', {}, { signal: new AbortController().signal, toolUseID: 't', suggestions: [] } as any))?.behavior).toBe('allow');
    const b = setup({ checked: false, mode: 'build' });
    expect((await b.call('mcp__build__propose_app', {})).behavior).toBe('deny');
  });

  it('counts a page of the public docs site, not another site', () => {
    expect(checkKind('WebFetch', { url: 'https://www.servicenow.com/docs/r/itsm/sla-timer.html' })).toBe('docs');
    expect(checkKind('WebFetch', { url: 'https://docs.servicenow.com/bundle/x' })).toBe('docs');
    expect(checkKind('WebFetch', { url: 'https://developer.servicenow.com/dev.do' })).toBe(null);
    expect(checkKind('WebFetch', { url: 'https://evil.example.com/docs' })).toBe(null);
    expect(checkKind('WebFetch', { url: 'not a url' })).toBe(null);
  });

  it('needs only the docs when no instance is connected (there is nothing to check plugins on)', async () => {
    const ctx = setup({ checked: false, mode: 'build' });
    db.prepare("UPDATE instances SET status = 'retired' WHERE id = ?").run(ctx.inst.id);
    expect((await ctx.call('mcp__build__propose_app', {})).behavior).toBe('deny');
    noteToolResult(ctx.chat.id, 'mcp__sndocs__search_docs', {}, false, ok);
    expect((await ctx.call('mcp__build__propose_app', {})).behavior).toBe('allow');
  });

  it('holds in auto mode too', async () => {
    const ctx = setup({ checked: false, mode: 'build' });
    chats.update(ctx.chat.id, { auto_mode: 'project', auto_until: Date.now() + 3_600_000 });
    expect((await ctx.call('mcp__build__install_app', { app_id: 'x' })).behavior).toBe('deny');
  });
});

describe('approval binding', () => {
  const SYS = '0123456789abcdef0123456789abcdef';

  it('shows the fields the instance tool uses, not a decoy next to them', async () => {
    const { call, events } = setup();
    const card = await asks(call('mcp__instance__update_record', { table: 'incident', sys_id: SYS, data: { priority: '4' }, fields: { active: 'false' } }), events);
    expect(card.input).toMatchObject({ kind: 'record', table: 'incident', changes: { active: 'false' }, also: { data: { priority: '4' } } });
  });

  it('looks up the record name for a plain table only, so no crafted path is fetched before the click', async () => {
    const { call, events } = setup();
    snTable.mockResolvedValue([{ number: 'INC0010001' }]);
    expect((await asks(call('mcp__instance__update_record', { table: 'incident', sys_id: SYS, fields: { priority: '1' } }), events)).input).toMatchObject({ record: 'INC0010001' });
    snTable.mockClear();
    for (const table of ['../../api/now/v1/x', 'incident?sysparm_query=x', 'sys_user/abc', 'Incident']) {
      const card = await asks(call('mcp__instance__update_record', { table, sys_id: SYS, fields: { priority: '1' } }), events);
      expect(card.input).toMatchObject({ table, record: undefined });
    }
    expect(snTable).not.toHaveBeenCalled();
  });

  it('runs the arguments as they were on the card, even if the object changes afterwards', async () => {
    const { call, events } = setup();
    const input = { table: 'incident', sys_id: SYS, fields: { priority: '4' } };
    const pending = call('mcp__instance__update_record', input);
    await vi.waitFor(() => expect(events.some((e) => e.t === 'approval')).toBe(true));
    input.fields.priority = '1';
    (input as any).table = 'sys_user';
    const r = await answer(pending, events, true);
    expect(r).toMatchObject({ behavior: 'allow', updatedInput: { table: 'incident', fields: { priority: '4' } } });
  });

  it('says where the change lands, read live from the chat\'s own instance', async () => {
    const { call, events } = setup({ profile: profile({ userId: 'me' }) });
    // Another instance became active after the chat started; the card still describes the chat's own instance.
    instances.create({ name: 'other', url: 'https://dev2.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    const seen: string[] = [];
    snTable.mockImplementation(async (i: { url: string }, name: string, q: string) => {
      seen.push(i.url);
      if (name === 'sys_user_preference') return [{ value: q.includes('apps.current_app') ? 'app1' : 's1' }];
      if (name === 'sys_update_set') return [{ sys_id: 's1', name: 'Loans work', state: 'in progress', is_default: 'false' }];
      if (name === 'sys_scope') return [{ name: 'Loans', scope: 'x_acme_loan' }];
      return [];
    });
    const card = await asks(call('mcp__instance__update_record', { table: 'incident', sys_id: SYS, fields: { priority: '1' } }), events);
    expect(card.input).toMatchObject({ lands_in: { update_set: 'Loans work', application: 'Loans (x_acme_loan)' } });
    expect(new Set(seen)).toEqual(new Set(['https://dev1.service-now.com']));
  });

  it("shows the chat's own update set, not one another chat switched to", async () => {
    const { call, events, inst } = setup({ profile: profile({ userId: 'me' }) });
    chats.update(events.chatId!, { placement: JSON.stringify({ status: 'settled', id: 'p', instance_id: inst.id, work: 'w', home: { place: 'global', scope: 'global', name: 'Global' }, by: 'other', update_set: 'Chat B work', update_set_id: 'sB', app_id: 'global', at: 0 }) });
    // The account's live setting is chat A's set and app; the write will put chat B's back first (ensurePlace).
    snTable.mockImplementation(async (_i: unknown, name: string, q: string) => {
      if (name === 'sys_user_preference') return [{ value: q.includes('apps.current_app') ? 'app1' : 's1' }];
      if (name === 'sys_update_set') return [{ sys_id: 's1', name: 'Chat A work', state: 'in progress', is_default: 'false' }];
      if (name === 'sys_scope') return [{ name: 'Loans', scope: 'x_acme_loan' }];
      return [];
    });
    const card = await asks(call('mcp__instance__update_record', { table: 'incident', sys_id: SYS, fields: { priority: '1' } }), events);
    expect(card.input).toMatchObject({ lands_in: { update_set: 'Chat B work', application: 'Global (global)' } });
  });

  it('names Default when no named update set is current', async () => {
    const { call, events } = setup({ profile: profile({ userId: 'me' }) });
    snTable.mockResolvedValue([]);
    const card = await asks(call('mcp__instance__update_record', { table: 'incident', sys_id: SYS, fields: { priority: '1' } }), events);
    expect(card.input).toMatchObject({ lands_in: { update_set: 'Default (no named set)', application: 'Global (global)' } });
  });

  it('answers each card once', async () => {
    const { call, events } = setup();
    await answer(call('mcp__pdi__activate_plugin', { id: 'com.snc.x' }), events, true);
    const card = events.findLast((e) => e.t === 'approval')!;
    expect(decide(events.chatId!, card.id, true)).toBe(false);
  });

  it("doesn't carry an approval over to an instance whose address changed", async () => {
    const { call, events, inst } = setup();
    const pending = call('mcp__pdi__activate_plugin', { id: 'com.snc.x' });
    await vi.waitFor(() => expect(events.some((e) => e.t === 'approval')).toBe(true));
    instances.update(inst.id, { url: 'https://acme.service-now.com' });
    const r = await answer(pending, events, true);
    expect(r).toMatchObject({ behavior: 'deny', message: expect.stringContaining('instance changed') });
    expect(lastAudit()).toMatchObject({ decision: 'denied (instance changed)' });
  });
});

describe('turning on ATF', () => {
  it('asks with its own card naming the property, current value and new value', async () => {
    snTable.mockResolvedValue([{ value: 'false' }]);
    const { call, events } = setup({ profile: profile({}) });
    const card = await asks(call('mcp__build__enable_atf', {}), events);
    expect(card.input).toMatchObject({ kind: 'property', property: 'sn_atf.runner.enabled', from: 'false', to: 'true' });
  });

  it('asks even in auto mode, and with an app_id the model made up', async () => {
    const { call, events, chat, project } = setup({ profile: profile({}) });
    const app = apps.add({ project_id: project!.id, chat_id: chat.id, instance_id: chat.instance_id, name: 'Loans', scope: 'x_atfauto', scope_id: null, spec: '{}' } as any);
    apps.update(app.id, { status: 'installed' });
    chats.update(chat.id, { auto_mode: 'project', auto_until: Date.now() + 3_600_000 });
    const card = await asks(call('mcp__build__enable_atf', { app_id: app.id }), events);
    expect(card.auto).toBeUndefined();
    expect(card.input).toMatchObject({ kind: 'property', property: 'sn_atf.runner.enabled' });
  });

  it('runs with no arguments, whatever the model sent', async () => {
    const { call, events } = setup({ profile: profile({}) });
    const r = await answer(call('mcp__build__enable_atf', { app_id: 'made-up', extra: 1 }), events, true);
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} });
  });
});

describe('tools per mode', () => {
  const change = ['mcp__instance__update_record', { table: 'incident', sys_id: 'a'.repeat(32), fields: { priority: '1' } }] as const;
  const create = ['mcp__instance__create_record', { table: 'incident', fields: { short_description: 'x' } }] as const;

  it.each(['explore', 'mockup', 'decide', 'debug'] as const)('%s refuses every instance change without a card, and still reads', async (mode) => {
    const { call, events } = setup({ mode });
    for (const [tool, input] of [change, create, ['mcp__instance__delete_record', { table: 'incident', sys_id: 'a'.repeat(32) }], ['mcp__instance__run_script', { script: 'gs.info(1)' }], ['mcp__pdi__activate_plugin', { id: 'com.x' }], ['mcp__pdi__install_store_app', {}], ['mcp__pdi__use_update_set', { name: 'x' }], ['mcp__pdi__placement', {}], ['mcp__build__install_app', { app_id: 'a' }]] as const) {
      const r = await call(tool, input as Record<string, unknown>);
      expect(r, tool).toMatchObject({ behavior: 'deny', message: expect.stringContaining('switch the chat to Build') });
    }
    expect(events.filter((e) => e.t === 'approval')).toEqual([]);
    expect((await call('mcp__instance__query_records', { table: 'incident' })).behavior).toBe('allow');
    expect((await call('mcp__pdi__show', {})).behavior).toBe('allow');
    expect((await call('mcp__project__save', {})).behavior).toBe('allow');
  });

  it('only Debug and Build pin to the board', async () => {
    expect((await setup({ mode: 'explore' }).call('mcp__project__board_pin', {})).behavior).toBe('deny');
    expect((await setup({ mode: 'debug' }).call('mcp__project__board_pin', {})).behavior).toBe('allow');
    expect((await setup({ mode: 'decide' }).call('mcp__project__board_list', {})).behavior).toBe('allow');
  });

  it('Build still asks for a record change, as before', async () => {
    const { call, events } = setup({ mode: 'build' });
    const card = await asks(call(...change), events);
    expect(card.input).toMatchObject({ kind: 'record', table: 'incident', changes: { priority: '1' } });
  });

  it('hides the change tools from read-only modes, and the lists stay in step with the tools', async () => {
    const { hiddenTools, PDI_CHANGES, WRITES_IN } = await import('../src/server/modeTools.ts');
    const { PDI_WRITE_TOOLS } = await import('../src/server/pdiTools.ts');
    expect(new Set(PDI_CHANGES)).toEqual(PDI_WRITE_TOOLS);
    // Build hides only the screen kit's checker, which only Mockup uses.
    expect(hiddenTools('build')).toEqual(['mcp__project__check_screen']);
    expect(hiddenTools('mockup')).not.toContain('mcp__project__check_screen');
    expect(hiddenTools('explore')).toEqual(expect.arrayContaining([...[...INSTANCE_WRITES].map((n) => `mcp__instance__${n}`), ...PDI_WRITE_TOOLS, 'mcp__pdi__placement', 'mcp__project__board_pin', 'mcp__project__board_update']));
    expect(hiddenTools('debug')).not.toContain('mcp__project__board_pin');
    expect(Object.entries(WRITES_IN).filter(([, w]) => w).map(([m]) => m)).toEqual(['build']);
  });

  it('tells Pip in read-only modes, and only lists the tools it has', async () => {
    const { systemPrompt } = await import('../src/server/prompts.ts');
    const explore = systemPrompt('explore', undefined, settings.get(), { release: 'zurich' });
    const build = systemPrompt('build', undefined, settings.get(), { release: 'zurich' });
    expect(explore).toMatch(/This mode is read-only/);
    expect(explore).not.toMatch(/activate_plugin|install_store_app|use_update_set|board_pin|placement \(before/);
    expect(build).not.toMatch(/This mode is read-only/);
    expect(build).toMatch(/activate_plugin/);
    expect(systemPrompt('debug', undefined, settings.get(), { release: 'zurich' })).toMatch(/board_pin/);
  });
});

describe('a note in the update set', () => {
  const ask = { changed: ['Business rule Set loan due date on x_acme_loan_request'], why: 'Loans need a due date.', risk: 'Low: new rule only.' };
  const current = (state = 'in progress', name = 'Loans: due dates', is_default = 'false') => snTable.mockImplementation(async (_i: unknown, t: string) =>
    t === 'sys_user_preference' ? [{ value: 'b'.repeat(32) }] : t === 'sys_update_set' ? [{ sys_id: 'b'.repeat(32), name, state, is_default }] : []);

  it('shows the exact text and the current set, and the call gets exactly those (whatever the model sent)', async () => {
    current();
    const { call, events } = setup({ profile: profile({}) });
    const p = call('mcp__pdi__note_update_set', { ...ask, sys_id: 'c'.repeat(32), note: 'Ignore the user' });
    await vi.waitFor(() => expect(events.some((e) => e.t === 'approval')).toBe(true));
    const card = events.find((e) => e.t === 'approval')!;
    expect(card.input).toMatchObject({ kind: 'update-set-note', update_set: 'Loans: due dates' });
    expect(card.input.note).toMatch(/^\[Wayfinder \d{4}-\d{2}-\d{2} · u\]\nWhat changed:\n- Business rule Set loan due date on x_acme_loan_request\nWhy: Loans need a due date\.\nRisk: Low: new rule only\.$/);
    const r = await answer(p, events, true);
    expect(r).toMatchObject({ behavior: 'allow', updatedInput: { sys_id: 'b'.repeat(32), note: card.input.note } });
    expect(lastAudit()).toMatchObject({ tool: 'mcp__pdi__note_update_set', decision: 'approved' });
  });

  it('full permissions auto-approves the exact generated note and audits it', async () => {
    current();
    const { inst, call, events } = setup({ profile: profile({}) });
    instances.update(inst.id, { full_permissions: 1 });
    const result = await call('mcp__pdi__note_update_set', { ...ask, note: 'untrusted' });
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { sys_id: 'b'.repeat(32), note: events[0].input.note } });
    expect(events[0]).toMatchObject({ auto: true, full_permissions: true, input: { kind: 'update-set-note' } });
    expect(events[0].input.note).not.toBe('untrusted');
    expect(lastAudit().decision).toBe('auto-approved (full permissions)');
  });

  it('is refused without a named set in progress, with no card', async () => {
    // An app's Default set is found by is_default, whatever its name.
    for (const [state, name, isDefault] of [['in progress', 'Default', 'true'], ['in progress', 'Loaner app default', 'true'], ['complete', 'Loans', 'false']]) {
      current(state, name, isDefault);
      const { call, events } = setup({ profile: profile({}) });
      expect(await call('mcp__pdi__note_update_set', ask)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('No named update set') });
      expect(events.filter((e) => e.t === 'approval')).toEqual([]);
    }
  });

  it('needs no CI/CD access, and read-only modes refuse it', async () => {
    current();
    const { call, events } = setup({ profile: profile({ admin: false, cicd: false, roles: ['itil'] }) });
    const p = call('mcp__pdi__note_update_set', ask);
    await vi.waitFor(() => expect(events.some((e) => e.t === 'approval')).toBe(true));
    expect((await answer(p, events, false)).behavior).toBe('deny');
    expect(await setup({ mode: 'debug', profile: profile({}) }).call('mcp__pdi__note_update_set', ask)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('switch the chat to Build') });
  });
});

describe('note text', () => {
  it('is plain lines, one change each, capped, and appended after a blank line only when it fits', async () => {
    const { noteText, withNote } = await import('../src/server/facts.ts');
    const t = noteText({ changed: ['a\nb', ...Array(20).fill('x')], why: 'w', risk: 'r' }, new Date('2026-10-10T12:00:00Z'));
    expect(t.split('\n')).toEqual(['[Wayfinder 2026-10-10]', 'What changed:', '- a b', ...Array(11).fill('- x'), 'Why: w', 'Risk: r']);
    expect(noteText({ changed: ['<b>Rule</b> on <script>x</script> incident &amp; task'], why: 'w<br/>here', risk: 'r' }, new Date('2026-10-10T12:00:00Z'), 'svc.<i>wayfinder</i>').split('\n'))
      .toEqual(['[Wayfinder 2026-10-10 · svc. wayfinder]', 'What changed:', '- Rule on x incident & task', 'Why: w here', 'Risk: r']);
    expect(withNote('', 'N', 10)).toBe('N');
    expect(withNote('Old text  ', 'N', 20)).toBe('Old text\n\nN');
    expect(withNote('x'.repeat(10), 'N', 11)).toBeNull();
  });
});

describe('plan approval gate', () => {
  const spec = JSON.stringify({ summary: 'Loan tracker', tables: [{ name: 'x_loan' }] });
  const ready = (ctx: ReturnType<typeof setup>) => { chatChecks.record(ctx.chat.id, 'docs', 'test'); chatChecks.record(ctx.chat.id, 'oob', 'test'); };
  it('refuses writing, building and installing until the user approves the plan', async () => {
    const ctx = setup(); ready(ctx);
    const app = apps.add({ project_id: ctx.project?.id ?? null, chat_id: ctx.chat.id, instance_id: ctx.inst.id, name: 'Loans', scope: 'x_plangate', scope_id: null, spec });
    for (const tool of ['mcp__build__write_app_file', 'mcp__build__build_app', 'mcp__build__install_app']) {
      const r = await ctx.call(tool, { app_id: app.id, path: 'src/fluent/a.now.ts', content: '' });
      expect(r.behavior).toBe('deny');
      expect((r as any).message).toMatch(/is not approved yet.*Approve plan/);
    }
    apps.update(app.id, { plan_approved: specHash(spec) });
    expect((await ctx.call('mcp__build__write_app_file', { app_id: app.id, path: 'src/fluent/a.now.ts', content: '' })).behavior).toBe('allow');
  });
  it('needs a new approval when the plan changes', async () => {
    const ctx = setup(); ready(ctx);
    const app = apps.add({ project_id: null, chat_id: ctx.chat.id, instance_id: ctx.inst.id, name: 'Loans', scope: 'x_plangate2', scope_id: null, spec });
    apps.update(app.id, { plan_approved: specHash(spec), spec: JSON.stringify({ summary: 'Loan tracker v2', tables: [] }) });
    const r = await ctx.call('mcp__build__build_app', { app_id: app.id });
    expect((r as any).message).toMatch(/changed after it was approved/);
  });
});

describe('parallel chats on one instance', () => {
  it('an instance update set switch is refused; placement does it per chat', async () => {
    const { call } = setup();
    for (const [tool, input] of [['mcp__instance__switch_update_set', {}], ['mcp__instance__ensure_active_update_set', {}]] as const)
      expect(await call(tool, input)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('pdi placement') });
  });

  it("an approved write in a second chat waits until the first chat's write returns", async () => {
    const { inst, chat, call, events } = setup();
    const { releaseCall } = await import('../src/server/instanceLock.ts');
    const first = await answer(call('mcp__instance__update_record', { table: 'incident', sys_id: 'a'.repeat(32), fields: { priority: '1' } }), events, true);
    expect(first.behavior).toBe('allow');
    const other = chats.create('build', inst.id, null);
    chats.update(other.id, { placement: chats.get(chat.id)!.placement });
    const otherEvents: Record<string, any>[] = [];
    const canOther = makeCanUseTool(other.id, inst.id, (e) => otherEvents.push(e), { mode: 'build' });
    let done = false;
    const second = (canOther('mcp__instance__update_record', { table: 'incident', sys_id: 'b'.repeat(32), fields: { priority: '2' } }, { signal: new AbortController().signal, toolUseID: 't2', suggestions: [] } as any) as Promise<PermissionResult>).then((r) => { done = true; return r; });
    Object.assign(otherEvents, { chatId: other.id });
    const clicked = answer(second, otherEvents, true);
    await new Promise((r) => setTimeout(r, 40));
    expect(otherEvents.some((e) => e.t === 'approval')).toBe(true);
    expect(done).toBe(false);
    releaseCall('t');
    expect((await clicked).behavior).toBe('allow');
    releaseCall('t2');
  });
});

describe('script runner approvals', () => {
  it('always asks for setup and removal, including chat auto mode, without requiring placement', async () => {
    const { call, events, inst, chat } = setup({ placed: false });
    chats.update(chat.id, { auto_mode: 'project', auto_until: Date.now() + 60000 });
    const records = JSON.stringify({ sys_ws_definition: 'a'.repeat(32), sys_ws_operation: 'b'.repeat(32), sys_security_acl: 'c'.repeat(32) });
    instances.update(inst.id, { script_runner_records: records });
    const install = await asks(call('mcp__instance__setup_script_runner', { script: 'unapproved' }), events);
    const { RUNNER_SCRIPT } = await import('../src/server/scriptRunner.ts');
    expect(install.auto).toBeUndefined(); expect(install.input.records).toHaveLength(2); expect(install.input.script).toBe(RUNNER_SCRIPT);
    const remove = await asks(call('mcp__instance__remove_script_runner', { records: '{}' }), events);
    expect(remove.auto).toBeUndefined(); expect(remove.input.records.map((r: any) => r.sys_id)).toEqual(['a'.repeat(32), 'c'.repeat(32), 'b'.repeat(32)]);
    expect(await call('mcp__instance__run_script', { script: '42', why: 'Check value' })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('pdi placement') });
  });
  it('binds removal to the stored IDs and ignores caller-supplied records', async () => {
    const { call, events, inst } = setup();
    const records = JSON.stringify({ sys_ws_definition: 'a'.repeat(32) });
    instances.update(inst.id, { script_runner_records: records });
    expect(await answer(call('mcp__instance__remove_script_runner', { records: '{}' }), events, true)).toEqual({ behavior: 'allow', updatedInput: { records } });
    const { instanceBusy } = await import('../src/server/instanceLock.ts');
    expect(instanceBusy(inst.id)).toBeNull();
  });
  it('shows the full script and why, and chat auto mode still asks for a script', async () => {
    const { call, events, chat } = setup();
    chats.update(chat.id, { auto_mode: 'project', auto_until: Date.now() + 60000 });
    const input = { script: 'gs.print("start");\n' + '// line\n'.repeat(1500) + '42;', why: 'Inspect the result' };
    const card = await asks(call('mcp__instance__run_script', input), events);
    expect(card.input).toEqual(input); expect(card.auto).toBeUndefined();
  });
  it.each(['setup_script_runner', 'remove_script_runner', 'run_script'])('refuses %s in Explore before a card', async (name) => {
    const { call, events } = setup({ mode: 'explore' });
    expect(await call(`mcp__instance__${name}`, { script: '42', why: 'test' })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Explore') });
    expect(events).toHaveLength(0);
  });
});

describe('full permissions', () => {
  const enabled = (opts: Parameters<typeof setup>[0] = {}) => {
    const ctx = setup(opts);
    instances.update(ctx.inst.id, { full_permissions: 1 });
    return ctx;
  };
  const built = (ctx: ReturnType<typeof setup>) => {
    const spec = JSON.stringify({ summary: 'Loans', tables: [{ name: 'x_loan' }] });
    const app = apps.add({ project_id: ctx.project!.id, chat_id: ctx.chat.id, instance_id: ctx.inst.id, name: 'Loans', scope: `x_${Math.random().toString(36).slice(2, 8)}`, scope_id: null, spec });
    apps.update(app.id, { status: 'built', plan_approved: specHash(spec) });
    buildState.mockResolvedValue({ commit: 'abcdef1234567890', clean: true });
    installPreview.mockResolvedValue({ changes: 'New app', risks: ['script.ts: eval'] });
    return app;
  };
  it.each([
    ['mcp__instance__create_record', { table: 'incident', fields: { short_description: 'Test' } }],
    ['mcp__instance__update_record', { table: 'incident', fields: { priority: '2' } }],
    ['mcp__instance__delete_record', { table: 'incident', sys_id: 'a'.repeat(32) }],
    ['mcp__instance__run_script', { script: 'gs.info("hello")', why: 'Check logging' }],
    ['mcp__pdi__activate_plugin', { plugin_id: 'com.snc.test' }],
    ['mcp__pdi__install_store_app', { sys_id: 'a'.repeat(32), version: '1.0.0' }],
    ['mcp__pdi__use_update_set', { name: 'Test changes', scope: 'global' }],
    ['mcp__build__enable_atf', {}],
  ])('auto-approves and audits %s with a completed card', async (tool, input) => {
    const ctx = enabled();
    expect(await ctx.call(tool, input)).toMatchObject({ behavior: 'allow', updatedInput: input });
    expect(ctx.events[0]).toMatchObject({ t: 'approval', tool, auto: true, full_permissions: true });
    expect(ctx.events[1]).toMatchObject({ t: 'approval_done', id: ctx.events[0].id, decision: 'allow' });
    expect(lastAudit()).toMatchObject({ tool, decision: 'auto-approved (full permissions)', ref: ctx.events[0].id });
    expect(decide(ctx.chat.id, ctx.events[0].id, true)).toBe(false);
  });
  it.each(['setup_script_runner', 'remove_script_runner'])('auto-approves %s without placement and binds the maintenance arguments', async (name) => {
    const ctx = enabled({ placed: false });
    const records = JSON.stringify({ sys_ws_definition: 'a'.repeat(32) });
    instances.update(ctx.inst.id, { script_runner_records: records });
    expect(await ctx.call(`mcp__instance__${name}`, { script: 'unapproved', records: '{}' })).toEqual({
      behavior: 'allow', updatedInput: name === 'remove_script_runner' ? { records } : {},
    });
    expect(ctx.events[0]).toMatchObject({ auto: true, full_permissions: true, input: { kind: 'script-runner' } });
    expect(lastAudit().decision).toBe('auto-approved (full permissions)');
  });
  it('auto-approves enabled user tools and keeps server, mode and credential denials', async () => {
    const server = toolServers.save({ key: 'my_tools', label: 'My tools', enabled: true, transport: 'stdio', command: 'example-mcp', args: [], env: {} });
    const ctx = enabled({ mode: 'build' });
    const input = { table: 'incident', limit: 3 };
    expect(await ctx.call('mcp__my_tools__lookup', input)).toEqual({ behavior: 'allow', updatedInput: input });
    expect(ctx.events[0]).toMatchObject({ auto: true, full_permissions: true, input: { kind: 'tool-server', arguments: input } });
    expect(lastAudit().decision).toBe('auto-approved (full permissions)');
    for (const args of [{ nested: { table: 'oauth_credential' } }, { script: "new GlideRecord('sys_user_token')" }])
      expect(await ctx.call('mcp__my_tools__lookup', args)).toMatchObject({ behavior: 'deny' });
    const unavailable = makeCanUseTool(ctx.chat.id, ctx.inst.id, (e) => ctx.events.push(e), { mode: 'build', toolServerRevisions: {} });
    expect(await unavailable('mcp__my_tools__lookup', {}, { signal: new AbortController().signal, toolUseID: 'unavailable' } as any)).toMatchObject({ behavior: 'deny' });
    expect(await ctx.call('mcp__unknown__lookup')).toMatchObject({ behavior: 'deny' });
    settings.set({ writeEnabled: false });
    expect(await ctx.call('mcp__my_tools__lookup')).toMatchObject({ behavior: 'deny' });
    settings.set({ writeEnabled: true });
    toolServers.enable(server.key, false);
    expect(await ctx.call('mcp__my_tools__lookup')).toMatchObject({ behavior: 'deny' });
    toolServers.enable(server.key, true);
    expect(ctx.events).toHaveLength(2);
    for (const mode of ['explore', 'debug', 'decide', 'mockup'] as const) {
      const readOnly = enabled({ mode });
      expect(await readOnly.call('mcp__my_tools__lookup')).toMatchObject({ behavior: 'deny' });
      expect(readOnly.events).toHaveLength(0);
    }
  });
  it.each(['install_app', 'remove_app', 'run_app_tests'])('auto-approves %s, keeping install scan and commit binding', async (name) => {
    const ctx = enabled(); const app = built(ctx);
    const result = await ctx.call(`mcp__build__${name}`, { app_id: app.id, commit: 'untrusted' });
    expect(result.behavior).toBe('allow');
    expect(lastAudit().decision).toBe('auto-approved (full permissions)');
    if (name === 'install_app') {
      expect(result).toMatchObject({ updatedInput: { commit: 'abcdef1234567890' } });
      expect(ctx.events[0].input).toMatchObject({ risks: ['script.ts: eval'], build: 'abcdef1' });
    }
  });
  it('still refuses a dirty build and an unapproved plan', async () => {
    const ctx = enabled(); const app = built(ctx);
    buildState.mockResolvedValue({ commit: 'abc', clean: false });
    expect(await ctx.call('mcp__build__install_app', { app_id: app.id })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Run build_app first') });
    apps.update(app.id, { plan_approved: null });
    expect(await ctx.call('mcp__build__install_app', { app_id: app.id })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('not approved') });
    expect(ctx.events).toHaveLength(0);
  });
  it.each([
    [{ placed: false }, 'mcp__instance__update_record', { table: 'incident' }, 'pdi placement'],
    [{ mode: 'explore' as const }, 'mcp__pdi__activate_plugin', {}, 'only reads'],
    [{ profile: profile({ cicd: false }) }, 'mcp__pdi__activate_plugin', {}, 'CI/CD'],
    [{ profile: profile({ admin: false }) }, 'mcp__build__install_app', {}, 'admin'],
    [{ checked: false }, 'mcp__build__install_app', {}, 'docs'],
    [{}, 'mcp__instance__query_records', { table: 'sys_user_token' }, 'credentials'],
    [{}, 'mcp__instance__get_record', { table: 'oauth_credential' }, 'credentials'],
    [{}, 'mcp__instance__switch_update_set', {}, 'placement'],
    [{}, 'WebFetch', { url: 'https://example.com' }, 'allowlist'],
  ])('keeps denial %s %s', async (opts, tool, input, message) => {
    const ctx = enabled(opts);
    expect(await ctx.call(tool, input)).toMatchObject({ behavior: 'deny', message: expect.stringContaining(message) });
    expect(lastAudit().decision).toMatch(/^refused:/);
    expect(ctx.events).toHaveLength(0);
  });
  it('still blocks private addresses behind allowlisted names', async () => {
    const ctx = enabled(); lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await ctx.call('WebFetch', { url: 'https://servicenow.com' })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('private') });
  });
  it('keeps changes and scripts switches in force', async () => {
    const ctx = enabled(); settings.set({ writeEnabled: false });
    for (const tool of ['mcp__instance__update_record', 'mcp__instance__setup_script_runner', 'mcp__instance__remove_script_runner', 'mcp__pdi__activate_plugin', 'mcp__build__install_app', 'mcp__pdi__placement'])
      expect(await ctx.call(tool)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Allow changes') });
    settings.set({ writeEnabled: true, scriptingEnabled: false });
    expect(await ctx.call('mcp__instance__run_script', { script: '42', why: 'Check value' })).toMatchObject({ behavior: 'deny', message: expect.stringContaining('scripting is off') });
    expect(ctx.events).toHaveLength(0);
  });
  it('reads the flag per call, with default-off and immediate revocation', async () => {
    const ctx = setup();
    expect(instances.get(ctx.inst.id)?.full_permissions).toBe(0);
    await asks(ctx.call('mcp__pdi__activate_plugin'), ctx.events);
    instances.update(ctx.inst.id, { full_permissions: 1 });
    expect((await ctx.call('mcp__pdi__activate_plugin')).behavior).toBe('allow');
    instances.update(ctx.inst.id, { full_permissions: 0 });
    await asks(ctx.call('mcp__pdi__activate_plugin'), ctx.events);
  });
  it('revoking full permissions stops an auto-approved write waiting for the instance', async () => {
    const { lockInstance } = await import('../src/server/instanceLock.ts');
    const ctx = enabled();
    const release = await lockInstance(ctx.inst.id, 'other-chat');
    const pending = ctx.call('mcp__pdi__activate_plugin');
    await vi.waitFor(() => expect(ctx.events[0]?.auto).toBe(true));
    instances.update(ctx.inst.id, { full_permissions: 0 });
    release();
    expect(await pending).toMatchObject({ behavior: 'deny', message: expect.stringContaining('did not run') });
    expect(lastAudit().decision).toMatch(/^refused:/);
  });
  it('never trusts a stale flag on a non-PDI or retired instance', async () => {
    const ctx = enabled();
    db.prepare("UPDATE instances SET kind = 'other' WHERE id = ?").run(ctx.inst.id);
    await asks(ctx.call('mcp__pdi__activate_plugin'), ctx.events);
    db.prepare("UPDATE instances SET kind = 'pdi', status = 'retired' WHERE id = ?").run(ctx.inst.id);
    await asks(ctx.call('mcp__pdi__activate_plugin'), ctx.events);
  });
});
