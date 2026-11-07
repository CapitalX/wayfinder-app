import { afterEach, describe, expect, it, vi } from 'vitest';

const { changeInstanceUrl, isPdiUrl, parseInstanceUrl } = await import('../src/server/instanceUrl.ts');
const { authHeader, getToken, secureUrl } = await import('../src/server/sn.ts');
const { audit, chats, instances } = await import('../src/server/db.ts');
const { secrets } = await import('../src/server/secrets.ts');

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('parseInstanceUrl', () => {
  it.each([
    ['dev12345.service-now.com', 'https://dev12345.service-now.com'],
    ['https://dev12345.service-now.com/now/nav/ui', 'https://dev12345.service-now.com'],
    ['  HTTPS://Acme.service-now.com  ', 'https://acme.service-now.com'],
  ])('%s → %s', (raw, url) => expect(parseInstanceUrl(raw)).toEqual({ url }));

  it.each(['http://dev12345.service-now.com', 'ftp://dev12345.service-now.com', 'http://127.0.0.1:8080', 'not a url at all'])('refuses %s', (raw) => {
    expect(parseInstanceUrl(raw)).toHaveProperty('error');
  });

  it('allows plain http only on loopback, and only when the test runner turns it on', () => {
    vi.stubEnv('WAYFINDER_ALLOW_HTTP_LOOPBACK', '1');
    expect(parseInstanceUrl('http://127.0.0.1:8080')).toEqual({ url: 'http://127.0.0.1:8080' });
    expect(parseInstanceUrl('http://localhost:8080')).toEqual({ url: 'http://localhost:8080' });
    expect(parseInstanceUrl('http://dev12345.service-now.com')).toHaveProperty('error');
    expect(parseInstanceUrl('http://127.0.0.1.example.com')).toHaveProperty('error');
  });

  it('knows a PDI address', () => {
    expect(isPdiUrl('https://dev12345.service-now.com')).toBe(true);
    expect(isPdiUrl('https://acme.service-now.com')).toBe(false);
    expect(isPdiUrl('https://dev12345.service-now.com.example.com')).toBe(false);
  });
});

// An entry saved before the https rule: nothing secret is ever sent to it.
describe('sign-in to an http address', () => {
  const old = (auth: 'basic' | 'client_credentials' | 'oauth_user') => {
    const inst = instances.create({ name: 'old', url: 'http://dev1.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth, auth_user: auth === 'basic' ? 'admin' : null });
    secrets.setClientSecret(inst.id, 's'); secrets.setPassword(inst.id, 'pw'); secrets.setRefreshToken(inst.id, 'rt');
    return inst;
  };
  it('refuses before any request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const auth of ['basic', 'client_credentials', 'oauth_user'] as const) {
      const inst = old(auth);
      await expect(authHeader(inst)).rejects.toThrow(/isn't https/);
      if (auth !== 'basic') await expect(getToken(inst)).rejects.toThrow(/isn't https/);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(secureUrl('https://dev1.service-now.com')).toBe(true);
  });
});

describe('changeInstanceUrl', () => {
  const pdi = () => {
    const inst = instances.create({ name: 'dev', url: 'https://dev1.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    instances.update(inst.id, { profile: JSON.stringify({ user: 'admin' }), script_runner_path: '/api/global/wayfinder_script_runner/run', script_runner_records: '{}' });
    secrets.setClientSecret(inst.id, 'secret'); secrets.setPassword(inst.id, 'pw'); secrets.setRefreshToken(inst.id, 'rt');
    const chat = chats.create('build', inst.id);
    chats.update(chat.id, { auto_mode: 'project', auto_until: Date.now() + 3_600_000 });
    return { inst: instances.get(inst.id)!, chat };
  };

  it('needs the opt-in again to point a PDI entry at another instance, and changes nothing without it', () => {
    const { inst, chat } = pdi();
    expect(changeInstanceUrl(inst, 'https://acme.service-now.com', false)).toMatchObject({ needs_opt_in: true });
    expect(instances.get(inst.id)).toMatchObject({ url: 'https://dev1.service-now.com', kind: 'pdi' });
    expect(secrets.clientSecret(inst.id)).toBe('secret');
    expect(chats.get(chat.id)?.auto_mode).toBe('project');
  });

  it('with the opt-in: labels it non-PDI, drops the stored sign-in and access profile, stops auto mode, audits', () => {
    const { inst, chat } = pdi();
    expect(changeInstanceUrl(inst, 'https://acme.service-now.com', true)).toBeNull();
    expect(instances.get(inst.id)).toMatchObject({ url: 'https://acme.service-now.com', kind: 'other', profile: null, script_runner_path: null, script_runner_records: null });
    expect([secrets.clientSecret(inst.id), secrets.password(inst.id), secrets.refreshToken(inst.id)]).toEqual([undefined, undefined, undefined]);
    expect(chats.get(chat.id)).toMatchObject({ auto_mode: 'ask', auto_until: null });
    expect((audit.recent(1) as any[])[0]).toMatchObject({ tool: 'instance', decision: expect.stringContaining('stored sign-in dropped') });
  });

  it('PDI to another PDI still drops the sign-in, but stays a PDI', () => {
    const { inst } = pdi();
    expect(changeInstanceUrl(inst, 'https://dev2.service-now.com', false)).toBeNull();
    expect(instances.get(inst.id)).toMatchObject({ kind: 'pdi', url: 'https://dev2.service-now.com' });
    expect(secrets.clientSecret(inst.id)).toBeUndefined();
  });

  it('the same address changes nothing', () => {
    const { inst } = pdi();
    expect(changeInstanceUrl(inst, inst.url, false)).toBeNull();
    expect(secrets.clientSecret(inst.id)).toBe('secret');
  });
});

describe('changeInstanceUrl when clearing the sign-in fails', () => {
  it('keeps the old address, so the new host never gets the old sign-in', () => {
    const inst = instances.create({ name: 'dev', url: 'https://dev3.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    secrets.setClientSecret(inst.id, 'secret');
    vi.spyOn(secrets, 'clearInstance').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => changeInstanceUrl(inst, 'https://acme.service-now.com', true)).toThrow('disk full');
    expect(instances.get(inst.id)).toMatchObject({ url: 'https://dev3.service-now.com', kind: 'pdi' });
  });
});

// A sign-in still running when the address changes must not leave the old host's token or session behind.
describe('address change during a sign-in', () => {
  it('drops the late token and session, and fetches a fresh one for the new address', async () => {
    const inst = instances.create({ name: 'me', url: 'https://dev4.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'oauth_user', auth_user: null });
    secrets.setRefreshToken(inst.id, 'old-session');
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      // The user changes the address while the old host is still answering.
      if (urls.length === 1) changeInstanceUrl(instances.get(inst.id)!, 'https://dev5.service-now.com', false);
      return new Response(JSON.stringify({ access_token: `token-${urls.length}`, refresh_token: `session-${urls.length}` }), { headers: { 'Content-Type': 'application/json' } });
    });
    await expect(getToken(inst)).rejects.toThrow(/address changed/);
    expect(secrets.refreshToken(inst.id)).toBeUndefined();
    // Signed in again for the new address: its token comes from the new host, never the cached old one.
    secrets.setRefreshToken(inst.id, 'new-session');
    expect(await getToken(instances.get(inst.id)!)).toBe('token-2');
    expect(urls).toEqual(['https://dev4.service-now.com/oauth_token.do', 'https://dev5.service-now.com/oauth_token.do']);
  });
});
