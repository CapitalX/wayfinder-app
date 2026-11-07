import { spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { APPS_DIR, CONFIG_DIR, DATA_DIR, envVar } from './config.ts';
import { apps, chats, fluentLessons, jobs, messages, type App, type Block, type Instance, type NoticeCard, type Project } from './db.ts';
import { clearFacts } from './facts.ts';
import { childEnv, insideApp, limited, spawnGroup, stopGroup } from './sandbox.ts';
import { DOC_ALIAS, docSection, parseBuild } from './fluent.ts';
import { scaffold, sdkVersion } from './fluentCheck.ts';
import { lessonKey, reviewLessons } from './fluentReview.ts';
import { NAME_FIRST, nameConfirmed } from './appName.ts';
import { afterInstall } from './followup.ts';
import { getToken, sdkAuthEnv, sn, table } from './sn.ts';
import { SDK_DIR, BUNDLED_SDK, SDK_BIN, holdSdk, sdkRoot } from './sdkRoot.ts';
import { secrets } from './secrets.ts';

// Build mode: Claude writes a scoped app as ServiceNow SDK (Fluent) source, builds it here, and installs it on the PDI.
// Writing files and building are local and run freely; installing, running tests and removing change the PDI and need approval.

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true });
const clip = (s: string, n: number) => (s.length > n ? `… (${s.length - n} earlier characters cut)\n` + s.slice(-n) : s);

export const BUILD_WRITE_TOOLS = new Set(['mcp__build__install_app', 'mcp__build__run_app_tests', 'mcp__build__remove_app', 'mcp__build__enable_atf']);

export const SPEC = z.object({
  name: z.string().min(3).max(80).describe('App name shown on the instance'),
  scope: z.string().regex(/^x_[a-z0-9_]+$/).max(18).describe("Scope: the instance's vendor prefix (e.g. x_12345_) plus a short name, 18 characters at most"),
  summary: z.string().min(10).max(1500).describe('What the app is for and who uses it, in two or three plain sentences'),
  tables: z.array(z.object({
    name: z.string().describe('Full table name including the scope prefix'),
    label: z.string(),
    extends: z.string().optional().describe('Parent table, e.g. task, if any'),
    fields: z.array(z.object({ name: z.string(), label: z.string(), type: z.string().describe('string, integer, boolean, date, date_time, reference:<table>, choice:<a|b|c>, etc.'), notes: z.string().optional() })),
  })).min(1),
  roles: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
  access: z.array(z.string()).default([]).describe('Access rules in plain words, e.g. "loan_manager can create and update loans; everyone with user role can read assets"'),
  logic: z.array(z.object({
    kind: z.enum(['business_rule', 'flow', 'script_include', 'scheduled_job', 'client_script', 'ui_action', 'ui_policy', 'notification', 'rest_api', 'other']),
    name: z.string(),
    does: z.string(),
  })).default([]),
  ui: z.array(z.string()).default([]).describe('Menus, modules, forms, lists, portal or workspace pages'),
  sample_data: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]).describe('ATF tests to write, one line each'),
});
export type Spec = z.infer<typeof SPEC>;

const appDir = (app: App) => join(APPS_DIR, app.scope);

// Everything Claude's app code touches runs in a sandbox on Linux (bubblewrap): the home, data and config folders
// and the Wayfinder checkout are hidden, so the instance secrets, the app token and the Claude key are out of reach;
// only the app's own folder is writable; there's no network except for installs. An install gets network plus the
// instance sign-in it needs (a short-lived token, or the saved password for username/password connections, which the
// approval card says). Every process gets an allowlisted environment, CPU/file limits, and is stopped with its whole
// process group (sandbox.ts). WAYFINDER_SANDBOX=off turns bubblewrap off for local development on a Mac.
export const UNSANDBOXED = 'This build ran without the bubblewrap sandbox (not Linux, or WAYFINDER_SANDBOX=off): the generated code could read files and use the network as the Wayfinder user. Tell the user once.';
export const SANDBOX = process.platform === 'linux' && envVar('SANDBOX') !== 'off';
const NODE_DIR = dirname(dirname(realpathSync(process.execPath)));

interface RunOpts { cwd: string; env?: Record<string, string>; timeoutMs?: number; write?: string[]; net?: boolean; jobId?: string; sdkRoot?: string; home?: string }

export function command(cmd: string, args: string[], opts: RunOpts, sandboxed = SANDBOX): { cmd: string; args: string[]; env: Record<string, string> } {
  const env = childEnv(opts.env, { PATH: process.env.PATH, HOME: opts.home ?? process.env.HOME }, sandboxed);
  const npmCli = join(dirname(process.execPath), 'npm');
  const lim = cmd === 'npm' && existsSync(npmCli)
    ? limited(process.execPath, [realpathSync(npmCli), ...args])
    : limited(cmd, args);
  if (!sandboxed) return { ...lim, env };
  const hide = [homedir(), DATA_DIR, CONFIG_DIR].filter((d, i, all) => all.indexOf(d) === i && existsSync(d));
  const bw = [
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    ...hide.flatMap((d) => ['--tmpfs', d]),
    // Wayfinder's own checkout (its source and config) is hidden too; only its node_modules are mapped in, read-only.
    ...(process.cwd() !== '/' && !hide.some((d) => process.cwd().startsWith(d + '/')) ? ['--tmpfs', process.cwd()] : []),
    '--ro-bind', NODE_DIR, NODE_DIR,
    '--ro-bind', opts.sdkRoot ?? sdkRoot().path, join(APPS_DIR, 'node_modules'),
    '--ro-bind', opts.sdkRoot ?? sdkRoot().path, opts.sdkRoot ?? sdkRoot().path,
    ...(opts.write ?? []).flatMap((d) => ['--bind', d, d]),
    '--unshare-all', ...(opts.net ? ['--share-net'] : []),
    '--die-with-parent', '--new-session', '--chdir', opts.cwd, '--clearenv',
    ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]),
    lim.cmd, ...lim.args,
  ];
  return { cmd: 'bwrap', args: bw, env: {} };
}

export function run(cmd: string, args: string[], opts: RunOpts, sandboxed = SANDBOX): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let c: ReturnType<typeof command>;
    try { c = command(cmd, args, opts, sandboxed); } catch (e) { resolve({ code: 1, out: (e as Error).message }); return; }
    const child = spawnGroup(c.cmd, c.args, { cwd: opts.cwd, env: c.env });
    if (opts.jobId) runningInstalls.set(opts.jobId, child);
    let out = '';
    const add = (b: Buffer) => { out += b.toString(); if (out.length > 400_000) out = out.slice(-200_000); };
    child.stdout!.on('data', add);
    child.stderr!.on('data', add);
    const timer = setTimeout(() => { out += '\n(timed out)'; stopGroup(child); }, opts.timeoutMs ?? 180_000);
    child.on('close', (code) => { if (opts.jobId) runningInstalls.delete(opts.jobId); clearTimeout(timer); resolve({ code: code ?? 1, out: out.replace(/\x1b\[[0-9;]*m/g, '') }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, out: `${out}\n${e.message}` }); });
  });
}

// App installs run here, so they can be cancelled: the job id maps to the SDK process.
const runningInstalls = new Map<string, ChildProcess>();
const cancelledJobs = new Set<string>();
export function cancelInstall(jobId: string): boolean {
  const child = runningInstalls.get(jobId);
  if (!child) return false;
  cancelledJobs.add(jobId);
  stopGroup(child);
  return true;
}

// The ServiceNow SDK CLI, run with this server's node so it works inside the sandbox.
const sdk = async (args: string[], opts: RunOpts) => {
  const release = holdSdk(), root = opts.sdkRoot ?? sdkRoot().path;
  try {
    ensureSdk(root, !opts.sdkRoot);
    return await (SANDBOX
      ? run(process.execPath, [join(root, '@servicenow/sdk/bin/index.js'), ...args], { ...opts, sdkRoot: root })
      : run(SDK_BIN(root), args, { ...opts, sdkRoot: root }));
  } finally { release(); }
};
const git = (dir: string, args: string[]) => run('git', args, { cwd: dir, write: [dir] });

// What an install would ship: the last good build's commit, and whether anything changed since.
// Checkpoints: every good build is a commit; named checkpoints are tags on top. Restoring rolls back the source
// only (not records already on the PDI); the next build and install put that version back.
export interface Checkpoint { ref: string; short: string; at: number; label: string; named: boolean; installed: boolean }
export async function timeline(app: App, limit = 30): Promise<Checkpoint[]> {
  const dir = appDir(app);
  if (!existsSync(join(dir, '.git'))) return [];
  const log = await git(dir, ['log', `-n${limit}`, '--format=%H%x09%ct%x09%s%x09%D']);
  if (log.code !== 0) return [];
  return log.out.trim().split('\n').filter(Boolean).map((line) => {
    const [ref, ct, subject, deco] = line.split('\t');
    const tag = /tag: (cp-[^,]+)/.exec(deco ?? '')?.[1];
    return { ref, short: ref.slice(0, 7), at: Number(ct) * 1000, label: /^Build \d{4}-/.test(subject) ? 'Good build' : subject.replace(/^Checkpoint: /, ''), named: !!tag || subject.startsWith('Checkpoint: '), installed: ref === app.installed_commit };
  });
}

export async function restoreTo(app: App, ref: string): Promise<string> {
  const dir = appDir(app);
  if (!/^[0-9a-f]{7,40}$/.test(ref)) throw new Error('Pick a checkpoint from the list.');
  const known = await git(dir, ['cat-file', '-t', ref]);
  if (known.code !== 0 || known.out.trim() !== 'commit') throw new Error('That checkpoint does not exist in this app.');
  const r = await git(dir, ['restore', `--source=${ref}`, '--staged', '--worktree', '--', 'src']);
  if (r.code !== 0) throw new Error(`Restore failed: ${clip(r.out, 500)}`);
  await git(dir, ['-c', 'user.name=Wayfinder', '-c', 'user.email=wayfinder@localhost', 'commit', '-q', '--allow-empty', '-m', `Restore to ${ref.slice(0, 7)}`]);
  apps.update(app.id, { status: 'draft' });
  return ref.slice(0, 7);
}

// Source differences between two builds, for comparing versions.
export async function diffBuilds(app: App, from: string, to: string): Promise<string> {
  if (![from, to].every((r) => /^[0-9a-f]{7,40}$/.test(r))) throw new Error('Pick two builds from the history.');
  const d = await git(appDir(app), ['diff', '--no-color', '-U2', `${from}..${to}`, '--', 'src', ':!src/fluent/generated']);
  if (d.code !== 0) throw new Error('One of those builds is not in this app.');
  return d.out.length > 60_000 ? d.out.slice(0, 60_000) + '\n… (cut)' : d.out || 'No source differences.';
}

// Changes made on the PDI itself since the install (customer updates in the app's scope), so the source here
// doesn't silently fall out of date.
export async function driftSince(inst: Instance, app: App): Promise<{ count: number; items: { name: string; by: string; at: string }[] }> {
  if (!app.installed_at) return { count: 0, items: [] };
  const since = new Date(app.installed_at + 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const rows = await table(inst, 'sys_update_xml', `application.scope=${app.scope}^sys_updated_on>${since}^ORDERBYDESCsys_updated_on`, 'name,sys_updated_by,sys_updated_on', 20);
  return { count: rows.length, items: rows.map((r: any) => ({ name: r.name, by: r.sys_updated_by, at: r.sys_updated_on })) };
}

// What an install would change, for the approval card: files changed since the build on the PDI, plus a
// quick scan for risky platform calls. The scan is advice for the reader; the approval is the safety boundary.
const RISKY: [RegExp, string][] = [
  [/gs\.setProperty\s*\(/, 'changes a system property (gs.setProperty)'],
  [/setWorkflow\s*\(\s*false\s*\)/, 'turns off business rules on updates (setWorkflow(false))'],
  [/deleteMultiple\s*\(/, 'deletes records in bulk (deleteMultiple)'],
  [/\beval\s*\(|new\s+Function\s*\(|GlideEvaluator/, 'runs code from text (eval or an evaluator)'],
  [/RESTMessageV2|SOAPMessageV2|sn_ws\./, 'calls an outside system (outbound REST/SOAP)'],
  [/new\s+GlideRecord\s*\(\s*['"]sys_(user_has_role|user_role|properties|security_acl|script)/, 'writes or reads security tables (roles, ACLs, properties, scripts)'],
  [/impersonate\s*\(/, 'impersonates a user'],
];
export async function installPreview(app: App, commit: string): Promise<{ changes: string; risks: string[] }> {
  const dir = appDir(app);
  let changes = 'First install of this app.';
  if (app.installed_commit && app.installed_commit !== commit) {
    const diff = await git(dir, ['diff', '--stat=200', `${app.installed_commit}..${commit}`, '--', 'src', ':!src/fluent/generated']);
    const lines = diff.out.trim().split('\n').filter(Boolean);
    changes = lines.length ? `Since the installed build ${app.installed_commit.slice(0, 7)}: ${lines.slice(0, -1).map((l) => l.trim().split('|')[0].trim().replace(/^src\//, '')).join(', ')} (${lines[lines.length - 1].trim()})` : 'No source changes since the installed build.';
  } else if (app.installed_commit === commit) changes = 'This build is already installed; installing again re-applies it.';
  const risks = new Set<string>();
  for (const f of listFiles(dir).filter((f) => !f.startsWith('src/fluent/generated/'))) {
    const body = readFileSync(join(dir, f), 'utf8');
    for (const [re, why] of RISKY) if (why && re.test(body)) risks.add(`${f.replace(/^src\//, '')}: ${why}`);
  }
  return { changes, risks: [...risks].slice(0, 8) };
}

export async function buildState(app: App): Promise<{ commit: string | null; clean: boolean }> {
  const dir = appDir(app);
  if (!existsSync(join(dir, '.git'))) return { commit: null, clean: false };
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const status = await git(dir, ['status', '--porcelain']);
  return { commit: head.code === 0 ? head.out.trim() : null, clean: status.code === 0 && status.out.trim() === '' };
}

// Every app resolves the active SDK through one shared link; SDK leases prevent switching it during a build.
export function ensureSdk(root = sdkRoot().path, linkApps = true) {
  if (SANDBOX) {
    const probe = spawnSync('bwrap', ['--version']);
    if (probe.status !== 0) throw new Error('Builds run in a bubblewrap sandbox on Linux, and bwrap is not installed (sudo apt install bubblewrap).');
  }
  if (!existsSync(SDK_BIN(root))) throw new Error(`The ServiceNow SDK isn't installed for Wayfinder (${SDK_BIN(root)}). Run npm install in the app folder.`);
  if (!linkApps) return;
  const link = join(APPS_DIR, 'node_modules'), want = root;
  if (existsSync(link) && !lstatSync(link).isSymbolicLink()) throw new Error('The apps/node_modules folder must be a link to the active SDK. Move that folder aside, then retry.');
  let ok = false;
  try {
    const st = lstatSync(link);
    ok = st.isSymbolicLink() && readlinkSync(link) === want;
    if (!ok && st.isSymbolicLink()) rmSync(link);
  } catch { ok = false; }
  if (!ok) { mkdirSync(APPS_DIR, { recursive: true }); symlinkSync(want, link, 'dir'); }
}

const ALLOWED_EXT = /\.(ts|tsx|js|jsx|json|html|css|scss|md|xml|txt|svg)$/;
function safePath(app: App, rel: string): string {
  const full = insideApp(appDir(app), rel, { srcOnly: true });
  if (!ALLOWED_EXT.test(full)) throw new Error('That file type is not allowed here.');
  return full;
}

function listFiles(root: string, sub = 'src'): string[] {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(root, `${sub}/${d.name}`) : [`${sub}/${d.name}`]);
}

const prefixes = new Map<string, string>();
async function vendorPrefix(inst: Instance): Promise<string | null> {
  if (prefixes.has(inst.id)) return prefixes.get(inst.id)!;
  try {
    const [row] = await table(inst, 'sys_properties', 'name=glide.appcreator.company.code', 'value', 1);
    const prefix = row?.value ? `x_${row.value}_` : null;
    if (prefix) prefixes.set(inst.id, prefix);
    return prefix;
  } catch { return null; }
}

function note(chatId: string | null, level: 'info' | 'error', textLine: string, card?: NoticeCard) {
  if (!chatId || !chats.get(chatId)) return;
  messages.add(chatId, 'assistant', [{ type: 'notice', level, text: textLine, ...(card ? { card } : {}) }]);
  chats.update(chatId, {});
}

export const appLink = (inst: Instance | undefined, app: App) =>
  inst && app.scope_id ? `${inst.url}/sys_app.do?sys_id=${app.scope_id}` : null;

// One install or removal per app at a time. The claim is taken synchronously, before anything awaits, so two calls
// that arrive together (two chats, a retry) can't both pass the status check and start; it's released when the run
// ends or fails to start. A restart clears it (failOrphanedInstalls marks an interrupted install as failed).
const claimed = new Set<string>();
export function claimApp(app: Pick<App, 'id' | 'name' | 'status'>): () => void {
  if (claimed.has(app.id) || app.status === 'installing' || app.status === 'removing')
    throw new Error(`${app.name} is already being ${app.status === 'removing' ? 'removed' : 'installed'}; wait for that to finish.`);
  claimed.add(app.id);
  let done = false;
  return () => { if (!done) { done = true; claimed.delete(app.id); } };
}

// One writer per app: file writes, builds, checkpoints, restores and installs run from one chat at a time, so another
// chat can't change the source while a build commits it or an install ships it. Reads never wait. A background install
// holds it until it ends, against its own chat too, so later edits can't slip under the build being shipped.
const writers = new Map<string, { chatId: string; what: string; bg: boolean }>();
export function holdApp(app: Pick<App, 'id' | 'name'>, chatId: string, what: string, bg = false): () => void {
  const w = writers.get(app.id);
  if (w && (w.chatId !== chatId || w.bg)) throw new Error(`${app.name} is busy${w.chatId !== chatId ? ' in another chat' : ''} (${w.what}); try again when it finishes.`);
  if (w) return () => {};   // this chat already holds it (a write that builds); the outer hold releases it
  writers.set(app.id, { chatId, what, bg });
  let done = false;
  return () => { if (!done) { done = true; writers.delete(app.id); } };
}

// `now-sdk install` runs here for a few minutes; it's tracked as a job and finishes with a note in the chat.
// It ships exactly the approved build: the commit must still be HEAD with nothing changed since, and it isn't rebuilt.
async function startInstall(inst: Instance, app: App, chatId: string, commit: string, release: () => void = () => {}) {
  const state = await buildState(app);
  if (state.commit !== commit || !state.clean) throw new Error('The app changed after the install was approved. Build it again and ask for a new approval.');
  const job = jobs.add({ instance_id: inst.id, chat_id: chatId, kind: 'app_install', target: app.name, progress_id: '' });
  apps.update(app.id, { status: 'installing', instance_id: inst.id });
  const started = Date.now();
  (async () => {
    jobs.update(job.id, { percent: 10, message: `Installing build ${commit.slice(0, 7)} on the PDI` });
    const dir = appDir(app);
    const res = await sdk(['install'], { cwd: dir, write: [dir], net: true, env: await sdkAuthEnv(inst), timeoutMs: 15 * 60_000, jobId: job.id });
    return { ...res, step: 'install' };
  })().then(({ code, out, step }) => {
    const ok = code === 0;
    const minutes = Math.max(1, Math.round((Date.now() - started) / 60_000));
    const tail = clip(out.trim(), 4000);
    const cancelled = cancelledJobs.delete(job.id);
    apps.update(app.id, { status: ok ? 'installed' : step === 'build' ? 'build_failed' : 'install_failed', last_output: cancelled ? 'Cancelled by you.' : tail, installed_commit: ok ? commit : undefined, installed_at: ok ? Date.now() : undefined });
    if (cancelled) {
      jobs.update(job.id, { status: 'cancelled', message: 'Cancelled by you', finished_at: Date.now() });
      note(chatId, 'info', `${app.name}: install cancelled. The PDI may have part of it; install again to finish, or remove it.`);
      return;
    }
    jobs.update(job.id, { status: ok ? 'successful' : 'failed', percent: ok ? 100 : 0, message: ok ? 'Installed' : tail.split('\n').filter(Boolean).slice(-2).join(' '), finished_at: Date.now() });
    const link = appLink(inst, apps.get(app.id)!);
    const spec = readSpec(apps.get(app.id)!);
    const card: NoticeCard = ok
      ? { kind: 'install', ok, title: `${app.name} is installed`, stats: [{ label: 'Build', value: commit.slice(0, 7) }, { label: 'Took', value: `${minutes} min` }, { label: 'Tables', value: spec?.tables.length ?? 0 }, { label: 'Tests planned', value: spec?.tests?.length ?? 0 }],
          links: [...(link ? [{ label: 'App record', href: link }] : []), ...(spec?.tables ?? []).slice(0, 4).map((t) => ({ label: `${t.label} list`, href: `${inst.url}/${t.name}_list.do` }))] }
      : { kind: 'install', ok, title: `${app.name} failed to ${step}`, stats: [{ label: 'Took', value: `${minutes} min` }], items: tail.split('\n').filter(Boolean).slice(-4).map((l) => ({ label: l.slice(0, 160), status: 'fail' as const })) };
    note(chatId, ok ? 'info' : 'error', ok
      ? `${app.name} is installed on the PDI after ${minutes} min.${link ? ` Open it: ${link}` : ''}`
      : `${app.name} failed to ${step} after ${minutes} min. Ask me to check the output and fix it.\n${tail.split('\n').slice(-6).join('\n')}`, card);
    // Full loop: wake Pip to validate the app, run its tests and hand over review links.
    if (ok) afterInstall(chatId, app.name);
  }).catch((e) => {
    apps.update(app.id, { status: 'install_failed', last_output: (e as Error).message });
    jobs.update(job.id, { status: 'failed', message: (e as Error).message, finished_at: Date.now() });
    note(chatId, 'error', `${app.name} failed to install: ${(e as Error).message}`);
  }).finally(release);
  return job;
}

// The SDK's own uninstall call (the same one ServiceNow Studio's "Delete application" uses). It returns a
// CI/CD progress id, which the job poller follows like a plugin install.
async function startRemove(inst: Instance, app: App, chatId: string) {
  if (!app.scope_id) throw new Error('This app has no scope id yet.');
  const require = createRequire(import.meta.url);
  const sdk = require('@servicenow/sdk-api') as typeof import('@servicenow/sdk-api');
  const creds = inst.auth === 'basic'
    ? { type: 'basic', instanceUrl: new URL(inst.url), username: inst.auth_user ?? '', password: secrets.password(inst.id) ?? '' }
    : null;
  const token = creds ? '' : await getToken(inst, true);
  const connector = creds
    ? new sdk.Connector(creds as any)
    : new sdk.Connector(new sdk.LazyCredential(new URL(inst.url), () => ({ type: 'oauth', token }) as any));
  await connector.setCurrentApplication(app.scope_id);
  const res = await connector.uninstallApplication(app.scope_id, false);
  const body = await res.text();
  const progressId = /answer="([^"]+)"/.exec(body)?.[1];
  if (!res.ok || !progressId) throw new Error(`The instance refused the uninstall (${res.status}): ${body.slice(0, 300)}`);
  apps.update(app.id, { status: 'removing' });
  return jobs.add({ instance_id: inst.id, chat_id: chatId, kind: 'app_remove', target: app.name, progress_id: progressId });
}

// Cache SDK docs by version, so switching SDKs also switches the reference Pip reads.
const docsCache = new Map<string, string>();

// The cheat sheet's learning loop: errors it had no hint for are recorded; when the app next builds green, the diff
// that fixed them is attached and a background review drafts a rule (see fluentReview.ts).
const unhinted = new Map<string, string[]>();
function learnFromBuild(app: App, ok: boolean, errors: ReturnType<typeof parseBuild>['errors'], diff: string) {
  if (!ok) {
    const keys = errors.filter((e) => !e.hint).map((e) => { const k = lessonKey(e.code, e.message); fluentLessons.miss(k, e.code ?? null, e.message, sdkVersion()); return k; });
    unhinted.set(app.id, [...new Set([...(unhinted.get(app.id) ?? []), ...keys])]);
    return;
  }
  const keys = unhinted.get(app.id);
  unhinted.delete(app.id);
  if (!keys?.length) return;
  const misses = fluentLessons.list('miss').filter((l) => keys.includes(l.key));
  for (const l of misses) fluentLessons.update(l.id, { status: 'fixed', fix: diff.slice(0, 6000) || null });
  if (misses.length) void reviewLessons(buildScratch).catch(() => {});
}

// Compile files as a throwaway app (scope x_acme_loan), in the same sandbox as real builds. Used to verify the cheat
// sheet and any rule drafted from a lesson before it's offered.
export async function buildScratch(files: { path: string; content: string }[], root = sdkRoot().path) {
  const release = holdSdk();
  let dir: string | undefined;
  try {
    ensureSdk(root, false);
    const parent = root === BUNDLED_SDK ? join(APPS_DIR, '.checks') : join(SDK_DIR, sdkVersion(root), '.checks');
    dir = scaffold(parent, root, files);
    const res = await sdk(['build'], { cwd: dir, write: [dir], sdkRoot: root });
    const ok = res.code === 0 && /Build completed successfully/i.test(res.out);
    const errors = parseBuild(res.out).errors;
    return { ok, errors: !ok && !errors.length ? [{ message: clip(res.out.trim(), 2000) || 'The SDK build failed.' }] : errors };
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }); release(); }
}

// One build: structured errors for Pip, the raw tail for the app card, and a commit for every good build.
async function runBuild(app: App) {
  const release = holdSdk();
  try {
    ensureSdk();
    const dir = appDir(app);
    const started = Date.now();
    const res = await sdk(['build'], { cwd: dir, write: [dir] });
    const ok = res.code === 0 && /Build completed successfully/i.test(res.out);
    const plain = res.out.replace(/\x1b\[[0-9;]*m/g, '');
    const { errors, warnings } = parseBuild(res.out);
    learnFromBuild(app, ok, errors, ok ? await git(dir, ['diff', 'HEAD', '--', 'src']).then((r) => r.out).catch(() => '') : '');
    apps.update(app.id, { status: ok ? 'built' : 'build_failed', last_output: clip(plain, 4000) });
    if (ok) {
      await git(dir, ['add', '-A']);
      await git(dir, ['-c', 'user.name=Wayfinder', '-c', 'user.email=wayfinder@localhost', 'commit', '-q', '--allow-empty', '-m', `Build ${new Date().toISOString()}`]);
    }
    return {
      ok, seconds: Math.round((Date.now() - started) / 100) / 10, sandboxed: SANDBOX, ...(SANDBOX ? {} : { warning: UNSANDBOXED }),
      ...(errors.length ? { errors } : {}), ...(warnings.length ? { warnings } : {}),
      // Anything the parser couldn't read (a crash, a missing tool) still reaches Pip, from the start of the output.
      ...(!ok && !errors.length ? { output: plain.slice(0, 6000) } : {}),
    };
  } finally { release(); }
}

export function buildServer(inst: Instance | undefined, project: Project | undefined, chatId: string) {
  const getApp = (id: string) => {
    const app = apps.get(id) ?? apps.byScope(id);
    if (!app) throw new Error(`No app ${id}. Use list_apps or propose_app.`);
    return app;
  };
  const needInstance = () => {
    if (!inst || inst.status !== 'active') throw new Error('No PDI is connected, so this step cannot run. The user can connect one in Settings.');
    return inst;
  };
  const wrap = <A,>(fn: (a: A) => Promise<unknown> | unknown) => async (a: A) => {
    try { return text(await fn(a)); } catch (e) { return fail((e as Error).message); }
  };
  const held = async <T,>(app: App, what: string, fn: () => T | Promise<T>): Promise<T> => {
    const release = holdApp(app, chatId, what);
    try { return await fn(); } finally { release(); }
  };

  return createSdkMcpServer({
    name: 'build',
    version: '1.0.0',
    tools: [
      tool('fluent_docs', 'ServiceNow SDK (Fluent) reference from the SDK itself. The cheat sheet in your instructions already covers tables, roles, ACLs, menus, business rules, script includes, client scripts, UI policies, sample data, ATF, and flows (custom Action, Subflow, calling a subflow): only look up what it doesn\'t cover. topic is a page such as "table-api", "uiaction-api", "subflow-api", "custom-action-api" (short names like "menu", "suite", "subflow", "action" or "flow-logic" work too); section narrows it to e.g. "properties" or "examples". list=true lists topics (with an optional filter).', {
        topic: z.string().optional(),
        section: z.string().optional(),
        list: z.boolean().default(false),
      }, wrap(async ({ topic, section, list }: { topic?: string; section?: string; list: boolean }) => {
        ensureSdk();
        const t = topic ? DOC_ALIAS[topic.toLowerCase().trim()] ?? topic : undefined;
        const key = `${sdkVersion()}|${t ?? ''}|${list}`;
        let page = docsCache.get(key);
        if (!page) {
          const args = ['explain', ...(t ? [t] : []), ...(list ? ['--list'] : []), '--format', 'raw'];
          const res = await sdk(args, { cwd: APPS_DIR, timeoutMs: 60_000 });
          if (res.code !== 0) return res.out;
          page = res.out;
          docsCache.set(key, page);
        }
        const out = section ? docSection(page, section) : page;
        return out.length > 30_000 ? out.slice(0, 30_000) + '\n… (cut: ask again with section, e.g. "properties" or "examples")' : out;
      })),

      tool('list_apps', 'Apps built in this project, with status (draft, built, installed, …).', {}, wrap(() =>
        apps.list(project?.id ?? null).map((a) => ({ id: a.id, name: a.name, scope: a.scope, status: a.status, link: appLink(inst, a) })))),

      tool('propose_app', 'Save the plan for a new app (or a revised plan for an existing one, matched by scope) and create its source folder. The app shows the plan to the user as a card; wait for them to approve it before writing files. Scope must start with the instance vendor prefix.', {
        spec: SPEC,
      }, wrap(async ({ spec }: { spec: Spec }) => {
        ensureSdk();
        const before = apps.byScope(spec.scope);
        if (!before || before.status === 'removed' || before.name !== spec.name) {
          const said = messages.list(chatId).filter((m) => m.role === 'user').flatMap((m) => m.blocks.flatMap((b: Block) => (b.type === 'text' ? [b.text] : [])));
          if (!nameConfirmed(spec.name, said)) throw new Error(`The user hasn't named the app "${spec.name}" yet. ${NAME_FIRST}`);
        }
        if (inst?.status === 'active') {
          const prefix = await vendorPrefix(inst);
          if (prefix && !spec.scope.startsWith(prefix)) throw new Error(`Scope must start with this instance's vendor prefix ${prefix} and be at most 18 characters, e.g. ${(prefix + spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '')).slice(0, 18)}.`);
          // A scope that already exists on the instance (and isn't an app built here) would collide at install.
          if (!apps.byScope(spec.scope)) {
            const [taken] = await table(inst, 'sys_scope', `scope=${spec.scope}`, 'sys_id,name', 1).catch(() => []);
            if (taken) throw new Error(`The scope ${spec.scope} is already used on this instance by "${taken.name}". Pick another scope name.`);
          }
        }
        const existing = apps.byScope(spec.scope);
        if (existing) {
          if (existing.status === 'removed') {
            // Starting over with a removed app's scope: clear the old source.
            rmSync(appDir(existing), { recursive: true, force: true });
          } else {
            apps.update(existing.id, { spec: JSON.stringify(spec), name: spec.name, project_id: existing.project_id ?? project?.id ?? null });
            return { app_id: existing.id, revised: true, folder_ready: true, next: 'Ask the user to approve the revised plan.' };
          }
        }
        const dir = join(APPS_DIR, spec.scope);
        mkdirSync(dir, { recursive: true });
        if (!existsSync(join(dir, 'now.config.json'))) {
          const init = await sdk(['init', '--appName', spec.name, '--packageName', spec.scope.replace(/_/g, '-'), '--scopeName', spec.scope, '--template', 'base'], { cwd: dir, write: [dir], timeoutMs: 120_000 });
          if (init.code !== 0) throw new Error(`Couldn't create the app folder: ${clip(init.out, 2000)}`);
          await git(dir, ['init', '-q']);
        }
        const config = JSON.parse(readFileSync(join(dir, 'now.config.json'), 'utf8'));
        const row = existing
          ? (apps.update(existing.id, { spec: JSON.stringify(spec), name: spec.name, status: 'draft', scope_id: config.scopeId, last_output: null }), apps.get(existing.id)!)
          : apps.add({ project_id: project?.id ?? null, chat_id: chatId, instance_id: inst?.id ?? null, name: spec.name, scope: spec.scope, scope_id: config.scopeId, spec: JSON.stringify(spec) });
        return { app_id: row.id, folder_ready: true, files: listFiles(dir), next: 'Show the plan in a few lines and ask the user to approve it (the card has an Approve button).' };
      })),

      tool('list_app_files', 'List the source files of an app.', { app_id: z.string() }, wrap(({ app_id }: { app_id: string }) => listFiles(appDir(getApp(app_id))))),

      tool('read_app_file', 'Read one source file of an app.', { app_id: z.string(), path: z.string() }, wrap(({ app_id, path }: { app_id: string; path: string }) => {
        const app = getApp(app_id);
        return readFileSync(insideApp(appDir(app), path), 'utf8');
      })),

      tool('write_app_file', 'Create or replace one source file in an app. Fluent records go in src/fluent/*.now.ts; server scripts can live in src/server/. Write whole files.', {
        app_id: z.string(),
        path: z.string().describe('Relative path starting with src/, e.g. src/fluent/tables.now.ts'),
        content: z.string().max(300_000),
      }, wrap(({ app_id, path, content }: { app_id: string; path: string; content: string }) => {
        const app = getApp(app_id);
        return held(app, 'writing files', () => {
          const full = safePath(app, path);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content);
          if (app.status !== 'draft') apps.update(app.id, { status: 'draft' });
          return { written: path, bytes: Buffer.byteLength(content) };
        });
      })),

      tool('write_app_files', 'Create or replace several source files at once (whole files), then build by default. Prefer this to write_app_file: write the whole app, or every fix, in one call.', {
        app_id: z.string(),
        files: z.array(z.object({ path: z.string().describe('Relative path starting with src/'), content: z.string().max(300_000) })).min(1).max(40),
        build: z.boolean().default(true),
      }, wrap(async ({ app_id, files, build }: { app_id: string; files: { path: string; content: string }[]; build: boolean }) => {
        const app = getApp(app_id);
        return held(app, build ? 'writing files and building' : 'writing files', async () => {
          const targets = files.map((f) => ({ full: safePath(app, f.path), ...f }));   // check every path before writing any
          for (const f of targets) { mkdirSync(dirname(f.full), { recursive: true }); writeFileSync(f.full, f.content); }
          if (app.status !== 'draft') apps.update(app.id, { status: 'draft' });
          const written = files.map((f) => f.path);
          return build ? { written, build: await runBuild(app) } : { written };
        });
      })),

      tool('delete_app_file', 'Delete one source file in an app.', { app_id: z.string(), path: z.string() }, wrap(({ app_id, path }: { app_id: string; path: string }) => {
        const app = getApp(app_id);
        return held(app, 'deleting a file', () => { rmSync(safePath(app, path), { force: true }); return { deleted: path }; });
      })),

      tool('build_app', 'Build the app locally with the ServiceNow SDK. Returns ok, or errors as [{file, line, code, message, hint}]: fix all of them in one pass, then build again. Never install a failed build.', { app_id: z.string() }, wrap(async ({ app_id }: { app_id: string }) => { const app = getApp(app_id); return held(app, 'building', () => runBuild(app)); })),

      tool('checkpoint', 'Save a named checkpoint of the app source before a risky or large change, so it can be restored. Cheap; use it before restructuring files or trying an alternative.', {
        app_id: z.string(),
        label: z.string().min(3).max(80).describe('What this point is, e.g. "before splitting logic into script includes"'),
      }, wrap(async ({ app_id, label }: { app_id: string; label: string }) => {
        const app = getApp(app_id);
        return held(app, 'saving a checkpoint', async () => {
          const dir = appDir(app);
          await git(dir, ['add', '-A']);
          await git(dir, ['-c', 'user.name=Wayfinder', '-c', 'user.email=wayfinder@localhost', 'commit', '-q', '--allow-empty', '-m', `Checkpoint: ${label}`]);
          const tag = `cp-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
          await git(dir, ['tag', tag]);
          const state = await buildState(app);
          return { saved: true, checkpoint: state.commit?.slice(0, 7), label };
        });
      })),

      tool('list_checkpoints', 'The app\'s history: good builds, named checkpoints and restores, newest first, with which one is installed.', { app_id: z.string() }, wrap(async ({ app_id }: { app_id: string }) =>
        (await timeline(getApp(app_id), 20)).map(({ short, at, label, named, installed }) => ({ checkpoint: short, when: new Date(at).toISOString(), label, named, installed })))),

      tool('restore_checkpoint', 'Roll the app source back to a checkpoint (from list_checkpoints). Only the source changes; build and install again to put that version on the PDI. Tell the user what this does and doesn\'t undo.', {
        app_id: z.string(),
        checkpoint: z.string().describe('Checkpoint id from list_checkpoints'),
      }, wrap(async ({ app_id, checkpoint }: { app_id: string; checkpoint: string }) => {
        const app = getApp(app_id);
        const full = (await timeline(app, 200)).find((c) => c.ref.startsWith(checkpoint));
        if (!full) throw new Error('No checkpoint with that id.');
        const short = await held(app, 'restoring a checkpoint', () => restoreTo(app, full.ref));
        return { restored: short, next: 'Build, then install to put this version on the PDI. Records created on the PDI since are not removed by a restore.' };
      })),

      tool('install_app', 'Install (or update) the last good build of the app on the PDI. Build first; any change after the build needs a new build. Pauses for the user\'s approval, then runs in the background: the app shows progress at the top and posts a note in this chat when done, so do not wait or poll.', {
        app_id: z.string(),
        commit: z.string().optional().describe('Filled in by the app when the user approves; leave it out.'),
      }, wrap(async ({ app_id, commit }: { app_id: string; commit?: string }) => {
        const i = needInstance();
        ensureSdk();
        const app = getApp(app_id);
        if (!commit) throw new Error('No approved build. Ask again so the user can approve it.');
        const hold = holdApp(app, chatId, 'installing', true);
        let unclaim: () => void;
        try { unclaim = claimApp(app); } catch (e) { hold(); throw e; }
        const release = () => { unclaim(); hold(); };
        try { await startInstall(i, app, chatId, commit, release); } catch (e) { release(); throw e; }
        return { started: true, note: 'Runs in the background; a note lands in this chat when it finishes. Tell the user it started and stop here.' };
      })),

      tool('enable_atf', 'Turn on ATF test execution on the instance (sets sn_atf.runner.enabled to true) so the app\'s tests can run. Asks the user first. Use it when the instance facts say ATF execution is OFF and the plan includes tests.', {}, wrap(async () => {
        const i = needInstance();
        const [prop] = await table(i, 'sys_properties', 'name=sn_atf.runner.enabled', 'sys_id,value', 1);
        if (prop?.value === 'true') return { enabled: true, note: 'It was already on.' };
        if (prop) await sn(i, `/api/now/table/sys_properties/${prop.sys_id}`, { method: 'PATCH', body: { value: 'true' } });
        else await sn(i, '/api/now/table/sys_properties', { method: 'POST', body: { name: 'sn_atf.runner.enabled', value: 'true', type: 'true|false', description: 'Enable test/test suite execution' } });
        clearFacts(i.id);
        return { enabled: true };
      })),

      tool('run_app_tests', 'Run the app\'s ATF test suite on the PDI. The suite must be defined in the app (Fluent TestSuite) and the app installed. Pauses for approval, then runs in the background with a note when done.', { app_id: z.string() }, wrap(async ({ app_id }: { app_id: string }) => {
        const i = needInstance();
        const app = getApp(app_id);
        const suites = await table(i, 'sys_atf_test_suite', `sys_scope.scope=${app.scope}^active=true`, 'sys_id,name', 5);
        if (!suites.length) throw new Error('No active ATF test suite in this app. Add a TestSuite with the tests, build and install, then try again.');
        const started = await sn(i, `/api/sn_cicd/testsuite/run?test_suite_sys_id=${suites[0].sys_id}`, { method: 'POST' });
        const progressId = started.result?.links?.progress?.id;
        if (!progressId) throw new Error(`The test run didn't start: ${JSON.stringify(started.result ?? started).slice(0, 300)}`);
        jobs.add({ instance_id: i.id, chat_id: chatId, kind: 'atf', target: `${app.name} tests`, progress_id: progressId });
        return { started: true, suite: suites[0].name, note: 'Runs in the background; results land in this chat as a note.' };
      })),

      tool('remove_app', 'Remove (uninstall) the app and its records from the PDI. The source stays here, so it can be installed again. Pauses for approval, then runs in the background.', { app_id: z.string() }, wrap(async ({ app_id }: { app_id: string }) => {
        const i = needInstance();
        ensureSdk();
        const app = getApp(app_id);
        // Held until the removal is handed to the instance; from then on the app's 'removing' status guards it.
        await held(app, 'removing', async () => {
          const release = claimApp(app);
          try { await startRemove(i, app, chatId); } finally { release(); }
        });
        return { started: true, note: 'Runs in the background; a note lands in this chat when it finishes.' };
      })),
    ],
  });
}

// Install jobs run in this process, so any left "running" by a restart are marked failed.
export function failOrphanedInstalls() {
  for (const job of jobs.running()) {
    if (job.kind !== 'app_install') continue;
    jobs.update(job.id, { status: 'failed', message: 'Wayfinder restarted during the install; run it again.', finished_at: Date.now() });
  }
  for (const app of apps.list()) if (app.status === 'installing') apps.update(app.id, { status: 'install_failed', last_output: 'Interrupted by a restart.' });
}

export function readSpec(app: App): Spec | null {
  try { return JSON.parse(app.spec) as Spec; } catch { return null; }
}
