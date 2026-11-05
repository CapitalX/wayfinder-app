import { describe, expect, it, vi } from 'vitest';

// Claude's program can't be started (an update was replacing it: spawn ETXTBSY).
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: () => (async function* () {
    throw Object.assign(new Error('spawn /app/node_modules/@anthropic-ai/claude-agent-sdk/cli ETXTBSY'), { code: 'ETXTBSY', errno: -26, syscall: 'spawn /app/node_modules/@anthropic-ai/claude-agent-sdk/cli' });
  })(),
}));

describe('an answer whose Claude process cannot start', () => {
  it('says what happened in plain words, with Continue, and no raw error', async () => {
    const { chats, messages } = await import('../src/server/db.ts');
    const { runChat, COULD_NOT_START } = await import('../src/server/agent.ts');
    const chat = chats.create('build', null);
    const events: any[] = [];
    await runChat(chat.id, 'Plan approved. Build it.', (e) => events.push(e));
    const saved = messages.list(chat.id).filter((m) => m.role === 'assistant').at(-1)!.blocks;
    expect(saved).toContainEqual({ type: 'notice', level: 'warn', text: COULD_NOT_START, action: 'continue' });
    expect(JSON.stringify(saved)).not.toContain('ETXTBSY');
    expect(events).toContainEqual({ t: 'notice', level: 'warn', text: COULD_NOT_START, action: 'continue' });
    expect(JSON.stringify(events)).not.toContain('ETXTBSY');
  });

  it('tells start failures from other errors', async () => {
    const { couldNotStart } = await import('../src/server/agent.ts');
    expect(couldNotStart(Object.assign(new Error('spawn x ETXTBSY'), { code: 'ETXTBSY', syscall: 'spawn x' }))).toBe(true);
    expect(couldNotStart(new Error('Error: spawn ETXTBSY'))).toBe(true);
    expect(couldNotStart(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT', syscall: 'spawn node' }))).toBe(true);
    expect(couldNotStart(Object.assign(new Error("ENOENT: no such file, open 'x'"), { code: 'ENOENT', syscall: 'open' }))).toBe(false);
    expect(couldNotStart(new Error('Claude Code process exited with code 1'))).toBe(false);
    expect(couldNotStart(undefined)).toBe(false);
  });
});
