import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyPdiSetup, canAutoSetup, CC_PROPERTY, INTEGRATION_USER, planPdiSetup, type SetupError } from '../src/server/pdiSetup.ts';

const URL_ = 'https://dev12345.service-now.com';
// Made up per run, so no credential-like text sits in the repo.
const made = (p: string) => `${p}-${randomBytes(6).toString('hex')}`;
const PASSWORD = made('pw');
const TYPED = made('typed'), OLD = made('old');

// A fake PDI: an in-memory Table API with basic auth, encoded queries of plain a=b terms (and role.name=), and an OAuth
// token endpoint that accepts an active client-credentials app with the property on.
function fakePdi(opts: { userField?: string | null; adminIsAdmin?: boolean; asleep?: boolean; noCicdRole?: boolean } = {}) {
  let n = 0;
  const id = () => `id${++n}`;
  const t: Record<string, Record<string, any>[]> = {
    sys_user: [{ sys_id: 'u-admin', user_name: 'admin', active: 'true' }],
    sys_user_role: [{ sys_id: 'r-admin', name: 'admin' }, ...(opts.noCicdRole ? [] : [{ sys_id: 'r-cicd', name: 'sn_cicd.sys_ci_automation' }])],
    sys_user_has_role: opts.adminIsAdmin === false ? [] : [{ sys_id: 'h0', user: 'u-admin', role: 'r-admin', state: 'active' }],
    sys_properties: [],
    oauth_entity: [],
    sys_dictionary: opts.userField === null ? [] : [{ name: 'oauth_entity', internal_type: 'reference', reference: 'sys_user', element: opts.userField ?? 'user' }],
  };
  const writes: { method: string; table: string; body: any }[] = [];
  const urls: string[] = [];
  const auths: string[] = [];
  const match = (table: string, row: Record<string, any>, term: string) => {
    const inList = term.match(/^(\w+)IN(.*)$/);
    if (inList) return inList[2].split(',').includes(String(row[inList[1]] ?? ''));
    const [k, v] = term.split('=');
    if (k === 'inherited') return String(row.inherited ?? 'false') === v;
    if (k === 'role.name') return t.sys_user_role.find((r) => r.sys_id === row.role)?.name === v;
    return String(row[k] ?? '') === v;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
    if (opts.asleep) return new Response('<html>Your instance is hibernating. developer.servicenow.com</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const u = new URL(String(input));
    if (u.pathname === '/oauth_token.do') {
      const p = new URLSearchParams(String(init.body));
      const app = t.oauth_entity.find((a) => a.client_id === p.get('client_id'));
      const on = t.sys_properties.find((x) => x.name === CC_PROPERTY)?.value === 'true';
      const ok = p.get('grant_type') === 'client_credentials' && app && app.active === 'true' && app.client_secret === p.get('client_secret') && app.default_grant_type === 'client_credentials' && on && app[opts.userField ?? 'user'];
      return ok ? json(200, { access_token: 'tok', expires_in: 1800 }) : json(401, { error: 'access_denied' });
    }
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    auths.push(auth);
    if (auth !== `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`) return json(401, { error: { message: 'User Not Authenticated' } });
    const [, table, sysId] = u.pathname.match(/^\/api\/now\/table\/([^/]+)(?:\/(.+))?$/) ?? [];
    if (!t[table]) return json(400, { error: { message: `no table ${table}` } });
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      const terms = (u.searchParams.get('sysparm_query') ?? '').split('^').filter(Boolean);
      return json(200, { result: t[table].filter((r) => terms.every((q) => match(table, r, q))).slice(0, Number(u.searchParams.get('sysparm_limit') ?? 100)) });
    }
    if (method === 'DELETE') {
      writes.push({ method, table, body: null }); urls.push(String(input));
      t[table] = t[table].filter((r) => r.sys_id !== sysId);
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init.body));
    writes.push({ method, table, body });
    urls.push(String(input));
    if (method === 'POST') { const row = { sys_id: id(), ...body }; t[table].push(row); return json(201, { result: row }); }
    const i = t[table].findIndex((r) => r.sys_id === sysId);
    if (i < 0) return json(404, { error: { message: 'not found' } });
    t[table][i] = { ...t[table][i], ...body, sys_id: sysId };
    return json(200, { result: t[table][i] });
  }) as typeof fetch;
  return { fetch: fakeFetch, t, writes, auths, urls };
}
const noWait = async () => {};

describe('Set up my PDI for me', () => {
  it('is for PDIs only', async () => {
    expect(canAutoSetup(URL_)).toBe(true);
    expect(canAutoSetup('https://acme.service-now.com')).toBe(false);
    expect(canAutoSetup('http://127.0.0.1:9999')).toBe(false); // the loopback exception is off outside the UI runner
    const pdi = fakePdi();
    await expect(planPdiSetup('https://acme.service-now.com', 'admin', PASSWORD, pdi.fetch)).rejects.toThrow(/personal developer instances/);
    expect(pdi.auths).toHaveLength(0);
  });

  it('refuses a user name that could add query terms, before any request', async () => {
    const pdi = fakePdi();
    await expect(planPdiSetup(URL_, 'admin^ORuser_name=x', PASSWORD, pdi.fetch)).rejects.toThrow(/user name/);
    expect(pdi.auths).toHaveLength(0);
  });

  it('plans without writing anything', async () => {
    const pdi = fakePdi();
    const plan = await planPdiSetup(URL_, 'admin', PASSWORD, pdi.fetch);
    expect(pdi.writes).toHaveLength(0);
    expect(plan.steps.map((s) => [s.key, s.action])).toEqual([
      ['property', 'create'], ['user', 'create'], ['role:admin', 'create'], ['role:sn_cicd.sys_ci_automation', 'create'], ['app', 'create'], ['test', 'create'],
    ]);
  });

  it('creates the user, roles, property and OAuth app, and the sign-in works', async () => {
    const pdi = fakePdi();
    const r = await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    const user = pdi.t.sys_user.find((u) => u.user_name === INTEGRATION_USER)!;
    expect(user).toMatchObject({ active: 'true', web_service_access_only: 'true' });
    expect(user.user_password).toBeUndefined();
    expect(pdi.t.sys_user_has_role.filter((h) => h.user === user.sys_id).map((h) => h.role).sort()).toEqual(['r-admin', 'r-cicd']);
    expect(pdi.t.sys_properties).toMatchObject([{ name: CC_PROPERTY, value: 'true' }]);
    const app = pdi.t.oauth_entity[0];
    expect(app).toMatchObject({ name: 'Wayfinder', type: 'client', default_grant_type: 'client_credentials', user: user.sys_id, client_id: r.client_id, client_secret: r.client_secret });
    expect(r.client_secret.length).toBeGreaterThanOrEqual(32);
    // The admin password never goes into anything written to the instance.
    expect(JSON.stringify(pdi.writes)).not.toContain(PASSWORD);
  });

  it('is idempotent: a second run reuses everything and only gives the app a new secret', async () => {
    const pdi = fakePdi();
    const first = await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    const plan = await planPdiSetup(URL_, 'admin', PASSWORD, pdi.fetch);
    expect(plan.steps.filter((s) => s.action !== 'keep').map((s) => s.key)).toEqual(['user', 'app', 'test']);
    pdi.writes.length = 0;
    const again = await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    expect(again.client_id).toBe(first.client_id);
    expect(again.client_secret).not.toBe(first.client_secret);
    expect(pdi.writes.map((w) => `${w.method} ${w.table}`)).toEqual(['PATCH sys_user', 'PATCH oauth_entity']);
    expect(pdi.t.sys_user.filter((u) => u.user_name === INTEGRATION_USER)).toHaveLength(1);
    expect(pdi.t.oauth_entity).toHaveLength(1);
  });

  it('turns the property on and the user back on when they were off', async () => {
    const pdi = fakePdi();
    pdi.t.sys_properties.push({ sys_id: 'p1', name: CC_PROPERTY, value: 'false' });
    pdi.t.sys_user.push({ sys_id: 'u-int', user_name: INTEGRATION_USER, active: 'false' });
    const plan = await planPdiSetup(URL_, 'admin', PASSWORD, pdi.fetch);
    expect(plan.steps.slice(0, 2).map((s) => s.action)).toEqual(['update', 'update']);
    await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    expect(pdi.t.sys_properties[0].value).toBe('true');
    expect(pdi.t.sys_user.find((u) => u.sys_id === 'u-int')!.active).toBe('true');
  });

  it('locks down an existing user of that name before it gets admin (it may be an ordinary account)', async () => {
    const pdi = fakePdi();
    pdi.t.sys_user.push({ sys_id: 'u-int', user_name: INTEGRATION_USER, active: 'true', web_service_access_only: 'false', user_password: OLD });
    const plan = await planPdiSetup(URL_, 'admin', PASSWORD, pdi.fetch);
    expect(plan.steps.find((s) => s.key === 'user')).toMatchObject({ action: 'update', detail: expect.stringMatching(/web services only.*new password/) });
    await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    const user = pdi.t.sys_user.find((u) => u.sys_id === 'u-int')!;
    expect(user).toMatchObject({ web_service_access_only: 'true', internal_integration_user: 'true', locked_out: 'false' });
    expect(user.user_password).not.toBe(OLD);
    expect(user.user_password.length).toBeGreaterThanOrEqual(40);
    // Locked down before the admin role is added, and sent as a display value so the instance hashes it.
    const order = pdi.writes.map((w) => `${w.method} ${w.table}`);
    expect(order.indexOf('PATCH sys_user')).toBeLessThan(order.indexOf('POST sys_user_has_role'));
    expect(pdi.urls.some((u) => u.includes('/sys_user/u-int') && u.includes('sysparm_input_display_value=true'))).toBe(true);
  });

  it('uses whatever the OAuth app calls its user field', async () => {
    const pdi = fakePdi({ userField: 'oauth_user' });
    await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    expect(pdi.t.oauth_entity[0].oauth_user).toMatch(/^id/);
  });

  it('skips a role the instance does not have', async () => {
    const pdi = fakePdi({ noCicdRole: true });
    const plan = await planPdiSetup(URL_, 'admin', PASSWORD, pdi.fetch);
    expect(plan.steps.find((s) => s.key === 'role:sn_cicd.sys_ci_automation')).toMatchObject({ action: 'skip' });
    await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    expect(pdi.t.sys_user_has_role.filter((h) => h.user !== 'u-admin')).toHaveLength(1);
  });

  it('says plainly when it can\'t: wrong password, not an admin, too old, asleep', async () => {
    await expect(planPdiSetup(URL_, 'admin', 'wrong', fakePdi().fetch)).rejects.toMatchObject({ kind: 'login' });
    await expect(planPdiSetup(URL_, 'admin', PASSWORD, fakePdi({ adminIsAdmin: false }).fetch)).rejects.toMatchObject({ kind: 'not_admin' });
    await expect(planPdiSetup(URL_, 'admin', PASSWORD, fakePdi({ userField: null }).fetch)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(planPdiSetup(URL_, 'admin', PASSWORD, fakePdi({ asleep: true }).fetch)).rejects.toMatchObject({ kind: 'hibernating' });
    // The message never repeats the password that was typed.
    const e = await planPdiSetup(URL_, 'admin', TYPED, fakePdi().fetch).catch((x) => x as Error);
    expect((e as Error).message).not.toContain(TYPED);
  });

  it('reports a failed test sign-in after retrying', async () => {
    const pdi = fakePdi();
    const real = pdi.fetch;
    let tokenCalls = 0;
    const f = (async (u: string | URL, i?: RequestInit) => {
      if (String(u).endsWith('/oauth_token.do')) { tokenCalls++; return new Response(JSON.stringify({ error: 'access_denied' }), { status: 401 }); }
      return real(u, i);
    }) as typeof fetch;
    await expect(applyPdiSetup(URL_, 'admin', PASSWORD, {}, f, noWait)).rejects.toThrow(/signing in with it failed/);
    expect(tokenCalls).toBe(4);
  });

  it('reports each change as it happens, in order', async () => {
    const pdi = fakePdi();
    const seen: string[] = [];
    await applyPdiSetup(URL_, 'admin', PASSWORD, { onStep: (st) => seen.push(st.key) }, pdi.fetch, noWait);
    expect(seen).toEqual(['property', 'user', 'role:admin', 'role:sn_cicd.sys_ci_automation', 'app', 'test']);
  });

  it('failing partway says exactly what is on the instance and what is not', async () => {
    const pdi = fakePdi();
    const real = pdi.fetch;
    const f = (async (u: string | URL, i?: RequestInit) =>
      String(u).includes('/oauth_entity') && i?.method === 'POST' ? new Response(JSON.stringify({ error: { message: 'Operation against file oauth_entity was aborted' } }), { status: 403 }) : real(u, i)) as typeof fetch;
    const steps: string[] = [];
    const e = (await applyPdiSetup(URL_, 'admin', PASSWORD, { onStep: (st) => steps.push(st.key) }, f, noWait).catch((x) => x)) as SetupError;
    expect(e.done).toHaveLength(4);
    expect(e.left).toEqual([expect.stringMatching(/^OAuth app "Wayfinder"/), 'Sign in with it once to check']);
    expect(e.message).toMatch(/Already done on the instance: Allow client-credentials.*Integration user.*Role admin/);
    expect(steps).toEqual(['property', 'user', 'role:admin', 'role:sn_cicd.sys_ci_automation']);
    expect(pdi.t.oauth_entity).toHaveLength(0);
  });

  it("names an existing user's other roles, keeps them by default, and removes them when asked", async () => {
    const pdi = fakePdi();
    pdi.t.sys_user.push({ sys_id: 'u-int', user_name: INTEGRATION_USER, active: 'true' });
    const ITIL = 'b'.repeat(32);
    pdi.t.sys_user_role.push({ sys_id: ITIL, name: 'itil' });
    pdi.t.sys_user_has_role.push({ sys_id: 'h-itil', user: 'u-int', role: ITIL }, { sys_id: 'h-inh', user: 'u-int', role: ITIL, inherited: 'true' });
    const plan = await planPdiSetup(URL_, 'admin', PASSWORD, pdi.fetch);
    expect(plan.extraRoles).toEqual(['itil']);
    expect(plan.steps.find((s) => s.key === 'user')!.detail).toContain('It also has itil');
    await applyPdiSetup(URL_, 'admin', PASSWORD, {}, pdi.fetch, noWait);
    expect(pdi.t.sys_user_has_role.some((h) => h.sys_id === 'h-itil')).toBe(true);
    await applyPdiSetup(URL_, 'admin', PASSWORD, { keepExtraRoles: false }, pdi.fetch, noWait);
    expect(pdi.t.sys_user_has_role.some((h) => h.sys_id === 'h-itil')).toBe(false);
    expect(pdi.t.sys_user_has_role.some((h) => h.sys_id === 'h-inh')).toBe(true); // inherited ones aren't grants to remove
  });

  it('never follows a redirect with the admin login', async () => {
    const pdi = fakePdi();
    const inits: RequestInit[] = [];
    const f = (async (u: string | URL, i?: RequestInit) => { inits.push(i ?? {}); return pdi.fetch(u, i); }) as typeof fetch;
    await planPdiSetup(URL_, 'admin', PASSWORD, f);
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((i) => i.redirect === 'manual')).toBe(true);
  });
});
