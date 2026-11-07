import { envVar } from './config.ts';
import { instances, type Instance } from './db.ts';
import { secrets } from './secrets.ts';

// Talks to one PDI with an OAuth client-credentials token (the "inbound integration" on the instance).

// Each token remembers the address it came from, so a sign-in still running when the address changes can't hand the
// old host's token to the new one.
const tokens = new Map<string, { token: string; expires: number; url: string }>();

// What a sleeping PDI looks like to the user: it isn't broken, it's asleep or still waking up.
export const WAKING = 'Your PDI is asleep or still waking up (waking can take a few minutes). Wake it from developer.servicenow.com if you haven\'t, then try again.';

export class InstanceError extends Error {
  constructor(message: string, readonly kind: 'hibernating' | 'auth' | 'unreachable' | 'http' | 'forbidden') {
    super(message);
  }
}

const base = (inst: Instance) => inst.url.replace(/\/+$/, '');

export const clearToken = (instanceId: string) => tokens.delete(instanceId);

// Instance addresses are https only, so stored client secrets, passwords and tokens never cross the network in clear
// text. One exception: a loopback address when WAYFINDER_ALLOW_HTTP_LOOPBACK=1 (the UI test runner's fake instance), which
// never leaves the machine.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function secureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && envVar('ALLOW_HTTP_LOOPBACK') === '1' && LOOPBACK.has(u.hostname);
  } catch { return false; }
}
// Never send a secret, password or token to an address that isn't https (an older entry saved before that rule).
function assertSecure(inst: Instance) {
  if (!secureUrl(inst.url)) throw new InstanceError(`${inst.url} isn't https, so Wayfinder won't send your sign-in to it. Change the address in Settings.`, 'auth');
}

function looksHibernating(status: number, contentType: string, body: string) {
  return contentType.includes('text/html') && /hibernat|instance is (?:waking|sleeping)|developer\.servicenow\.com/i.test(body);
}

// A bearer token for the instance. Client credentials: the integration user's token. Sign in as me: the user's token,
// renewed with the stored refresh token. Username + password has no token (see authHeader).
export async function getToken(inst: Instance, force = false): Promise<string> {
  assertSecure(inst);
  if (inst.auth === 'basic') throw new InstanceError('This instance signs in with a username and password, not a token.', 'auth');
  const cached = tokens.get(inst.id);
  if (!force && cached && cached.url === inst.url && cached.expires > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({ client_id: inst.client_id });
  const secret = secrets.clientSecret(inst.id);
  if (inst.auth === 'oauth_user') {
    const refresh = secrets.refreshToken(inst.id);
    if (!refresh) throw new InstanceError('Sign in to the instance again from Settings (no saved session).', 'auth');
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', refresh);
    if (secret) body.set('client_secret', secret);
  } else {
    if (!secret) throw new InstanceError('No client secret saved for this instance', 'auth');
    body.set('grant_type', 'client_credentials');
    body.set('client_secret', secret);
  }
  const json = await tokenRequest(inst, body);
  // The address changed while this was running: keep nothing from the old host.
  if (instances.get(inst.id)?.url !== inst.url) throw new InstanceError('The instance address changed; sign in again.', 'auth');
  if (json.refresh_token && inst.auth === 'oauth_user') secrets.setRefreshToken(inst.id, json.refresh_token);
  tokens.set(inst.id, { token: json.access_token, expires: Date.now() + Number(json.expires_in ?? 1800) * 1000, url: inst.url });
  return json.access_token;
}

export async function tokenRequest(inst: Instance, body: URLSearchParams): Promise<any> {
  assertSecure(inst);
  let res: Response;
  try {
    res = await fetch(`${base(inst)}/oauth_token.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new InstanceError(`Can't reach ${inst.url}: ${(e as Error).message}`, 'unreachable');
  }
  const text = await res.text();
  if (looksHibernating(res.status, res.headers.get('content-type') ?? '', text))
    throw new InstanceError(WAKING, 'hibernating');
  let json: any;
  try { json = JSON.parse(text); } catch { json = {}; }
  if (!res.ok || !json.access_token)
    throw new InstanceError(`Sign-in to the instance failed (${res.status}): ${json.error_description ?? json.error ?? text.slice(0, 200)}`, 'auth');
  return json;
}

// Checks a sign-in before anything is saved: a client-credentials token, or one read with a username and password.
// Throws (InstanceError) when the instance refuses it or can't be reached; a 403 on the read still proves the sign-in.
export async function testSignIn(url: string, s: { auth: 'client_credentials' | 'basic'; client_id?: string; client_secret?: string; username?: string; password?: string }): Promise<void> {
  const probe = { id: '', url } as Instance;
  assertSecure(probe);
  const auth = s.auth === 'basic'
    ? `Basic ${Buffer.from(`${s.username ?? ''}:${s.password ?? ''}`).toString('base64')}`
    : `Bearer ${(await tokenRequest(probe, new URLSearchParams({ grant_type: 'client_credentials', client_id: s.client_id ?? '', client_secret: s.client_secret ?? '' }))).access_token}`;
  let res: Response;
  try {
    res = await fetch(`${base(probe)}/api/now/table/sys_properties?sysparm_query=name%3Dglide.buildname&sysparm_fields=value&sysparm_limit=1`, { headers: { Authorization: auth, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  } catch (e) { throw new InstanceError(`Can't reach ${url}: ${(e as Error).message}`, 'unreachable'); }
  const text = await res.text();
  if (looksHibernating(res.status, res.headers.get('content-type') ?? '', text)) throw new InstanceError(WAKING, 'hibernating');
  if (res.status === 401) throw new InstanceError('The instance refused that sign-in (401).', 'auth');
  if (!res.ok && res.status !== 403) throw new InstanceError(`Checking the sign-in failed (${res.status}).`, 'http');
}

// The Authorization header for one request, whatever the sign-in method.
export async function authHeader(inst: Instance, force = false): Promise<string> {
  assertSecure(inst);
  if (inst.auth === 'basic') {
    const pw = secrets.password(inst.id);
    if (!pw || !inst.auth_user) throw new InstanceError('No username/password saved for this instance', 'auth');
    return `Basic ${Buffer.from(`${inst.auth_user}:${pw}`).toString('base64')}`;
  }
  return `Bearer ${await getToken(inst, force)}`;
}

export async function sn(inst: Instance, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const call = async (auth: string) =>
    fetch(`${base(inst)}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60_000),
    });
  let res = await call(await authHeader(inst));
  if (res.status === 401 && inst.auth !== 'basic') res = await call(await authHeader(inst, true));
  const text = await res.text();
  if (looksHibernating(res.status, res.headers.get('content-type') ?? '', text))
    throw new InstanceError(WAKING, 'hibernating');
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (res.status === 401) throw new InstanceError(`Sign-in to the instance was refused (401)${inst.auth === 'oauth_user' ? '; sign in again from Settings' : ''}.`, 'auth');
  if (!res.ok) throw new InstanceError(`${init.method ?? 'GET'} ${path} failed (${res.status}): ${json?.error?.message ?? json?.error ?? text.slice(0, 300)}`, res.status === 403 ? 'forbidden' : 'http');
  return json;
}

// The table name goes into the URL path, so it must be a plain table name: a crafted one (../../x) can't reach another API.
export const TABLE_NAME = /^[a-z0-9_]{1,80}$/;
export const table = (inst: Instance, name: string, query: string, fields: string, limit = 100): Promise<any[]> =>
  TABLE_NAME.test(name)
    ? sn(inst, `/api/now/table/${name}?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=${encodeURIComponent(fields)}&sysparm_limit=${limit}&sysparm_display_value=false&sysparm_exclude_reference_link=true`).then((r) => r.result as any[])
    : Promise.reject(new Error(`Not a table name: ${JSON.stringify(name.slice(0, 80))}`));

export interface PdiStatus {
  state: 'awake' | 'hibernating' | 'auth_failed' | 'unreachable' | 'error';
  message?: string;
  build?: string;
  lastLogin?: string | null;
  daysSinceLogin?: number | null;
  loginNote?: string;   // why there is no last login: never logged in, or hidden from this account
  checkedAt: number;
}

export async function pdiStatus(inst: Instance): Promise<PdiStatus> {
  const checkedAt = Date.now();
  try {
    const [build] = await table(inst, 'sys_properties', 'name=glide.buildname', 'value', 1);
    // Signed in as the person, their own record is always readable; otherwise the watched user's, if this account may.
    const query = inst.auth === 'oauth_user' ? 'sys_id=javascript:gs.getUserID()' : `user_name=${inst.login_user}`;
    const [user] = await table(inst, 'sys_user', query, 'user_name,last_login_time', 1).catch(() => []);
    const lastLogin: string | null = user?.last_login_time || null;
    // last_login_time comes back in the integration user's time zone, so a same-day login can look like the future.
    const daysSinceLogin = lastLogin ? Math.max(0, Math.floor((Date.now() - Date.parse(lastLogin.replace(' ', 'T') + 'Z')) / 86_400_000)) : null;
    const loginNote = lastLogin ? undefined : user ? `${user.user_name} has never logged in` : `this account can't read ${inst.login_user}'s login time`;
    return { state: 'awake', build: build?.value || undefined, lastLogin, daysSinceLogin, ...(loginNote ? { loginNote } : {}), checkedAt };
  } catch (e) {
    const err = e as InstanceError;
    const state = err.kind === 'hibernating' ? 'hibernating' : err.kind === 'auth' ? 'auth_failed' : err.kind === 'unreachable' ? 'unreachable' : 'error';
    return { state, message: err.message, checkedAt };
  }
}

export async function activatePlugin(inst: Instance, pluginId: string) {
  const res = await sn(inst, `/api/sn_cicd/plugin/${encodeURIComponent(pluginId)}/activate`, { method: 'POST' });
  return res.result as { links?: { progress?: { id: string } }; status_label?: string; status_message?: string };
}

export async function progress(inst: Instance, progressId: string) {
  const res = await sn(inst, `/api/sn_cicd/progress/${encodeURIComponent(progressId)}`);
  return res.result as { status: string; status_label: string; status_message?: string; status_detail?: string; error?: string; percent_complete: number; links?: { results?: { id: string } } };
}

export async function batchInstall(inst: Instance, appSysId: string, version: string, loadDemoData: boolean) {
  const res = await sn(inst, '/api/sn_cicd/app/batch/install', {
    method: 'POST',
    body: { name: `Wayfinder install ${new Date().toISOString()}`, packages: [{ id: appSysId, type: 'application', requested_version: version, load_demo_data: loadDemoData }] },
  });
  return res.result as { links?: { progress?: { id: string }; results?: { id: string } }; status_label?: string; status_message?: string };
}
