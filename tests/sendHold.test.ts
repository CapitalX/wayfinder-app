import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLD, send, UPDATING } from '../src/web/api.ts';

// The page's send during an update's restart: the old server says it's updating (503), then nothing is listening,
// then the new server takes the message. The page says it's updating once, then streams the answer.
const sse = (...events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const updatingReply = () => new Response(JSON.stringify({ error: UPDATING, updating: true }), { status: 503 });

afterEach(() => { vi.unstubAllGlobals(); HOLD.ms = 120_000; HOLD.pollMs = 1000; });

describe('sending while Wayfinder restarts for an update', () => {
  it('holds the message, says it is updating once, and sends it to the new server', async () => {
    HOLD.pollMs = 0;
    const replies: (() => Response)[] = [updatingReply, () => { throw new TypeError('Failed to fetch'); }, updatingReply, () => sse({ t: 'text', d: 'On it.' }, { t: 'done' })];
    const fetch = vi.fn(async () => replies.shift()!());
    vi.stubGlobal('fetch', fetch);
    const events: any[] = [];
    await send('c1', 'Plan approved. Build it.', (e) => events.push(e));
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(events).toEqual([{ t: 'notice', level: 'info', text: UPDATING }, { t: 'text', d: 'On it.' }, { t: 'done' }]);
  });

  it('gives up with a plain message when the app does not come back', async () => {
    HOLD.pollMs = 0; HOLD.ms = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(send('c1', 'hi', () => {})).rejects.toThrow('taking longer than usual to come back after an update');
  });

  it('every try carries the same send id, and a resend the server already took follows that answer instead', async () => {
    HOLD.pollMs = 0;
    const replies: (() => Response)[] = [() => { throw new TypeError('Failed to fetch'); }, () => new Response(JSON.stringify({ error: 'already sent', duplicate: true }), { status: 409 }), () => sse({ t: 'text', d: 'On it.' }, { t: 'done' })];
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => replies.shift()!());
    vi.stubGlobal('fetch', fetch);
    const events: any[] = [];
    await send('c1', 'Plan approved. Build it.', (e) => events.push(e));
    const [first, second] = fetch.mock.calls.slice(0, 2).map(([, init]) => JSON.parse(String(init!.body)));
    expect(first.sendId).toMatch(/^[\w-]{8,64}$/);
    expect(second).toEqual(first);
    expect(fetch.mock.calls[2][0]).toBe('/api/chats/c1/live');
    expect(events.at(-2)).toEqual({ t: 'text', d: 'On it.' });
  });

  it('any other refusal is an error as before, not a hold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'already answering' }), { status: 409 })));
    await expect(send('c1', 'hi', () => {})).rejects.toThrow('already answering');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 })));
    await expect(send('c1', 'hi', () => {})).rejects.toThrow('busy');
  });
});
