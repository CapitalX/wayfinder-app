import { describe, expect, it, vi } from 'vitest';

// The real server routes and their login check, without a port: serve() hands over the app's fetch, and the
// background starters (monitor, job poller) stay off.
let fetchApp: (req: Request) => Promise<Response> = () => { throw new Error('server not started'); };
vi.mock('@hono/node-server', async (orig) => ({
  ...(await orig<typeof import('@hono/node-server')>()),
  serve: ({ fetch }: { fetch: typeof fetchApp }) => { fetchApp = fetch; },
}));
vi.mock('../src/server/monitor.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/monitor.ts')>()), startMonitor: () => {} }));
vi.mock('../src/server/jobs.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/jobs.ts')>()), startJobPoller: () => {} }));

await import('../src/server/main.ts');
const { secrets } = await import('../src/server/secrets.ts');
const { instances, audit, chats } = await import('../src/server/db.ts');
const { applyEvent } = await import('../src/web/api.ts');
const { MODES } = await import('../src/server/prompts.ts');
const create = (kind: 'pdi' | 'other' = 'pdi') => instances.create({ name: 'Instance', url: kind === 'pdi' ? 'https://dev12345.service-now.com' : 'https://company.service-now.com', client_id: 'c', login_user: 'admin', kind, auth: 'client_credentials', auth_user: null });
const put = (id: string, body: unknown, headers: Record<string, string> = {}) => fetchApp(new Request(`http://127.0.0.1/api/instances/${id}`, {
  method: 'PUT', headers: { authorization: `Bearer ${secrets.appToken()}`, 'content-type': 'application/json', origin: 'http://127.0.0.1', host: '127.0.0.1', ...headers }, body: JSON.stringify(body),
}));

describe('API request and capability contract', () => {
  it('returns session modes and only the supported setup extras', async () => {
    const headers = { authorization: `Bearer ${secrets.appToken()}` };
    const session = await fetchApp(new Request('http://127.0.0.1/api/session', { headers }));
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ ok: true, modes: MODES });
    const setup = await fetchApp(new Request('http://127.0.0.1/api/setup', { headers }));
    expect(setup.status).toBe(200);
    expect(Object.keys((await setup.json()).extras).sort()).toEqual(['docs', 'docsSource', 'sandbox']);
  });

  it.each(['audio/wav', 'text/plain', 'multipart/form-data'])('rejects %s on all API writes', async (type) => {
    for (const path of ['/api/login', '/api/no-such-route']) {
      const res = await fetchApp(new Request(`http://127.0.0.1${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${secrets.appToken()}`, 'content-type': type }, body: 'data',
      }));
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'send JSON' });
    }
  });

  it.each([false, true])('limits every API body to 4 MB (content-length: %s)', async (lengthHeader) => {
    for (const [path, status] of [['/api/login', 401], ['/api/no-such-route', 404]] as const) {
      for (const extra of [0, 1]) {
        const body = '{}' + ' '.repeat(4 * 1024 * 1024 - 2 + extra);
        const headers: Record<string, string> = { authorization: `Bearer ${secrets.appToken()}`, 'content-type': 'application/json' };
        if (lengthHeader) headers['content-length'] = String(body.length);
        const res = await fetchApp(new Request(`http://127.0.0.1${path}`, { method: 'POST', headers, body }));
        expect(res.status).toBe(extra ? 413 : status);
        if (extra) expect(await res.json()).toEqual({ error: 'That is too large to send.' });
      }
    }
  });
});

describe('full permissions settings API', () => {
  it('persists an explicit boolean on a PDI, exposes it to the chat, and audits both directions', async () => {
    const inst = create(); const chat = chats.create('build', inst.id);
    expect(inst.full_permissions).toBe(0);
    const on = await put(inst.id, { full_permissions: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ full_permissions: 1 });
    const res = await fetchApp(new Request(`http://127.0.0.1/api/chats/${chat.id}`, { headers: { authorization: `Bearer ${secrets.appToken()}` } }));
    expect(await res.json()).toMatchObject({ instance: { full_permissions: 1 } });
    expect((await put(inst.id, { full_permissions: false })).status).toBe(200);
    expect(instances.get(inst.id)?.full_permissions).toBe(0);
    expect(audit.recent(2)).toEqual([
      expect.objectContaining({ tool: 'full permissions', decision: 'turned off' }),
      expect.objectContaining({ tool: 'full permissions', decision: 'turned on' }),
    ]);
  });
  it('refuses non-PDIs and a combined non-PDI address change before mutating anything', async () => {
    const other = create('other');
    const refused = await put(other.id, { full_permissions: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('personal developer instances') });
    const inst = create();
    const changed = await put(inst.id, { url: 'https://vendor.service-now.com', allow_non_pdi: true, full_permissions: true });
    expect(changed.status).toBe(400);
    expect(instances.get(inst.id)).toMatchObject({ url: inst.url, kind: 'pdi', full_permissions: 0 });
  });
  it('turns full permissions off on a non-PDI address change', async () => {
    const inst = create(); await put(inst.id, { full_permissions: true });
    const res = await put(inst.id, { url: 'https://vendor.service-now.com', allow_non_pdi: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'other', full_permissions: 0 });
  });
  it.each([1, 'true', null, {}, []])('refuses a non-boolean flag %j', async (value) => {
    const inst = create();
    expect((await put(inst.id, { full_permissions: value })).status).toBe(400);
    expect(instances.get(inst.id)?.full_permissions).toBe(0);
  });
  it.each([
    [{ authorization: '' }, 401],
    [{ origin: 'https://example.com' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ] as const)('keeps the login, origin and JSON checks: %j', async (headers, status) => {
    const inst = create();
    expect((await put(inst.id, { full_permissions: true }, headers)).status).toBe(status);
    expect(instances.get(inst.id)?.full_permissions).toBe(0);
  });
  it('keeps the reason through streamed approval and completion events', () => {
    const blocks = applyEvent([], { t: 'approval', id: 'a', tool: 'mcp__pdi__placement', input: {}, auto: true, full_permissions: true });
    expect(applyEvent(blocks, { t: 'approval_done', id: 'a', decision: 'allow' })).toEqual([
      { type: 'approval', id: 'a', tool: 'mcp__pdi__placement', input: {}, auto: true, full_permissions: true, decision: 'allow' },
    ]);
  });
});
