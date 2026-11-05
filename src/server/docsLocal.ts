import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DOCS_DIR, DOCS_REPO } from './config.ts';
import { closeDb, lazyDb } from './docsDb.ts';
import { browse, getDoc, indexInfo, indexRepo, listProducts, redact, search, whatsChanged } from './docsIndex.ts';

// The local docs index, built on this machine: `wayfinder docs setup` or the Download button clones one release
// branch of ServiceNow's public docs repo (Apache-2.0) into <data>/docs/repos/<release> and indexes it into
// <data>/docs/<release>.db. Pip reads it in this process: no docs server, no token, no network while answering.

export const REPOS_DIR = join(DOCS_DIR, 'repos');
const LOCK = join(DOCS_DIR, '.setup.lock');
// A release takes ~0.5 GB of clone and ~1 GB of index; setup wants room for both plus slack.
export const NEED_BYTES = 2 * 1024 ** 3;
export const UPDATE_NEED_BYTES = 512 * 1024 ** 2;

// Release families, oldest first. The docs repo also has feature/*, main, mobile, store, other and nofamily branches.
const KNOWN = ['xanadu', 'yokohama', 'zurich', 'australia', 'brazil'];
const NOT_FAMILIES = new Set(['main', 'mobile', 'store', 'other', 'nofamily']);
export function familiesOf(branches: string[]): string[] {
  const fams = branches.filter((b) => /^[a-z]+$/.test(b) && !NOT_FAMILIES.has(b));
  // Names wrap around the alphabet (zurich, then australia), so known ones keep their order and new ones come after.
  return [...KNOWN.filter((k) => fams.includes(k)), ...fams.filter((f) => !KNOWN.includes(f)).sort()];
}

// Which release to set up: the one asked for, else the instance's if the repo has it, else the newest.
export function pickRelease(families: string[], asked?: string | null, instance?: string | null): string {
  const want = asked?.trim().toLowerCase();
  if (want) {
    if (!families.includes(want)) throw new Error(`There are no docs for "${want}". Available: ${families.join(', ')}.`);
    return want;
  }
  if (instance && families.includes(instance)) return instance;
  if (!families.length) throw new Error('Could not find any releases in the docs repository.');
  return families[families.length - 1];
}

export const localReleases = (): string[] =>
  existsSync(DOCS_DIR) ? readdirSync(DOCS_DIR).filter((f) => /^[a-z]+\.db$/.test(f)).map((f) => f.slice(0, -3)).sort() : [];

export const freeBytes = (dir = DOCS_DIR) => { mkdirSync(dir, { recursive: true }); const s = statfsSync(dir); return s.bavail * s.bsize; };

function dirBytes(dir: string): number {
  let n = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p); else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

export function localInfo() {
  return localReleases().map((r) => {
    let info: { docs?: number; indexed_at?: string; commit?: string } = {};
    try { info = indexInfo(lazyDb(r)); } catch { /* being rebuilt */ }
    const db = join(DOCS_DIR, `${r}.db`);
    return { release: r, ...info, bytes: [db, `${db}-wal`].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0) + dirBytes(join(REPOS_DIR, r)) };
  });
}

// ---------- setup and update ----------

export interface DocsJob { state: 'running' | 'done' | 'failed'; release: string; step: string; detail?: string; started: number; finished?: number }
export type Progress = (step: string, detail?: string) => void;

function run(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => reject(new Error(`git couldn't start (${e.message}). Install git, then try again.`)));
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(redact(`git ${args[0]} failed: ${err.trim().split('\n').pop() ?? code}`))));
  });
}

// The release branches upstream and the commit each is at (one `git ls-remote`, no download).
export const headsOf = (lsRemote: string): Record<string, string> =>
  Object.fromEntries(lsRemote.split('\n').map((l) => l.split(/\s+refs\/heads\//)).filter((p) => p.length === 2 && /^[0-9a-f]{40}$/.test(p[0])).map(([sha, b]) => [b, sha]));
export async function upstreamHeads(repo = DOCS_REPO): Promise<Record<string, string>> {
  const r = spawnSync('git', ['ls-remote', '--heads', repo], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error?.message.includes('ENOENT')) throw new Error('git is not installed. Install git, then try again.');
  if (r.status !== 0) throw new Error(redact(`Couldn't reach the docs repository (${(r.stderr || 'no answer').trim().split('\n').pop()}). Check your network.`));
  return headsOf(r.stdout);
}
export const upstreamFamilies = async (repo = DOCS_REPO): Promise<string[]> => familiesOf(Object.keys(await upstreamHeads(repo)));

// One setup at a time on this machine (the app and the command share the folder). The lock file is created
// atomically (exclusive create); a lock whose process is gone is moved aside first, and only if it is still the same
// lock we found, so two processes can't both clear it and both go ahead.
let holding = false;
function lockAlive(content: string): boolean {
  const pid = Number(content.split(' ')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return holding;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
const BUSY = 'The docs are already being set up. Wait for that to finish.';
function takeLock(release: string) {
  mkdirSync(DOCS_DIR, { recursive: true });
  const mine = `${process.pid} ${release}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(LOCK, mine, { flag: 'wx' }); holding = true; return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let found = '';
    try { found = readFileSync(LOCK, 'utf8'); } catch { continue; } // released meanwhile: try again
    if (lockAlive(found)) throw new Error(BUSY);
    const aside = `${LOCK}.stale-${process.pid}-${Date.now()}`;
    try { renameSync(LOCK, aside); } catch { continue; } // someone else moved it: try again
    const moved = readFileSync(aside, 'utf8');
    rmSync(aside, { force: true });
    // Not the stale lock we found: another process took a fresh one in between. Put it back and stop.
    if (moved !== found) { try { writeFileSync(LOCK, moved, { flag: 'wx' }); } catch { /* it has a new one already */ } throw new Error(BUSY); }
  }
  throw new Error(BUSY);
}
function releaseLock() { holding = false; rmSync(LOCK, { force: true }); }

// Clone (first time) or fetch the release branch, then index what changed. A first build goes to a temporary file
// that replaces the index only when it's complete, so answers never see half an index.
export async function setupDocs(opts: { release?: string | null; instance?: string | null; update?: boolean; repo?: string; onProgress?: Progress; needBytes?: number } = {}): Promise<{ release: string; indexed: number; removed: number; total: number; bytes: number }> {
  const say = opts.onProgress ?? (() => {});
  const repoUrl = opts.repo ?? DOCS_REPO;
  const have = localReleases();
  let release: string;
  if (opts.update && !opts.release) {
    if (!have.length) throw new Error('No docs are set up yet. Run: wayfinder docs setup');
    release = have[have.length - 1];
  } else {
    say('Finding the releases');
    release = pickRelease(await upstreamFamilies(repoUrl), opts.release, opts.instance);
  }
  const clone = join(REPOS_DIR, release);
  const fresh = !existsSync(join(clone, '.git'));
  const need = opts.needBytes ?? (fresh ? NEED_BYTES : UPDATE_NEED_BYTES);
  const free = freeBytes();
  if (free < need) throw new Error(`Not enough disk space: the docs need about ${gb(need)} free and there is ${gb(free)}. Free some space, then try again.`);
  takeLock(release);
  try {
    mkdirSync(REPOS_DIR, { recursive: true });
    if (fresh) {
      say('Downloading the docs', `${release}, about 0.5 GB`);
      rmSync(clone, { recursive: true, force: true });
      await run(['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', release, repoUrl, clone]);
    } else {
      say('Checking for changes', release);
      await run(['fetch', '--quiet', '--depth', '1', 'origin', release], clone);
      await run(['reset', '--quiet', '--hard', 'FETCH_HEAD'], clone);
    }
    const dbFile = join(DOCS_DIR, `${release}.db`);
    const building = existsSync(dbFile) ? dbFile : `${dbFile}.building`;
    rmSync(`${dbFile}.building`, { force: true });
    say('Indexing', 'reading the pages');
    const { DatabaseSync } = await import('node:sqlite');
    closeDb(release);
    const db = new DatabaseSync(building);
    let res;
    try { res = indexRepo(db, clone, (done, todo) => say('Indexing', `${done.toLocaleString()} of ${todo.toLocaleString()} pages`)); }
    finally { db.close(); }
    if (building !== dbFile) { renameSync(building, dbFile); for (const x of ['-wal', '-shm']) rmSync(`${building}${x}`, { force: true }); }
    closeDb(release);
    const bytes = localInfo().find((i) => i.release === release)?.bytes ?? 0;
    say('Done', `${res.total.toLocaleString()} pages, ${gb(bytes)} on disk`);
    return { release, indexed: res.indexed, removed: res.removed, total: res.total, bytes };
  } finally {
    releaseLock();
  }
}

export const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

// The app's own run of setup, for the Download button and the daily check: one at a time, progress for the page.
let current: DocsJob | null = null;
export const docsJob = () => current;
function runDocsJob(opts: { release?: string | null; instance?: string | null; update?: boolean; repo?: string }, onChange: (j: DocsJob) => void): { job: DocsJob; done: Promise<DocsJob> } {
  if (current?.state === 'running') throw new Error('The docs are already being set up.');
  current = { state: 'running', release: opts.release ?? '', step: 'Starting', started: Date.now() };
  const job = current;
  onChange(job);
  let last = 0;
  const done = setupDocs({ ...opts, onProgress: (step, detail) => {
    Object.assign(job, { step, detail });
    if (Date.now() - last > 500 || step === 'Done') { last = Date.now(); onChange(job); }
  } }).then((r) => {
    Object.assign(job, { state: 'done', release: r.release, finished: Date.now() });
    onChange(job);
    return job;
  }, (e: Error) => {
    Object.assign(job, { state: 'failed', detail: redact(e.message), finished: Date.now() });
    onChange(job);
    return job;
  });
  return { job, done };
}
export const startDocsSetup = (opts: { release?: string | null; instance?: string | null; update?: boolean }, onChange: (j: DocsJob) => void): DocsJob => runDocsJob(opts, onChange).job;

// ---------- keeping the docs current by themselves ----------

// Once a day, the docs on this machine follow their upstream: a release whose branch moved is fetched and re-indexed
// (changed pages only), the newest release is downloaded when ServiceNow publishes it (and the selected one, when
// it's another), and older releases are removed. Only when docs were set up once: that's the opt-in.
export type DocsAction = 'update' | 'download' | 'remove';
export interface DocsAuto { at: number; actions: { release: string; action: DocsAction }[]; error?: string }
let lastAuto: DocsAuto | null = null;
export const docsAuto = () => lastAuto;

// What to do, from what's here (release and the commit it was indexed from), what's upstream and which release is
// selected (the setting, else the instance's). Kept: the newest upstream and the selected one; the rest goes, but only
// after the downloads, so a failed download never leaves fewer docs than before. Nothing local means the docs were
// never set up: nothing is downloaded behind the user's back. No release upstream (an odd answer) removes nothing.
export function docsPlan(local: { release: string; commit?: string }[], upstream: Record<string, string>, selected: string | null): { release: string; action: DocsAction }[] {
  if (!local.length) return [];
  const here = (r: string) => local.some((l) => l.release === r);
  const plan: { release: string; action: DocsAction }[] = local.filter((l) => upstream[l.release] && upstream[l.release] !== l.commit).map((l) => ({ release: l.release, action: 'update' }));
  const newest = familiesOf(Object.keys(upstream)).at(-1);
  if (!newest) return plan;
  const keep = new Set([newest, selected && !NOT_FAMILIES.has(selected) ? selected : null].filter((r): r is string => !!r));
  for (const r of keep) if (upstream[r] && !here(r)) plan.push({ release: r, action: 'download' });
  for (const l of local) if (!keep.has(l.release)) plan.push({ release: l.release, action: 'remove' });
  return plan;
}

// A release's index and download, gone. Under the setup lock, so it can't cross a setup or update of the same release.
export function removeRelease(release: string) {
  if (current?.state === 'running') throw new Error(BUSY);
  takeLock(release);
  try {
    closeDb(release);
    const db = join(DOCS_DIR, `${release}.db`);
    for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.building`]) rmSync(f, { force: true });
    rmSync(join(REPOS_DIR, release), { recursive: true, force: true });
  } finally { releaseLock(); }
}

// `notify` carries a job while one runs (the page shows its progress) and nothing when a check is over (the page
// reloads what's on this machine and the check's result).
export type Notify = (detail: { job?: DocsJob }) => void;
export async function autoUpdateDocs(selected: () => Promise<string | null>, notify: Notify, repo = DOCS_REPO): Promise<DocsAuto> {
  const result: DocsAuto = { at: Date.now(), actions: [] };
  try {
    if (localReleases().length) {   // the opt-in; also saves the daily ls-remote
      const heads = await upstreamHeads(repo);
      const want = (await selected())?.trim().toLowerCase() || null;
      for (const a of docsPlan(localInfo(), heads, want)) {
        if (a.action === 'remove') removeRelease(a.release);
        else {
          const job = await runDocsJob({ release: a.release, update: a.action === 'update', repo }, (j) => notify({ job: j })).done;
          if (job.state === 'failed') throw new Error(`${a.release}: ${job.detail}`);
        }
        result.actions.push(a);
      }
    }
  } catch (e) {
    result.error = redact((e as Error).message);
  }
  lastAuto = result;
  notify({});
  return result;
}

export function startDocsAutoUpdate(selected: () => Promise<string | null>, notify: Notify) {
  const tick = () => autoUpdateDocs(selected, notify).then((r) => {
    if (r.error) console.error('docs auto-update:', r.error);
    else if (r.actions.length) console.log('docs auto-update:', r.actions.map((a) => `${a.action}d ${a.release}`).join(', '));
  });
  setTimeout(tick, 120_000);
  setInterval(tick, 24 * 3_600_000);
}

// ---------- the docs tool ----------


const out = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true });
function open(release: string) {
  const r = release.trim().toLowerCase();
  const have = localReleases();
  if (!have.includes(r)) throw new Error(`The ${r} docs aren't on this machine. Available: ${have.join(', ') || 'none'}.`);
  return lazyDb(r);
}
const guard = <A,>(fn: (a: A) => unknown) => async (a: A) => { try { return out(fn(a)); } catch (e) { return err((e as Error).message); } };

// Named "sndocs" so the tools keep the names a remote docs server has (mcp__sndocs__search_docs, ...).
export function localDocsServer() {
  return createSdkMcpServer({
    name: 'sndocs',
    version: '1.0.0',
    tools: [
      tool('list_releases', 'Release families whose docs are on this machine, with page counts and index dates.', {},
        guard(() => ({ releases: localInfo().map(({ bytes: _b, ...r }) => r) }))),
      tool('search_docs', 'Keyword search of the official ServiceNow docs for one release. Returns matching sections with title, breadcrumb, canonical_url and text. product filters by product or publication name (e.g. "Incident Management", "it-service-management"); topic_type is concept, task or reference.',
        { query: z.string(), release: z.string(), product: z.string().optional(), topic_type: z.string().optional(), limit: z.number().optional() },
        guard((a) => ({ release: a.release, results: search(open(a.release), a.query, a) }))),
      tool('get_doc', 'Full text of one docs page, by repo path (markdown/...) or canonical_url.', { ref: z.string(), release: z.string() },
        guard((a) => getDoc(open(a.release), a.ref) ?? { error: `no doc ${JSON.stringify(a.ref)} in ${a.release}` })),
      tool('list_products', 'Publications (top-level product areas) in a release, with page counts.', { release: z.string() },
        guard((a) => ({ release: a.release, publications: listProducts(open(a.release)) }))),
      tool('browse', 'List pages (title, path, topic_type) in one publication, optionally filtered by title text.',
        { release: z.string(), publication: z.string(), contains: z.string().optional(), limit: z.number().optional() },
        guard((a) => ({ release: a.release, publication: a.publication, docs: browse(open(a.release), a.publication, a.contains, a.limit) }))),
      tool('whats_changed', 'Combined upgrade release notes between two families (e.g. zurich -> brazil), from the newer release\'s docs. Without product, lists the products that have notes; with product, returns that product\'s notes.',
        { from_release: z.string(), to_release: z.string(), product: z.string().optional() },
        guard((a) => whatsChanged(open(a.to_release), a.from_release, a.to_release, a.product))),
    ],
  });
}
