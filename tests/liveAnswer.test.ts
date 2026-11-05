import { describe, expect, it, vi } from 'vitest';
import { endLive, followLive, startLive } from '../src/server/liveAnswer.ts';

// Claude is replaced by an answer that says a word, starts a step, then waits until the test lets it finish.
let release = () => {};
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' };
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading the SDK docs.' } } };
    await new Promise<void>((r) => { release = r; });
    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Done.' } } };
    yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, session_id: 's', result: 'Reading the SDK docs. Done.' };
  })(),
}));

describe('the live answer log', () => {
  it('a late joiner gets everything so far, then the rest live, each event once, ending with done', () => {
    const push = startLive('c1');
    push({ t: 'text', d: 'a' }); push({ t: 'tool_start', id: 't1' });
    const seen: unknown[] = [];
    const off = followLive('c1', (e) => seen.push(e));
    expect(seen).toEqual([{ t: 'text', d: 'a' }, { t: 'tool_start', id: 't1' }]);
    push({ t: 'text', d: 'b' }); push({ t: 'done' });
    expect(seen).toEqual([{ t: 'text', d: 'a' }, { t: 'tool_start', id: 't1' }, { t: 'text', d: 'b' }, { t: 'done' }]);
    push({ t: 'text', d: 'after' });   // nothing after done
    expect(seen).toHaveLength(4);
    off();
  });

  it('with no answer running, a joiner just gets done', () => {
    const seen: unknown[] = [];
    followLive('nothing', (e) => seen.push(e));
    expect(seen).toEqual([{ t: 'done' }]);
  });

  it('a log left open (an answer that failed to start) ends for its followers when the next answer starts', () => {
    startLive('c2')({ t: 'text', d: 'x' });
    const seen: unknown[] = [];
    followLive('c2', (e) => seen.push(e));
    startLive('c2');
    expect(seen.at(-1)).toEqual({ t: 'done' });
    endLive('c2');
  });

  it('follows a real answer joined halfway: the start replayed, the rest live, then saved', async () => {
    const { chats, messages } = await import('../src/server/db.ts');
    const { isRunning, runChat } = await import('../src/server/agent.ts');
    const chat = chats.create('build', null);
    const sender: any[] = [];
    const run = runChat(chat.id, 'Plan approved. Build it.', (e) => sender.push(e));
    await vi.waitFor(() => expect(sender.some((e) => e.t === 'text')).toBe(true));
    expect(isRunning(chat.id)).toBe(true);

    const joined: any[] = [];
    followLive(chat.id, (e) => joined.push(e));
    expect(joined).toEqual(sender);              // caught up: exactly what the sender saw so far
    release(); await run;
    expect(joined).toEqual(sender);              // and the rest, live, the same events in the same order
    expect(joined.at(-1)).toEqual({ t: 'done' });
    expect(joined.filter((e) => e.t === 'text').map((e) => e.d).join('')).toBe('Reading the SDK docs. Done.');
    const saved = messages.list(chat.id).at(-1)!;
    expect(saved.role).toBe('assistant');        // saved before done, so the page loads it right after
  });
});
