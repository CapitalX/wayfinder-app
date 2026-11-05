import { randomBytes } from 'node:crypto';
import { envVar } from './config.ts';
import { isPdiUrl } from './instanceUrl.ts';
import { WAKING, secureUrl } from './sn.ts';

// "Set up my PDI for me": with the PDI's admin login, once, create what the client-credentials sign-in needs (the
// integration user, its roles, the OAuth app and the switch that allows client credentials), then test it. The admin
// password is used for these requests only: it is never stored, logged or put in an error.
// planPdiSetup only reads, so the user sees exactly what will change before anything does. applyPdiSetup is idempotent:
// run again, it reuses what's there, adds what's missing, and gives the OAuth app a fresh secret (the old one can't be
// read back).

export const INTEGRATION_USER = 'wayfinder.integration';
export const OAUTH_APP = 'Wayfinder';
export const ROLES = ['admin', 'sn_cicd.sys_ci_automation'] as const;
export const CC_PROPERTY = 'glide.oauth.inbound.client.credential.grant_type.enabled';

export interface SetupStep { key: string; label: string; action: 'create' | 'update' | 'keep' | 'skip'; detail?: string }
export interface SetupPlan { steps: SetupStep[]; admin: string; extraRoles: string[] }
export interface SetupResult extends SetupPlan { client_id: string; client_secret: string }

// done/left: when it fails partway, what is already on the instance and what isn't, in the plan's words.
export class SetupError extends Error {
  done?: string[]; left?: string[];
  constructor(message: string, readonly kind: 'hibernating' | 'login' | 'not_admin' | 'unreachable' | 'refused' | 'unsupported' | 'stale') { super(message); }
}
// Called after each change on the instance, as it happens (the caller audits it).
export type OnStep = (step: { key: string; label: string }) => void;

// PDIs only (a loopback address too when WAYFINDER_ALLOW_HTTP_LOOPBACK=1, for the UI test runner's fake instance).
export function canAutoSetup(url: string): boolean {
  if (isPdiUrl(url)) return true;
  try { return envVar('ALLOW_HTTP_LOOPBACK') === '1' && secureUrl(url) && new URL(url).protocol === 'http:'; } catch { return false; }
}

type Fetch = typeof fetch;
interface Admin { url: string; auth: string; fetch: Fetch }

const enc = encodeURIComponent;

async function call(a: Admin, path: string, method = 'GET', body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await a.fetch(`${a.url}${path}`, {
      method,
      headers: { Authorization: a.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', // a redirect would carry the admin login somewhere else
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) { throw new SetupError(`Can't reach ${a.url}: ${(e as Error).message}`, 'unreachable'); }
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/html') && /hibernat|instance is (?:waking|sleeping)|developer\.servicenow\.com/i.test(text))
    throw new SetupError(WAKING, 'hibernating');
  if (res.status === 401) throw new SetupError('The instance refused that admin username or password. Check them on developer.servicenow.com (Manage instance password).', 'login');
  let json: any;
  try { json = JSON.parse(text); } catch { json = {}; }
  if (!res.ok) {
    const why = json?.error?.message ?? json?.error ?? `HTTP ${res.status}`;
    throw new SetupError(`${method === 'GET' ? 'Reading' : 'Changing'} ${path.split('?')[0].replace('/api/now/table/', '')} was refused: ${String(why).slice(0, 200)}`, res.status === 403 ? 'not_admin' : 'refused');
  }
  return json.result;
}

const one = async (a: Admin, table: string, query: string, fields: string): Promise<any | undefined> =>
  ((await call(a, `/api/now/table/${table}?sysparm_query=${enc(query)}&sysparm_fields=${enc(fields)}&sysparm_limit=1&sysparm_exclude_reference_link=true`)) as any[])[0];
const insert = (a: Admin, table: string, row: Record<string, unknown>) => call(a, `/api/now/table/${table}?sysparm_exclude_reference_link=true`, 'POST', row);
const patch = (a: Admin, table: string, sysId: string, row: Record<string, unknown>, displayValues = false) =>
  call(a, `/api/now/table/${table}/${enc(sysId)}?sysparm_exclude_reference_link=true${displayValues ? '&sysparm_input_display_value=true' : ''}`, 'PATCH', row);

// The field on the OAuth app that names the user a client-credentials token acts as. Read from the dictionary rather
// than assumed, since its name differs across releases; none means the release is too old for client credentials.
async function oauthUserField(a: Admin): Promise<string | null> {
  const rows: any[] = await call(a, `/api/now/table/sys_dictionary?sysparm_query=${enc('name=oauth_entity^internal_type=reference^reference=sys_user')}&sysparm_fields=element&sysparm_limit=10`);
  const names = rows.map((r) => String(r.element)).filter(Boolean);
  return names.find((n) => /user/i.test(n) && !/^sys_/.test(n)) ?? null;
}

interface Seen {
  adminId: string;
  property?: { sys_id: string; value: string };
  user?: { sys_id: string; active: string };
  extraRoles: { id: string; grant: string; name: string }[];  // roles the existing user has beyond the two it needs
  roles: { name: string; id?: string; granted: boolean }[];
  app?: { sys_id: string; client_id: string };
  userField: string;
}

async function look(a: Admin, adminName: string): Promise<Seen> {
  const admin = await one(a, 'sys_user', `user_name=${adminName}`, 'sys_id');
  if (!admin) throw new SetupError(`There's no user "${adminName}" on this instance.`, 'login');
  const isAdmin = await one(a, 'sys_user_has_role', `user=${admin.sys_id}^role.name=admin^state=active`, 'sys_id');
  if (!isAdmin) throw new SetupError(`"${adminName}" isn't an admin on this instance, so it can't create the integration. Use the PDI's admin login.`, 'not_admin');
  const userField = await oauthUserField(a);
  if (!userField) throw new SetupError("This instance's release has no client-credentials OAuth apps (Washington DC or later has them). Connect with a username and password instead.", 'unsupported');
  const property = await one(a, 'sys_properties', `name=${CC_PROPERTY}`, 'sys_id,value');
  const user = await one(a, 'sys_user', `user_name=${INTEGRATION_USER}`, 'sys_id,active');
  const roles = [];
  for (const name of ROLES) {
    const role = await one(a, 'sys_user_role', `name=${name}`, 'sys_id');
    const granted = !!(role && user && await one(a, 'sys_user_has_role', `user=${user.sys_id}^role=${role.sys_id}`, 'sys_id'));
    roles.push({ name, id: role?.sys_id, granted });
  }
  const app = await one(a, 'oauth_entity', `name=${OAUTH_APP}^type=client`, 'sys_id,client_id');
  // An existing user may carry other roles (given directly, not inherited): the plan names them and asks.
  let extraRoles: Seen['extraRoles'] = [];
  if (user) {
    const grants: any[] = await call(a, `/api/now/table/sys_user_has_role?sysparm_query=${enc(`user=${user.sys_id}^inherited=false`)}&sysparm_fields=sys_id,role&sysparm_limit=100&sysparm_exclude_reference_link=true`);
    const ids = [...new Set(grants.map((g) => g.role).filter((r) => /^[0-9a-f]{32}$/.test(r)))];
    const names: any[] = ids.length ? await call(a, `/api/now/table/sys_user_role?sysparm_query=${enc(`sys_idIN${ids.join(',')}`)}&sysparm_fields=sys_id,name&sysparm_limit=100`) : [];
    const name = new Map(names.map((r) => [r.sys_id, r.name]));
    extraRoles = grants.filter((g) => name.has(g.role) && !(ROLES as readonly string[]).includes(name.get(g.role))).map((g) => ({ id: g.role, grant: g.sys_id, name: name.get(g.role) }));
  }
  return { adminId: admin.sys_id, property, user, roles, app, userField, extraRoles };
}

function steps(s: Seen): SetupStep[] {
  return [
    { key: 'property', label: 'Allow client-credentials sign-in (a system property)', action: !s.property ? 'create' : s.property.value === 'true' ? 'keep' : 'update' },
    // An existing user of that name is always locked down before it gets admin: it may be an ordinary account whose
    // password someone knows.
    { key: 'user', label: `Integration user ${INTEGRATION_USER} (web services only, no password)`, action: s.user ? 'update' : 'create',
      detail: s.user ? `it already exists: make it web services only with a new password nobody knows, so an old password stops working${s.extraRoles.length ? `. It also has ${s.extraRoles.map((r) => r.name).join(', ')}` : ''}` : undefined },
    ...s.roles.map((r): SetupStep => ({
      key: `role:${r.name}`, label: `Role ${r.name}${r.name === 'admin' ? ' (reads and changes everything; Wayfinder still asks before each change)' : ' (turn on plugins, install the apps you build)'}`,
      action: !r.id ? 'skip' : r.granted ? 'keep' : 'create', detail: !r.id ? "this instance doesn't have it" : undefined,
    })),
    { key: 'app', label: `OAuth app "${OAUTH_APP}" (client credentials, as ${INTEGRATION_USER})`, action: s.app ? 'update' : 'create', detail: s.app ? 'a new secret; the old one stops working' : undefined },
    { key: 'test', label: 'Sign in with it once to check', action: 'create' },
  ];
}

const adminFor = (url: string, username: string, password: string, f: Fetch): Admin =>
  ({ url: url.replace(/\/+$/, ''), auth: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, fetch: f });

// The admin username goes into a query, so it must be a plain user name (no ^ to add query terms).
export const USER_NAME = /^[A-Za-z0-9._@-]{1,80}$/;

function guard(url: string, username: string) {
  if (!USER_NAME.test(username)) throw new SetupError("That doesn't look like a user name.", 'login');
  if (!canAutoSetup(url)) throw new SetupError('Automatic setup is only for personal developer instances (https://devNNNNN.service-now.com). Set up other instances by hand.', 'unsupported');
}

export async function planPdiSetup(url: string, username: string, password: string, f: Fetch = fetch): Promise<SetupPlan> {
  guard(url, username);
  const s = await look(adminFor(url, username, password, f), username);
  return { steps: steps(s), admin: username, extraRoles: s.extraRoles.map((r) => r.name) };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function applyPdiSetup(url: string, username: string, password: string, opts: { keepExtraRoles?: boolean; onStep?: OnStep } = {}, f: Fetch = fetch, wait = pause): Promise<SetupResult> {
  guard(url, username);
  const a = adminFor(url, username, password, f);
  const s = await look(a, username);
  const plan = steps(s);
  const label = (key: string) => plan.find((x) => x.key === key)?.label ?? key;
  const done: string[] = [];
  const did = (key: string, what = label(key)) => { done.push(what); opts.onStep?.({ key, label: what }); };
  // Each change runs in order; if one fails, the error says what's already on the instance and what isn't.
  const todo = plan.filter((x) => x.action === 'create' || x.action === 'update').map((x) => x.label);
  const step = async (key: string, run: () => Promise<unknown>, what?: string) => {
    try { await run(); did(key, what); }
    catch (e) {
      const err = e instanceof SetupError ? e : new SetupError((e as Error).message, 'refused');
      err.done = [...done];
      err.left = todo.filter((t) => !done.includes(t));
      err.message = `${err.message} ${done.length ? `Already done on the instance: ${done.join('; ')}. Not done: ${err.left.join('; ')}.` : 'Nothing was changed on the instance.'} Running setup again reuses what's there.`;
      throw err;
    }
  };

  if (!s.property) await step('property', () => insert(a, 'sys_properties', { name: CC_PROPERTY, type: 'true|false', value: 'true', description: 'Allow the OAuth client-credentials grant (set by Wayfinder).' }));
  else if (s.property.value !== 'true') await step('property', () => patch(a, 'sys_properties', s.property!.sys_id, { value: 'true' }));

  let userId = s.user?.sys_id;
  if (!userId) {
    await step('user', async () => { userId = (await insert(a, 'sys_user', { user_name: INTEGRATION_USER, first_name: 'Wayfinder', last_name: 'Integration', active: 'true', web_service_access_only: 'true', internal_integration_user: 'true' })).sys_id as string; });
  } else {
    // The password goes in as a display value so the instance hashes it; nobody, Wayfinder included, keeps it.
    await step('user', () => patch(a, 'sys_user', userId!, { active: 'true', locked_out: 'false', web_service_access_only: 'true', internal_integration_user: 'true', user_password: randomBytes(32).toString('base64url') }, true));
    if (opts.keepExtraRoles === false) for (const r of s.extraRoles)
      await step(`unrole:${r.name}`, () => call(a, `/api/now/table/sys_user_has_role/${enc(r.grant)}`, 'DELETE'), `Removed the role ${r.name} from ${INTEGRATION_USER}`);
  }

  for (const r of s.roles) if (r.id && !r.granted) await step(`role:${r.name}`, () => insert(a, 'sys_user_has_role', { user: userId, role: r.id }));

  const client_secret = randomBytes(24).toString('base64url');
  const client_id = s.app?.client_id ?? randomBytes(16).toString('hex');
  const fields = { active: 'true', default_grant_type: 'client_credentials', client_secret, [s.userField]: userId };
  await step('app', () => s.app
    ? patch(a, 'oauth_entity', s.app.sys_id, fields)
    : insert(a, 'oauth_entity', { name: OAUTH_APP, type: 'client', client_id, access_token_lifespan: '1800', comments: 'Created by Wayfinder (client credentials).', ...fields }));

  // A new OAuth app can take a few seconds before it signs in.
  const body = () => new URLSearchParams({ grant_type: 'client_credentials', client_id, client_secret });
  let last = '';
  for (let i = 0; i < 4; i++) {
    if (i) await wait(2000 * i);
    try {
      const res = await f(`${a.url}/oauth_token.do`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body(), redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok && json.access_token) { did('test'); return { steps: plan, admin: username, extraRoles: s.extraRoles.map((r) => r.name), client_id, client_secret }; }
      last = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    } catch (e) { last = (e as Error).message; }
  }
  const err = new SetupError(`Everything was created, but signing in with it failed (${String(last).slice(0, 200)}). Try again in a minute; it reuses what's there.`, 'refused');
  err.done = [...done]; err.left = [label('test')];
  throw err;
}
