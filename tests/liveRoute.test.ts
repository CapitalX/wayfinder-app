import { describe, expect, it, vi } from 'vitest';

// The real server routes and their login check, without a port: serve() hands over the app's fetch, and the
// background starters (voice, monitor, job poller) stay off.
let fetchApp: (req: Request) => Promise<Response> = () => { throw new Error('server not started'); };
vi.mock('@hono/node-server', async (orig) => ({
  ...(await orig<typeof import('@hono/node-server')>()),
  serve: ({ fetch }: { fetch: typeof fetchApp }) => { fetchApp = fetch; },
}));
vi.mock('../src/server/voice.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/voice.ts')>()), warmVoice: () => {} }));
vi.mock('../src/server/monitor.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/monitor.ts')>()), startMonitor: () => {} }));
vi.mock('../src/server/jobs.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/jobs.ts')>()), startJobPoller: () => {} }));

await import('../src/server/main.ts');
const { secrets } = await import('../src/server/secrets.ts');
const { chats } = await import('../src/server/db.ts');
const { startLive, followers } = await import('../src/server/liveAnswer.ts');

const live = (id: string, token: string | null = secrets.appToken(), signal?: AbortSignal) =>
  fetchApp(new Request(`http://127.0.0.1/api/chats/${id}/live`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal }));

// Reads SSE data events until n arrive (or the stream ends); pings are skipped.
async function read(res: Response, n = Infinity) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const got: any[] = [];
  let buf = '';
  while (got.length < n) {
    const { value, done } = await reader.read();
    if (done) return { got, ended: true, reader };
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
      if (data) got.push(JSON.parse(data));
    }
  }
  return { got, ended: false, reader };
}

describe('GET /api/chats/:id/live', () => {
  it('needs the app token', async () => {
    const chat = chats.create('build', null);
    expect((await live(chat.id, null)).status).toBe(401);
    expect((await live(chat.id, 'x'.repeat(secrets.appToken().length))).status).toBe(401);
    expect((await live(chat.id, secrets.statusToken())).status).toBe(401);   // the status token reads only /api/status
  });

  it('a chat that does not exist is a 404', async () => {
    const res = await live('no-such-chat');
    expect(res.status).toBe(404);
  });

  it('with no answer running, it says done and ends', async () => {
    const chat = chats.create('build', null);
    const res = await live(chat.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await read(res)).toMatchObject({ got: [{ t: 'done' }], ended: true });
  });

  it('replays the answer so far, follows it live, and ends at done, each event once', async () => {
    const chat = chats.create('build', null);
    const push = startLive(chat.id);
    push({ t: 'text', d: 'Reading the SDK docs. ' });
    push({ t: 'tool_start', id: 'w1', name: 'mcp__build__write_app_file' });
    const res = await live(chat.id);
    const first = await read(res, 2);
    expect(first.got).toEqual([{ t: 'text', d: 'Reading the SDK docs. ' }, { t: 'tool_start', id: 'w1', name: 'mcp__build__write_app_file' }]);
    expect(followers(chat.id)).toBe(1);
    push({ t: 'tool_end', id: 'w1' });
    push({ t: 'done' });
    const rest: any[] = [];
    for (;;) {
      const { value, done } = await first.reader.read();
      if (done) break;
      for (const l of value.split('\n')) if (l.startsWith('data: ')) rest.push(JSON.parse(l.slice(6)));
    }
    expect(rest).toEqual([{ t: 'tool_end', id: 'w1' }, { t: 'done' }]);
    expect(followers(chat.id)).toBe(0);
  });

  it('a page that leaves mid-answer stops following; the answer carries on for others', async () => {
    const chat = chats.create('build', null);
    const push = startLive(chat.id);
    push({ t: 'text', d: 'Writing the script include.' });
    const ctl = new AbortController();
    const res = await live(chat.id, undefined, ctl.signal);
    const { reader } = await read(res, 1);
    expect(followers(chat.id)).toBe(1);
    await reader.cancel();
    ctl.abort();
    await vi.waitFor(() => expect(followers(chat.id)).toBe(0));
    push({ t: 'text', d: ' Still going.' });   // nothing left to write to, and nothing throws

    const again = await live(chat.id);
    expect((await read(again, 2)).got).toEqual([{ t: 'text', d: 'Writing the script include.' }, { t: 'text', d: ' Still going.' }]);
    push({ t: 'done' });
  });
});
