import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/server/config.ts';
import { buildScratch, command, ensureSdk, run } from '../src/server/buildTools.ts';
import { readSheet, sheetFiles } from '../src/server/fluentCheck.ts';
import { checkSheet, sheetAddendum, sheetHealth } from '../src/server/fluentReview.ts';
import { BUNDLED_SDK, SDK_BIN, SDK_DIR, activateSdk, bundledSdk, holdSdk, installedRoot, reconcileSdk, sdkRoot, sdkWhenIdle } from '../src/server/sdkRoot.ts';
import { checkSdkUpdate, restoreSdkHealth, sdkDecision, sdkOffer, sdkState, startSdkAutoUpdate, startSdkInstall } from '../src/server/sdkUpdates.ts';

const bundled = bundledSdk(), major = bundled.version.split('.')[0];
const version = `${major}.100.0`, newer = `${major}.101.0`;
const DAY = 24 * 3_600_000, now = Date.parse('2026-10-20T00:00:00Z');
const metadata = (v = version, age = 7 * DAY) => ({ 'dist-tags': { latest: v }, time: { [v]: new Date(now - age).toISOString() }, versions: { [v]: { dist: { unpackedSize: 1234 } } } });
function installFiles(v: string) {
  const path = installedRoot(v);
  for (const name of ['sdk', 'sdk-api']) {
    const dir = join(path, '@servicenow', name);
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: v }));
  }
  mkdirSync(join(path, '@servicenow/sdk/bin'), { recursive: true });
  writeFileSync(join(path, '@servicenow/sdk/bin/index.js'), '');
  mkdirSync(join(path, '.bin'), { recursive: true });
  symlinkSync('../@servicenow/sdk/bin/index.js', join(path, '.bin/now-sdk'));
  return { version: v, path };
}
const fakeRegistry = (v = version) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(metadata(v, now - Date.parse('2026-01-01')))));
const notify = vi.fn();
const passing = vi.fn(async () => ({ ok: true, errors: [] }));
const failing = vi.fn(async () => ({ ok: false, errors: [{ file: 'src/fluent/tables.now.ts', message: 'Unknown column' }] }));
const fakeNpm = vi.fn<typeof run>(async (_cmd, args, opts) => {
  installFiles(args[1].split('@').at(-1)!);
  return { code: 0, out: '' };
});
async function offer(v = version) { await checkSdkUpdate(notify, fakeRegistry(v)); }
beforeEach(() => {
  rmSync(SDK_DIR, { recursive: true, force: true });
  Object.assign(sheetHealth, { sdk: bundled.version, verified: 'not needed', errors: [], at: null });
  vi.clearAllMocks();
});
afterEach(async () => {
  const pending = sdkState(true).job;
  if (pending?.state === 'needs decision') await sdkDecision('keep', pending.version, notify);
  vi.useRealTimers();
});

describe('eligible registry offers', () => {
  it('offers a newer same-major version exactly seven days old, using metadata only', () => {
    expect(sdkOffer(metadata(), bundled.version, bundled.version, now)).toEqual({ version, published: metadata().time[version], bytes: 1234 });
  });
  it.each([
    ['already active', version, version, 8 * DAY],
    ['older', version, newer, 8 * DAY],
    ['new major', `${Number(major) + 1}.0.0`, bundled.version, 8 * DAY],
    ['too young', version, bundled.version, 7 * DAY - 1],
    ['future timestamp', version, bundled.version, -DAY],
    ['prerelease', `${version}-beta.1`, bundled.version, 8 * DAY],
    ['path input', '../outside', bundled.version, 8 * DAY],
  ])('hides %s', (_label, v, active, age) => expect(sdkOffer(metadata(v, age), active, bundled.version, now)).toBeNull());
  it('hides missing or malformed metadata and publication dates', () => {
    for (const m of [{}, { 'dist-tags': { latest: version } }, { ...metadata(), time: { [version]: 'bad date' } }])
      expect(sdkOffer(m, bundled.version, bundled.version, now)).toBeNull();
  });
  it('fetches only SDK registry metadata, clears stale offers offline, and announces both', async () => {
    const registry = fakeRegistry();
    await checkSdkUpdate(notify, registry);
    expect(registry).toHaveBeenCalledTimes(1);
    expect(registry.mock.calls[0][0]).toBe('https://registry.npmjs.org/@servicenow%2fsdk');
    expect(sdkState(true).offer?.version).toBe(version);
    expect(await checkSdkUpdate(notify, vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')))).toBeNull();
    expect(sdkState(true).offer).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(existsSync(SDK_DIR)).toBe(false);
  });
  it('checks daily and shortly after startup without downloading', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry(); vi.stubGlobal('fetch', registry);
    try {
      startSdkAutoUpdate(notify);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(registry).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DAY - 120_000);
      expect(registry).toHaveBeenCalledTimes(2);
      expect(fakeNpm).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.unstubAllGlobals(); }
  });
});

describe('one SDK root', () => {
  it('uses the bundled SDK by default and a complete installed SDK when selected', () => {
    expect(sdkRoot()).toMatchObject({ ...bundled, source: 'bundled' });
    ensureSdk();
    const candidate = installFiles(version); activateSdk(candidate);
    ensureSdk();
    expect(readlinkSync(join(DATA_DIR, 'apps/node_modules'))).toBe(candidate.path);
    expect(sdkRoot()).toMatchObject({ ...candidate, source: 'updated in app', previous: bundled });
    expect(SDK_BIN()).toBe(join(candidate.path, '.bin/now-sdk'));
  });
  it('falls back with a doctor warning when a selected SDK is broken or missing', () => {
    const candidate = installFiles(version); activateSdk(candidate);
    rmSync(join(candidate.path, '@servicenow/sdk-api/package.json'));
    expect(sdkRoot()).toMatchObject({ ...bundled, source: 'bundled', warning: expect.stringMatching(/incomplete/) });
    rmSync(join(SDK_DIR, version), { recursive: true });
    expect(sdkRoot().warning).toMatch(/missing/);
    const doctor = execFileSync(process.execPath, ['--import', 'tsx', 'src/server/sdkDoctor.ts'], { encoding: 'utf8' });
    expect(doctor).toMatch(/warn.*using the bundled SDK/);
  });
  it('does not accept paths outside the SDK store, symlink roots, or unreadable selections', () => {
    const candidate = installFiles(version);
    writeFileSync(join(SDK_DIR, 'active.json'), JSON.stringify({ version, path: BUNDLED_SDK }));
    expect(sdkRoot().source).toBe('bundled');
    rmSync(candidate.path, { recursive: true }); symlinkSync(BUNDLED_SDK, candidate.path, 'dir');
    writeFileSync(join(SDK_DIR, 'active.json'), JSON.stringify(candidate));
    expect(sdkRoot().source).toBe('bundled');
    writeFileSync(join(SDK_DIR, 'active.json'), '{');
    expect(sdkRoot().warning).toMatch(/unreadable/);
  });
  it.each([bundled.version, `${major}.0.0`])('bundled wins and cleans installed SDKs at %s after a Wayfinder update', (v) => {
    const candidate = installFiles(v); activateSdk(candidate);
    expect(sdkRoot().source).toBe('bundled');
    reconcileSdk();
    expect(existsSync(join(SDK_DIR, v))).toBe(false);
    expect(existsSync(join(SDK_DIR, 'active.json'))).toBe(false);
  });
  it('never switches or deletes a running SDK; switches as soon as its lease ends', async () => {
    const candidate = installFiles(version), release = holdSdk();
    expect(() => activateSdk(candidate)).toThrow(/running/);
    let switched = false;
    const done = sdkWhenIdle(() => { activateSdk(candidate); switched = true; });
    expect(switched).toBe(false); expect(sdkRoot().version).toBe(bundled.version);
    release(); await done; release();
    expect(sdkRoot().version).toBe(version);
  });
});

describe('install and cheat sheet gate', () => {
  it('does not let a late startup check overwrite the new active SDK health', async () => {
    let finish!: (value: { ok: boolean; errors: { message: string }[] }) => void;
    const oldCheck = checkSheet(() => new Promise((resolve) => { finish = resolve; }), true);
    activateSdk(installFiles(version));
    Object.assign(sheetHealth, { sdk: version, verified: 'yes', errors: [] });
    finish({ ok: false, errors: [{ message: 'old SDK error' }] }); await oldCheck;
    expect(sheetHealth).toMatchObject({ sdk: version, verified: 'yes', errors: [] });
  });
  it('executes a fake npm with the real process runner and no inherited credentials or npm config', async () => {
    await offer(); mkdirSync(SDK_DIR, { recursive: true });
    const script = join(SDK_DIR, 'fake-npm.cjs');
    writeFileSync(script, `const fs = require('node:fs'), path = require('node:path');
      if (process.env.NPM_TOKEN || process.env.SN_SDK_PASSWORD || process.env.ANTHROPIC_API_KEY) process.exit(3);
      const args = process.argv.slice(2), version = args[1].split('@').at(-1);
      if (!args.includes('--ignore-scripts') || !args.includes('--save-exact') || args[2] !== '@servicenow/sdk-api@' + version) process.exit(4);
      fs.writeFileSync('child-env.json', JSON.stringify(process.env));
      for (const name of ['sdk', 'sdk-api']) {
        const dir = path.join('node_modules/@servicenow', name);
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
      }
      fs.mkdirSync('node_modules/@servicenow/sdk/bin', { recursive: true });
      fs.writeFileSync('node_modules/@servicenow/sdk/bin/index.js', '');
      fs.mkdirSync('node_modules/.bin', { recursive: true });
      fs.symlinkSync('../@servicenow/sdk/bin/index.js', 'node_modules/.bin/now-sdk');`);
    const npm: typeof run = (_cmd, args, opts) => run(process.execPath, [script, ...args], opts);
    process.env.NPM_TOKEN = 'test-token'; process.env.SN_SDK_PASSWORD = 'test-password';
    try {
      expect(await startSdkInstall(version, notify, npm, passing).done).toMatchObject({ state: 'done' });
      const env = JSON.parse(readFileSync(join(SDK_DIR, version, 'child-env.json'), 'utf8'));
      expect(env.HOME).toBe(join(SDK_DIR, version, '.home'));
      expect(env.NPM_TOKEN).toBeUndefined(); expect(env.SN_SDK_PASSWORD).toBeUndefined();
    } finally { delete process.env.NPM_TOKEN; delete process.env.SN_SDK_PASSWORD; }
  });
  it('waits for a running build before automatically activating a passing candidate', async () => {
    await offer();
    const release = holdSdk();
    const install = startSdkInstall(version, notify, fakeNpm, passing);
    try {
      await vi.waitFor(() => expect(install.job.step).toBe('Waiting for builds to finish'));
      expect(sdkRoot().version).toBe(bundled.version);
    } finally { release(); }
    expect(await install.done).toMatchObject({ state: 'done' });
    expect(sdkRoot().version).toBe(version);
  });
  it('refuses another process lock and recovers a dead process lock', async () => {
    await offer(); mkdirSync(SDK_DIR, { recursive: true });
    writeFileSync(join(SDK_DIR, '.install.lock'), String(process.ppid));
    expect(() => startSdkInstall(version, notify, fakeNpm, passing)).toThrow(/already running/);
    writeFileSync(join(SDK_DIR, '.install.lock'), '2147483647');
    expect(await startSdkInstall(version, notify, fakeNpm, passing).done).toMatchObject({ state: 'done' });
    expect(existsSync(join(SDK_DIR, '.install.lock'))).toBe(false);
  });
  it('runs the shared scratch build with the candidate binary and modules, inside its own SDK folder', async () => {
    const candidate = installFiles(version), entry = join(candidate.path, '@servicenow/sdk/bin/index.js');
    writeFileSync(entry, '#!/usr/bin/env node\nconst fs = require("node:fs"); const path = require("node:path"); if (fs.realpathSync("node_modules") !== path.resolve(__dirname, "../../..")) process.exit(2); console.log("[now-sdk] Build completed successfully");');
    chmodSync(entry, 0o755);
    expect(await buildScratch(sheetFiles(readSheet()), candidate.path)).toMatchObject({ ok: true });
    expect(sdkRoot().version).toBe(bundled.version);
    writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("[now-sdk] ERROR: src/fluent/tables.now.ts:1:1 - error TS123: Bad example"); process.exit(1);');
    const result = await buildScratch(sheetFiles(readSheet()), candidate.path);
    expect(result).toMatchObject({ ok: false, errors: [{ file: 'src/fluent/tables.now.ts', message: 'Bad example' }] });
    expect(readdirSync(join(SDK_DIR, version, '.checks'))).toEqual([]);
  });
  it('installs exact SDK and API versions with scripts off, integrity on, clean env and writes confined to the store', async () => {
    await offer();
    const before = readdirSync(DATA_DIR);
    process.env.NPM_TOKEN = 'must-not-reach-child'; process.env.SN_SDK_PASSWORD = 'must-not-reach-child';
    try {
      const started = startSdkInstall(version, notify, fakeNpm, passing);
      expect(() => startSdkInstall(version, notify, fakeNpm, passing)).toThrow(/already running/);
      expect(await started.done).toMatchObject({ state: 'done', step: 'Done' });
      const [cmd, args, opts] = fakeNpm.mock.calls[0];
      expect(cmd).toBe('npm');
      expect(args).toEqual(expect.arrayContaining([`@servicenow/sdk@${version}`, `@servicenow/sdk-api@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact']));
      expect(args.join(' ')).not.toMatch(/ignore-integrity|force|legacy-peer/);
      expect(opts).toMatchObject({ cwd: join(SDK_DIR, version), write: [join(SDK_DIR, version)], net: true, home: join(SDK_DIR, version, '.home') });
      const child = command(cmd, args, opts, false);
      expect(child.env.HOME).toBe(opts.home);
      expect(JSON.stringify(child.env)).not.toMatch(/must-not-reach-child|ANTHROPIC|NPM_TOKEN|SN_SDK_PASSWORD/);
      const sandbox = command(cmd, args, opts, true);
      expect(sandbox.args).toContain('--share-net');
      expect(JSON.stringify(sandbox)).not.toContain('must-not-reach-child');
      expect(passing).toHaveBeenCalledWith(sheetFiles(readSheet()), installedRoot(version));
      expect(sdkRoot().version).toBe(version);
      expect(sheetHealth.verified).toBe('yes');
      const pkg = JSON.parse(readFileSync(join(SDK_DIR, version, 'package.json'), 'utf8'));
      expect(pkg.overrides['@servicenow/sdk-cli']).toEqual({ undici: '7.30.1' });
      expect(pkg.overrides['@servicenow/isomorphic-rollup']).toEqual({ joi: '17.13.9' });
      expect(pkg.overrides.zod).not.toContain('$');
      expect(readdirSync(DATA_DIR).filter((p) => !before.includes(p) && p !== 'sdk')).toEqual([]);
    } finally { delete process.env.NPM_TOKEN; delete process.env.SN_SDK_PASSWORD; }
  });
  it('keeps the current SDK on failure, returns examples, and uses the existing warning only after Use anyway', async () => {
    await offer();
    expect(await startSdkInstall(version, notify, fakeNpm, failing).done).toMatchObject({ state: 'needs decision', errors: ['src/fluent/tables.now.ts: Unknown column'] });
    expect(sdkRoot().version).toBe(bundled.version);
    expect(sheetAddendum()).not.toMatch(/Warning: some cheat sheet/);
    expect(() => startSdkInstall(version, notify, fakeNpm, passing)).toThrow(/Keep current/);
    await expect(sdkDecision('use', '../outside', notify)).rejects.toThrow(/no failed check/);
    await sdkDecision('use', version, notify);
    expect(sdkRoot().version).toBe(version);
    expect(sheetAddendum()).toContain(`installed SDK ${version}`);
    restoreSdkHealth();
    expect(sheetHealth.verified).toBe('no');
    await sdkDecision('back', bundled.version, notify);
    expect(sdkRoot().version).toBe(bundled.version);
    expect(sdkRoot().warning).toBeUndefined();
    expect(sheetAddendum()).not.toMatch(/Warning: some cheat sheet/);
  });
  it('Keep current discards a failed candidate', async () => {
    await offer(); await startSdkInstall(version, notify, fakeNpm, failing).done;
    await sdkDecision('keep', version, notify);
    expect(sdkRoot().version).toBe(bundled.version);
    expect(existsSync(join(SDK_DIR, version))).toBe(false);
  });
  it('restores a previous user-installed SDK, and keeps only active and previous versions', async () => {
    await offer(); await startSdkInstall(version, notify, fakeNpm, passing).done;
    await offer(newer); await startSdkInstall(newer, notify, fakeNpm, passing).done;
    expect(sdkRoot().previous?.version).toBe(version);
    const newest = `${major}.102.0`;
    await offer(newest); await startSdkInstall(newest, notify, fakeNpm, passing).done;
    expect(existsSync(join(SDK_DIR, version))).toBe(false);
    expect(existsSync(join(SDK_DIR, newer))).toBe(true);
    await sdkDecision('back', newer, notify);
    expect(sdkRoot().version).toBe(newer);
  });
  it('failed npm installs keep the current SDK and clean the partial folder', async () => {
    await offer();
    const npm = vi.fn<typeof run>().mockResolvedValue({ code: 1, out: 'integrity mismatch' });
    expect(await startSdkInstall(version, notify, npm, passing).done).toMatchObject({ state: 'failed', errors: [expect.stringContaining('integrity mismatch')] });
    expect(sdkRoot().version).toBe(bundled.version);
    expect(existsSync(join(SDK_DIR, version))).toBe(false);
    expect(passing).not.toHaveBeenCalled();
    expect(await startSdkInstall(version, notify, fakeNpm, passing).done).toMatchObject({ state: 'done' });
  });
  it('rejects arbitrary installs and hides offers and controls from non-admins', async () => {
    await offer();
    expect(() => startSdkInstall('../outside', notify, fakeNpm, passing)).toThrow(/eligible/);
    expect(() => startSdkInstall(newer, notify, fakeNpm, passing)).toThrow(/eligible/);
    expect(sdkState(false)).toMatchObject({ version: bundled.version, admin: false, offer: null, previous: null, job: null });
  });
});
