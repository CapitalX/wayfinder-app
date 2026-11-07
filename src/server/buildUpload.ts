import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DATA_DIR } from './config.ts';
import type { App, Instance } from './db.ts';
import { authHeader, getToken } from './sn.ts';
import { secrets } from './secrets.ts';

// Runs only in the build sandbox, without credentials. Project/Keys may evaluate generated source.
export const PACK_SCRIPT = `
const { Project, Orchestrator } = require(process.argv[1]);
const fs = require('node:fs');
(async () => {
  const project = new Project({ rootDir: process.cwd() });
  const config = project.getConfig();
  await new Orchestrator(project).pack('target/wayfinder.zip');
  const ids = table => Object.values(project.getKeys().getValue().explicit)
    .filter(e => !e.deleted && e.table === table).map(e => e.id);
  fs.writeFileSync('target/wayfinder.json', JSON.stringify({
    scope: config.scope, scopeId: config.scopeId, version: project.getPackage().version,
    store: !!config.hostedPlugins || config.installAs === 'store',
    flows: ids('sys_hub_flow'), actions: ids('sys_hub_action_type_definition')
  }));
})().catch(e => { console.error(e); process.exitCode = 1; });
`;

const Info = z.object({
  scope: z.string().regex(/^x_[a-z0-9_]+$/), scopeId: z.string().regex(/^[a-f0-9]{32}$/),
  version: z.string().min(1).max(100), store: z.boolean(),
  flows: z.array(z.string().regex(/^[a-f0-9]{32}$/)), actions: z.array(z.string().regex(/^[a-f0-9]{32}$/)),
});
const Receipt = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), hash: z.string(), info: Info });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const artifactDir = (app: Pick<App, 'id'>) => {
  if (!/^[\w-]+$/.test(app.id)) throw new Error('Invalid app id.');
  return join(realpathSync(DATA_DIR), 'build-output', app.id);
};

// Read data only, refusing links (including dangling links and linked parent folders), devices and escapes.
export function readBuildFile(root: string, path: string): Buffer {
  if (lstatSync(root).isSymbolicLink()) throw new Error('Build output contains a symlink.');
  const base = realpathSync(root), full = resolve(base, path);
  if (isAbsolute(path) || !full.startsWith(base + sep)) throw new Error('Path is outside the build output.');
  let walk = resolve(sep);
  for (const part of full.split(sep).filter(Boolean)) {
    walk = join(walk, part);
    if (lstatSync(walk).isSymbolicLink()) throw new Error('Build output contains a symlink.');
  }
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) throw new Error('Build output must be a regular file without links.');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function discardBuild(app: Pick<App, 'id'>) { rmSync(artifactDir(app), { recursive: true, force: true }); }

export function recordBuild(app: Pick<App, 'id' | 'scope' | 'scope_id'>, output: string, commit: string) {
  const bytes = readBuildFile(output, 'wayfinder.zip');
  const info = Info.parse(JSON.parse(readBuildFile(output, 'wayfinder.json').toString('utf8')));
  if (info.scope !== app.scope || info.scopeId !== app.scope_id) throw new Error('Build output scope does not match the app.');
  const receipt = Receipt.parse({ commit, hash: hash(bytes), info });
  const dir = artifactDir(app);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'package.zip'), bytes, { mode: 0o600 });
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
}

export function approvedBuild(app: Pick<App, 'id' | 'scope' | 'scope_id'>, commit: string) {
  const dir = artifactDir(app);
  const receipt = Receipt.parse(JSON.parse(readBuildFile(dir, 'receipt.json').toString('utf8')));
  const bytes = readBuildFile(dir, 'package.zip');
  if (receipt.commit !== commit || receipt.hash !== hash(bytes) || receipt.info.scope !== app.scope || receipt.info.scopeId !== app.scope_id)
    throw new Error('Build output does not match the approved commit or hash. Build again and ask for a new approval.');
  return { bytes, info: receipt.info };
}

// The SDK CLI's UISession login, without its terminal/MFA prompt or any project context.
async function basicSession(inst: Instance, signal: AbortSignal) {
  await authHeader(inst); // Validate HTTPS and the saved username/password before sending either.
  signal.throwIfAborted();
  const cookies = new Map<string, string>();
  const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const capture = (res: Response) => {
    for (const header of res.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0], split = pair.indexOf('=');
      if (split > 0) cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
    }
  };
  const base = inst.url.replace(/\/+$/, '');
  const login = await fetch(`${base}/angular.do?sysparm_type=view_form.login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual', signal,
    body: new URLSearchParams({ sysparm_type: 'login', 'ni.nolog.user_password': 'true', user_name: inst.auth_user!, user_password: secrets.password(inst.id)! }),
  });
  if (!login.ok) throw new Error(`Instance session sign-in failed (${login.status}).`);
  capture(login);
  const body = await login.json() as { status?: string };
  if (body.status === 'mfa_code_required') throw new Error('This account requires MFA. Connect with Sign in as me in Settings.');
  if (body.status === 'error') throw new Error('The instance refused the saved username/password.');
  const refresh = await fetch(`${base}/angular.do?sysparm_type=get_user`, {
    method: 'POST', headers: { Cookie: cookie() }, redirect: 'manual', signal,
  });
  // The legacy get_user handshake deliberately returns 401 while supplying x-usertoken-response.
  if (!refresh.ok && refresh.status !== 401) throw new Error(`Could not establish an instance session (${refresh.status}).`);
  capture(refresh);
  signal.throwIfAborted();
  return { type: 'basic' as const, token: refresh.headers.get('x-usertoken-response') ?? '', cookie: cookie() };
}

// Only the SDK Connector is used here: never Project, Orchestrator, config, keys or code from the app folder.
export async function uploadBuild(inst: Instance, artifact: ReturnType<typeof approvedBuild>, signal: AbortSignal,
  progress: (percent: number, message: string) => void) {
  signal.throwIfAborted();
  const require = createRequire(import.meta.url);
  const sdk = require('@servicenow/sdk-api') as typeof import('@servicenow/sdk-api');
  const connector = new sdk.Connector(new sdk.LazyCredential(new URL(inst.url), async () =>
    inst.auth === 'basic' ? basicSession(inst, signal) : { type: 'oauth', token: await getToken(inst, true) }));
  const fetch = connector.fetch.bind(connector);
  connector.fetch = async (path, init, params) => {
    signal.throwIfAborted();
    const response = await fetch(path, { ...init, redirect: 'manual', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }, params);
    signal.throwIfAborted();
    return response;
  };
  const { bytes, info } = artifact;
  const previous = await connector.appUpgradeStatus(info.scope);
  const scope = await connector.getScopeInfo(info.scope, info.scopeId);
  if (scope && (scope.sysClassName === 'sys_store_app') !== info.store)
    throw new Error('The installed app type differs from the built package. Remove it before changing its type.');
  const result = await connector.uploadScopedAppPackage(new Blob([new Uint8Array(bytes)]), {
    timeoutMs: 15 * 60_000, loadDemoData: true, isStoreApp: info.store, registerScope: false, installAsync: true,
    appInfo: { scope: info.scope, scopeId: info.scopeId, version: info.version },
  });
  if (result?.trackerId) {
    for (;;) {
      signal.throwIfAborted();
      const p = await connector.getProgress(result.trackerId);
      progress(p.percent_complete, p.status_message);
      if (p.status === '2') break;
      if (p.status !== '0' && p.status !== '1') throw new Error(p.status_message || 'App install failed.');
      await delay(2000, undefined, { signal });
    }
  } else {
    let finished = false;
    for (let n = 0; n < 30; n++) {
      const status = await connector.appUpgradeStatus(info.scope);
      if (status.finished && status.id !== previous.id) { finished = true; break; }
      await delay(1000, undefined, { signal });
    }
    if (!finished) throw new Error('Could not determine app installation status. Check the instance to verify installation.');
  }
  // Match the SDK's best-effort post-install activation, using only ids captured during the sandboxed build.
  if (info.flows.length || info.actions.length) {
    try {
      const response = await connector.fetch('api/now/wfa_fluent/activate_flows', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ flows: info.flows.map(sys_id => ({ sys_id, active: '', state: '' })), actions: info.actions.map(sys_id => ({ sys_id, active: '', state: '' })) }),
      }, new URLSearchParams({ sysparm_transaction_scope: info.scopeId }));
      if (!response.ok) progress(100, 'Installed; check flow activation on the instance.');
    } catch { signal.throwIfAborted(); progress(100, 'Installed; check flow activation on the instance.'); }
  }
}
