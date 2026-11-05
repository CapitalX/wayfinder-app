import { describe, expect, it, vi } from 'vitest';

// Claude is replaced by an answer that ignores Stop: it only ends when the test lets it.
let release = () => {};
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' };
    await new Promise<void>((r) => { release = r; });
    yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, session_id: 's', result: '' };
  })(),
}));

describe('a restart while an answer will not stop', () => {
  it('gives up after its deadline and leaves the mark, so the next start notes the cut-off', async () => {
    const { chats } = await import('../src/server/db.ts');
    const { answering, runChat, stopAllForRestart } = await import('../src/server/agent.ts');
    const chat = chats.create('build', null);
    const run = runChat(chat.id, 'Plan approved. Build it.', () => {});
    await vi.waitFor(() => expect(answering()).toBe(1));

    const t0 = Date.now();
    await stopAllForRestart(300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(answering()).toBe(1);                 // still running: the process exits around it
    expect(chats.cutOff()).toEqual([chat.id]);   // so the mark stays for the next start

    release(); await run;                        // tidy up the test's answer
  });
});
