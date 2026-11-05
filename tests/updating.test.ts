import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The restart window an update opens just before it restarts the app: new answers are held, not started.
// main.ts runs for real with serve() mocked (it hands over the app's fetch) and the background starters off.
let fetchApp: (req: Request) => Promise<Response> = () => { throw new Error('server not started'); };
vi.mock('@hono/node-server', async (orig) => ({
  ...(await orig<typeof import('@hono/node-server')>()),
  serve: ({ fetch }: { fetch: typeof fetchApp }) => { fetchApp = fetch; },
}));
vi.mock('../src/server/voice.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/voice.ts')>()), warmVoice: () => {} }));
vi.mock('../src/server/monitor.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/monitor.ts')>()), startMonitor: () => {} }));
vi.mock('../src/server/jobs.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/jobs.ts')>()), startJobPoller: () => {} }));

const { UPDATING_FILE, updating } = await import('../src/server/updating.ts');
const hold = (until: number) => { mkdirSync(dirname(UPDATING_FILE), { recursive: true }); writeFileSync(UPDATING_FILE, JSON.stringify({ until })); };
hold(Date.now() + 60_000);   // left behind by the update that restarted into this server
await import('../src/server/main.ts');
const { secrets } = await import('../src/server/secrets.ts');
const { chats, messages, sends } = await import('../src/server/db.ts');

const send = (id: string, text: string, sendId?: unknown) => fetchApp(new Request(`http://127.0.0.1/api/chats/${id}/send`, {
  method: 'POST', headers: { authorization: `Bearer ${secrets.appToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ text, sendId }),
}));

describe('the restart window', () => {
  it('a new server clears the window the update that started it left behind', () => {
    expect(existsSync(UPDATING_FILE)).toBe(false);
  });

  it('is open until the time the file gives; a missing file holds nothing', () => {
    hold(Date.now() + 5_000); expect(updating()).toBe(true);
    hold(Date.now() - 1); expect(updating()).toBe(false);
    rmSync(UPDATING_FILE); expect(updating()).toBe(false);
  });

  it('fails closed: a file it cannot make sense of holds answers until something removes it', () => {
    for (const junk of ['not json', '{"until":"later"}', '{}', '', 'null']) {
      writeFileSync(UPDATING_FILE, junk);
      expect(updating(), junk).toBe(true);
      expect(updating(Date.now() + 86_400_000), junk).toBe(true);   // no amount of time opens it
    }
    rmSync(UPDATING_FILE); expect(updating()).toBe(false);
  });

  it('a send during the window gets a 503 that says so, and nothing is saved', async () => {
    const chat = chats.create('build', null);
    hold(Date.now() + 5_000);
    const res = await send(chat.id, 'Plan approved. Build it.');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Wayfinder is updating, starting in a moment.', updating: true });
    expect(messages.list(chat.id)).toEqual([]);
    hold(Date.now() - 1);
  });

  it('a send held by the window does not use up its send id, so the resend is taken', async () => {
    const chat = chats.create('build', null);
    hold(Date.now() + 5_000);
    expect((await send(chat.id, 'hi', 'held-send-0001')).status).toBe(503);
    expect(sends.seen('held-send-0001')).toBe(false);
    hold(Date.now() - 1);
  });

  it('a resend of a message a server already took starts nothing and says so', async () => {
    const chat = chats.create('build', null);
    sends.take('taken-send-0001', chat.id);   // the try that reached the server before the restart
    const res = await send(chat.id, 'Plan approved. Build it.', 'taken-send-0001');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already sent', duplicate: true });
    expect(messages.list(chat.id)).toEqual([]);
  });

  it('refuses a send id that is not a short plain token', async () => {
    const chat = chats.create('build', null);
    for (const bad of [42, '', 'x', 'a'.repeat(65), 'has space here']) expect((await send(chat.id, 'hi', bad)).status, String(bad)).toBe(400);
  });
});
