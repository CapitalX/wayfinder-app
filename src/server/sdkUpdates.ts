import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildScratch, run } from './buildTools.ts';
import { checkSheet, sheetHealth } from './fluentReview.ts';
import { readSheet } from './fluentCheck.ts';
import { SDK_DIR, BUNDLED_SDK, activateSdk, bundledSdk, compareVersions, completeSdk, installedRoot, sdkRoot, sdkWhenIdle, validVersion, type SdkChoice } from './sdkRoot.ts';

const DAY = 24 * 3_600_000;
type Registry = { 'dist-tags'?: { latest?: string }; time?: Record<string, string>; versions?: Record<string, { dist?: { unpackedSize?: number } }> };
export interface SdkOffer { version: string; published: string; bytes: number | null }
export function sdkOffer(metadata: Registry, active: string, bundled: string, now = Date.now()): SdkOffer | null {
  const version = metadata?.['dist-tags']?.latest;
  if (!validVersion(version) || !validVersion(active) || !validVersion(bundled)
    || version.split('.')[0] !== bundled.split('.')[0] || compareVersions(version, active) <= 0) return null;
  const published = metadata.time?.[version], at = Date.parse(published ?? '');
  if (!published || !Number.isFinite(at) || now - at < 7 * DAY) return null;
  const bytes = metadata.versions?.[version]?.dist?.unpackedSize;
  return { version, published, bytes: typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : null };
}
let offer: SdkOffer | null = null;
let checkedAt: number | null = null;
let checking: Promise<SdkOffer | null> | null = null;
export interface SdkJob { version: string; state: 'running' | 'done' | 'failed' | 'needs decision'; step: string; errors: string[] }
let job: SdkJob | null = null;
type Notify = () => void;
export async function checkSdkUpdate(notify: Notify = () => {}, registry = fetch): Promise<SdkOffer | null> {
  if (checking) return checking;
  checking = (async () => {
    try {
      const res = await registry('https://registry.npmjs.org/@servicenow%2fsdk', { signal: AbortSignal.timeout(20_000), redirect: 'error' });
      if (!res.ok) throw new Error('Registry unavailable');
      offer = sdkOffer(await res.json() as Registry, sdkRoot().version, bundledSdk().version);
    } catch { offer = null; } // Offline checks never leave a stale offer behind.
    checkedAt = Date.now();
    notify();
    return offer;
  })();
  try { return await checking; } finally { checking = null; }
}
export function startSdkAutoUpdate(notify: Notify) {
  setTimeout(() => { void checkSdkUpdate(notify); }, 120_000);
  setInterval(() => { void checkSdkUpdate(notify); }, DAY);
}
const revision = () => createHash('sha256').update(readSheet()).digest('hex');
const checkFile = (version: string) => join(SDK_DIR, `check-${version}.json`);
function savedHealth(version: string): typeof sheetHealth | null {
  try {
    const saved = JSON.parse(readFileSync(checkFile(version), 'utf8'));
    return saved.revision === revision() && saved.health.sdk === version ? saved.health : null;
  } catch { return null; }
}
export function restoreSdkHealth() {
  const sdk = sdkRoot().version, saved = savedHealth(sdk);
  Object.assign(sheetHealth, saved ?? { sdk, verified: 'not needed', errors: [], at: null });
}
export function sdkState(admin: boolean) {
  const current = sdkRoot();
  if (sheetHealth.sdk !== current.version) restoreSdkHealth();
  return { version: current.version, source: current.source, warning: current.warning, health: sheetHealth, admin,
    previous: admin ? current.previous?.version ?? null : null, offer: admin && offer && compareVersions(offer.version, current.version) > 0 ? offer : null,
    job: admin ? job : null, checkedAt };
}

// The on-disk lock also excludes a second Wayfinder process sharing the data directory.
let holding = false;
function takeLock() {
  mkdirSync(SDK_DIR, { recursive: true });
  const file = join(SDK_DIR, '.install.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(file, String(process.pid), { flag: 'wx' }); holding = true; return; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let found: string;
    try { found = readFileSync(file, 'utf8'); } catch { continue; }
    const pid = Number(found);
    if (pid === process.pid ? holding : alive(pid)) throw new Error('An SDK update is already running.');
    // Rename before retrying, as in the docs lock; don't unlink a newly acquired lock.
    const aside = `${file}.${process.pid}.stale`;
    try { renameSync(file, aside); } catch { continue; }
    const moved = readFileSync(aside, 'utf8');
    rmSync(aside, { force: true });
    if (moved !== found) {
      try { writeFileSync(file, moved, { flag: 'wx' }); } catch { /* already reacquired */ }
      throw new Error('An SDK update is already running.');
    }
  }
  throw new Error('An SDK update is already running.');
}
function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
function discardCandidate(version: string) {
  const current = sdkRoot();
  if (current.version !== version && current.previous?.version !== version) rmSync(join(SDK_DIR, version), { recursive: true, force: true });
}
function releaseLock() { rmSync(join(SDK_DIR, '.install.lock'), { force: true }); holding = false; }
type Builder = typeof buildScratch;
export function startSdkInstall(version: string, notify: Notify, npm: typeof run = run, build: Builder = buildScratch) {
  if (!offer || version !== offer.version || !validVersion(version) || compareVersions(version, sdkRoot().version) <= 0)
    throw new Error('Check for an eligible SDK update first.');
  if (job?.state === 'needs decision') throw new Error('Choose Keep current or Use anyway first.');
  takeLock();
  const candidate: SdkChoice = { version, path: installedRoot(version) }, dir = join(SDK_DIR, version);
  job = { version, state: 'running', step: 'Downloading', errors: [] };
  const currentJob = job;
  const done = (async () => {
    try {
      writeFileSync(checkFile(sdkRoot().version), JSON.stringify({ revision: revision(), health: sheetHealth }));
      notify();
      if (!completeSdk(candidate)) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(join(dir, '.home'), { recursive: true });
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
        const overrides = { ...pkg.overrides, zod: JSON.parse(readFileSync(join(BUNDLED_SDK, 'zod/package.json'), 'utf8')).version };
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'wayfinder-sdk', private: true, overrides }));
        writeFileSync(join(dir, 'user.npmrc'), '');
        writeFileSync(join(dir, 'global.npmrc'), '');
        const result = await npm('npm', ['install', `@servicenow/sdk@${version}`, `@servicenow/sdk-api@${version}`,
          '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
          '--userconfig', join(dir, 'user.npmrc'), '--globalconfig', join(dir, 'global.npmrc'), '--cache', join(dir, '.cache')],
        { cwd: dir, write: [dir], net: true, home: join(dir, '.home'), sdkRoot: BUNDLED_SDK, timeoutMs: 15 * 60_000 });
        if (result.code !== 0) throw new Error(`Download failed: ${result.out.slice(-2000)}`);
        if (!completeSdk(candidate)) throw new Error('The downloaded SDK is incomplete.');
      }
      currentJob.step = 'Checking the cheat sheet'; notify();
      const health = await checkSheet((files) => build(files, candidate.path), true, candidate.path);
      writeFileSync(checkFile(version), JSON.stringify({ revision: revision(), health }));
      currentJob.errors = health.errors;
      if (health.verified === 'yes') {
        currentJob.step = 'Waiting for builds to finish'; notify();
        await sdkWhenIdle(() => { activateSdk(candidate); Object.assign(sheetHealth, health); offer = null; });
        currentJob.state = 'done'; currentJob.step = 'Done';
      } else { currentJob.state = 'needs decision'; currentJob.step = "Didn't pass"; }
    } catch (e) {
      currentJob.state = 'failed'; currentJob.step = 'Download or check failed'; currentJob.errors = [(e as Error).message];
      discardCandidate(version);
    } finally { releaseLock(); notify(); }
    return currentJob;
  })();
  return { job: currentJob, done };
}
export async function sdkDecision(action: 'keep' | 'use' | 'back', version: string, notify: Notify) {
  takeLock();
  try {
    if (action === 'back') {
      const previous = sdkRoot().previous;
      if (!previous || previous.version !== version) throw new Error('That previous SDK is no longer available.');
      await sdkWhenIdle(() => { activateSdk(previous); restoreSdkHealth(); });
      job = null;
    } else {
      if (job?.state !== 'needs decision' || job.version !== version) throw new Error('There is no failed check for that SDK.');
      if (action === 'use') {
        const health = savedHealth(version);
        if (!health) throw new Error('Check the cheat sheet again before switching.');
        await sdkWhenIdle(() => { activateSdk({ version, path: installedRoot(version) }); Object.assign(sheetHealth, health); offer = null; });
        job.state = 'done'; job.step = 'Done';
      } else { discardCandidate(version); job = null; offer = null; }
    }
  } finally { releaseLock(); notify(); }
}
