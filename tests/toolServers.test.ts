import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, chats, settings } from '../src/server/db.ts';
import { secrets } from '../src/server/secrets.ts';
import { SECRETS_FILE } from '../src/server/config.ts';
import { toolServers, toolServerSchema, serverConfig, assembleToolServers } from '../src/server/toolServers.ts';
import { makeCanUseTool, decide } from '../src/server/policy.ts';
import { MASK_RESULTS } from '../src/server/agent.ts';
import { systemPrompt } from '../src/server/prompts.ts';
import { CREDENTIAL_TABLES } from '../src/server/scrub.ts';

const local = { key: 'my_tools', label: 'My tools', enabled: true, transport: 'stdio', command: 'example-mcp', args: ['--stdio'], env: { EXAMPLE_KEY: 'example-secret-value' } };
const http = { key: 'remote', label: 'Remote tools', enabled: true, transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'example-header-value' } };
beforeEach(() => {
  for (const s of toolServers.list()) toolServers.remove(s.key);
  settings.set({ writeEnabled: true });
});

describe('tool server configuration', () => {
  it.each(['instance', 'pdi', 'project', 'build', 'sndocs', 'docs', 'Upper', 'has-dash', '', 'a'.repeat(41), 'two__parts', '__proto__', 'constructor', 'prototype'])('refuses invalid or reserved key %s', (key) => {
    expect(toolServerSchema.safeParse({ ...local, key }).success).toBe(false);
  });
  it.each(['tool', 'my_tools', 'tools_2', '123'])('accepts slug %s', (key) => expect(toolServerSchema.safeParse({ ...local, key }).success).toBe(true));
  it('keeps values only in the secrets file, with statuses in API output', () => {
    toolServers.save(local); toolServers.save(http);
    const api = JSON.stringify(toolServers.publicList());
    const rows = JSON.stringify(db.prepare('SELECT * FROM tool_servers').all());
    for (const value of ['example-secret-value', 'example-header-value']) {
      expect(api).not.toContain(value); expect(rows).not.toContain(value);
      expect(readFileSync(SECRETS_FILE, 'utf8')).toContain(value);
    }
    expect(toolServers.publicList()[0].env).toEqual({ EXAMPLE_KEY: 'set' });
    expect(() => toolServers.save(local)).toThrow('already used');
  });
  it('preserves omitted secrets on edit, clears explicit empty maps, and removes secrets on delete', () => {
    toolServers.save(local);
    const { env: _, ...withoutSecret } = local;
    toolServers.save({ ...withoutSecret, label: 'Renamed' }, true);
    expect(secrets.toolServer(local.key).env).toEqual(local.env);
    toolServers.save({ ...withoutSecret, env: {} }, true);
    expect(secrets.toolServer(local.key).env).toEqual({});
    toolServers.save(local, true); toolServers.remove(local.key);
    expect(secrets.toolServer(local.key)).toEqual({ env: {}, headers: {} });
    expect(toolServers.publicList()).toEqual([]);
  });
  it('drops old transport secrets on a transport change', () => {
    toolServers.save(local);
    toolServers.save({ ...http, key: local.key }, true);
    expect(secrets.toolServer(local.key)).toEqual({ env: {}, headers: http.headers });
  });
  it('rejects malformed transport fields and header injection without echoing secrets', () => {
    for (const value of [{ ...local, args: 'wrong' }, { ...local, env: { KEY: 1 } }, { ...local, command: '' }, { ...local, headers: {} },
      { ...http, url: 'file:///tmp/server' }, { ...http, url: 'https://user:secret@example.com' }, { ...http, headers: { Authorization: 'secret\r\nHost: other' } }]) {
      expect(() => toolServers.save(value)).toThrow('Invalid tool server');
    }
  });
});

describe('assembly', () => {
  it('includes enabled stdio and HTTP servers with their transport configuration', async () => {
    toolServers.save(local); toolServers.save(http); toolServers.save({ ...local, key: 'off', enabled: false });
    const discover = vi.fn().mockResolvedValue(['lookup']);
    const result = await assembleToolServers(toolServers.list(), discover);
    expect(Object.keys(result.servers).sort()).toEqual(['my_tools', 'remote']);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(result.servers.my_tools).toMatchObject({ type: 'stdio', command: local.command, args: local.args, env: local.env });
    expect(result.servers.remote).toEqual({ type: 'http', url: http.url, headers: http.headers });
    expect(result.unavailable).toEqual([]);
  });
  it('does not inherit instance or model credentials', () => {
    vi.stubEnv('INSTANCE_PASSWORD', 'inherited-secret'); vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-api-key');
    try {
      const config = serverConfig(toolServers.save(local));
      expect(config).toMatchObject({ env: { INSTANCE_PASSWORD: '', ANTHROPIC_API_KEY: '', EXAMPLE_KEY: 'example-secret-value' } });
      expect(JSON.stringify(config)).not.toContain('inherited-secret');
      expect(JSON.stringify(config)).not.toContain('inherited-api-key');
    } finally { vi.unstubAllEnvs(); }
  });
  it('keeps other servers when one fails, without exposing the error or its credentials', async () => {
    toolServers.save(local); toolServers.save(http);
    const result = await assembleToolServers(toolServers.list(), async (config) => {
      if (config.type === 'http') throw new Error('example-header-value');
      return ['lookup'];
    });
    expect(Object.keys(result.servers)).toEqual(['my_tools']);
    expect(result.unavailable).toEqual(['remote']);
    expect(JSON.stringify(result)).not.toContain('example-header-value');
  });
  it('drops a server disabled during discovery', async () => {
    toolServers.save(local);
    const result = await assembleToolServers(toolServers.list(), async () => { toolServers.enable(local.key, false); return []; });
    expect(result.servers).toEqual({}); expect(result.unavailable).toEqual([local.key]);
  });
});

function policy(mode: 'build' | 'explore' | 'debug' | 'decide' | 'mockup' = 'build', revisions?: Record<string, string>) {
  const chat = chats.create(mode, null, null), events: Record<string, any>[] = [];
  const canUse = makeCanUseTool(chat.id, null, (e) => events.push(e), { mode, toolServerRevisions: revisions });
  const call = (name = 'mcp__my_tools__lookup', input: Record<string, unknown> = {}) => canUse(name, input, { signal: new AbortController().signal, toolUseID: 't', suggestions: [] } as any);
  return { chat, events, call };
}
describe('external tool policy', () => {
  it('asks on every call, showing the label, tool and exact arguments, and supports denial', async () => {
    toolServers.save(local);
    const { chat, events, call } = policy();
    for (const allow of [true, false]) {
      const args = { table: 'incident', limit: 3 };
      const pending = call(undefined, args);
      const card = events.findLast((e) => e.t === 'approval')!;
      expect(card.input).toEqual({ kind: 'tool-server', server: 'My tools', tool: 'lookup', arguments: args });
      args.limit = 99;
      decide(chat.id, card.id, allow);
      expect(await pending).toMatchObject(allow ? { behavior: 'allow', updatedInput: { table: 'incident', limit: 3 } } : { behavior: 'deny' });
    }
  });
  it.each(['explore', 'debug', 'decide', 'mockup'] as const)('refuses %s without an approval card', async (mode) => {
    toolServers.save(local); const { call, events } = policy(mode);
    expect(await call()).toMatchObject({ behavior: 'deny' }); expect(events).toEqual([]);
  });
  it('refuses disabled, unknown, unassembled and globally read-only tools', async () => {
    toolServers.save({ ...local, enabled: false });
    expect(await policy().call()).toMatchObject({ behavior: 'deny' });
    expect(await policy().call('mcp__unknown__lookup')).toMatchObject({ behavior: 'deny' });
    toolServers.enable(local.key, true);
    expect(await policy('build', {}).call()).toMatchObject({ behavior: 'deny' });
    settings.set({ writeEnabled: false });
    expect(await policy().call()).toMatchObject({ behavior: 'deny' });
  });
  it.each([...CREDENTIAL_TABLES])('refuses credential table %s in arbitrary nested arguments', async (table) => {
    toolServers.save(local);
    const { call, events } = policy();
    for (const input of [{ args: { table: table.toUpperCase() } }, { url: `https://example.com/api/now/table/${table}` }, { script: `new GlideRecord('${table}')` }, { tables: [table] }]) {
      expect(await call(undefined, input)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('credential table') });
    }
    expect(events).toEqual([]);
  });
  it.each(['disable', 'remove', 'edit', 'read-only'])('invalidates waiting approvals on %s', async (action) => {
    toolServers.save(local); const { chat, events, call } = policy(); const pending = call();
    if (action === 'disable') toolServers.enable(local.key, false);
    if (action === 'remove') toolServers.remove(local.key);
    if (action === 'edit') toolServers.save({ ...local, command: 'different-program' }, true);
    if (action === 'read-only') settings.set({ writeEnabled: false });
    decide(chat.id, events[0].id, true);
    expect(await pending).toMatchObject({ behavior: 'deny' });
  });
});

describe('masking and prompts', () => {
  it('matches external tools and masks their result before Pip receives it', async () => {
    expect(new RegExp(MASK_RESULTS.matcher!).test('mcp__my_tools__lookup')).toBe(true);
    const result = await MASK_RESULTS.hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'mcp__my_tools__lookup', tool_response: { content: [{ type: 'text', text: JSON.stringify({ ['pass' + 'word']: 'do-not-show' }) }] } } as any, 't', { signal: new AbortController().signal });
    expect(JSON.stringify(result)).not.toContain('do-not-show'); expect(JSON.stringify(result)).toContain('[masked]');
  });
  it('clips large external results before the model sees them', async () => {
    const result: any = await MASK_RESULTS.hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'mcp__my_tools__lookup', tool_response: 'x'.repeat(9000) } as any, 't', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput.updatedToolOutput.length).toBeLessThan(6100);
    expect(result.hookSpecificOutput.updatedToolOutput).toContain('3000 more characters');
  });
  it('names enabled servers, prefers built-in instance tools and explains unavailable servers', () => {
    const prompt = systemPrompt('build', undefined, settings.get(), { release: 'zurich', toolServers: [local], toolServerNote: 'remote is unavailable.' });
    expect(prompt).toContain('my_tools: "My tools"');
    expect(prompt).toContain("Prefer Wayfinder's own instance tools"); expect(prompt).toContain('remote is unavailable.');
    expect(prompt).not.toContain('example-secret-value');
  });
});
