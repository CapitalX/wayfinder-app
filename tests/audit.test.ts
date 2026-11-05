import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]) }));
const { makeCanUseTool } = await import('../src/server/policy.ts');
const { audit, chats, redact, settings } = await import('../src/server/db.ts');

describe('redact', () => {
  it('masks values under secret-looking keys, at any depth', () => {
    expect(redact({ password: 'hunter2', nested: { client_secret: 'abc', Authorization: 'Bearer x' }, list: [{ apiKey: 'k' }], keep: 'ok', token: '' }))
      .toEqual({ password: '[redacted]', nested: { client_secret: '[redacted]', Authorization: '[redacted]' }, list: [{ apiKey: '[redacted]' }], keep: 'ok', token: '' });
  });
  it('masks key- and token-shaped text anywhere', () => {
    expect(redact({ note: 'use sk-ant-abcdefghijklmnop and Bearer eyJhbGciOiJIUzI1NiJ9.x.y' })).toEqual({ note: 'use [redacted] and [redacted]' });
  });
});

describe('policy refusals', () => {
  it('are audited with the tool call id, and secrets in the input are masked', async () => {
    settings.set({ allowlist: ['servicenow.com'] });
    const chat = chats.create('explore', null);
    const canUse = makeCanUseTool(chat.id, null, () => {});
    const r = await canUse('mcp__nowhere__thing', { password: 'hunter2', q: 'x' }, { signal: new AbortController().signal, toolUseID: 'tu-42', suggestions: [] } as any);
    expect(r?.behavior).toBe('deny');
    const row = (audit.recent(1) as any[])[0];
    expect(row).toMatchObject({ chat_id: chat.id, tool: 'mcp__nowhere__thing', ref: 'tu-42' });
    expect(row.decision).toMatch(/^refused: /);
    expect(row.input).not.toContain('hunter2');
    expect(JSON.parse(row.input)).toEqual({ password: '[redacted]', q: 'x' });
  });
});
