import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeProblem } from '../src/server/nodeCheck.ts';
import { envVar, ownerOnly } from '../src/server/config.ts';

afterEach(() => vi.unstubAllEnvs());

describe('Node version check', () => {
  it.each(['22.13.0', '22.20.1', '23.4.0', '24.0.0', '25.2.1'])('accepts %s', (v) => expect(nodeProblem(v)).toBeNull());
  it.each(['20.18.0', '22.5.1', '22.12.0', '23.3.0'])('refuses %s with a plain message', (v) => {
    expect(nodeProblem(v)).toBe(`Wayfinder needs Node 22.13 or newer; you have ${v}. Install the current Node 22 LTS from https://nodejs.org (or with your package manager, nvm or Homebrew), then start Wayfinder again.`);
  });
  it('passes on the Node running these tests (they use node:sqlite)', () => expect(nodeProblem()).toBeNull());
});

describe('settings from the environment', () => {
  it('reads WAYFINDER_ first and still honours the old SNW_ name', () => {
    vi.stubEnv('WAYFINDER_PORT', ''); vi.stubEnv('SNW_PORT', '9001');
    delete process.env.WAYFINDER_PORT;
    expect(envVar('PORT')).toBe('9001');
    vi.stubEnv('WAYFINDER_PORT', '9002');
    expect(envVar('PORT')).toBe('9002');
  });
});

describe('public default folders', () => {
  it('creates only Wayfinder folders and leaves unrelated data alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'wf-home-')), other = join(home, 'unrelated-data');
    mkdirSync(other); writeFileSync(join(other, 'workbench.db'), 'keep');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    for (const name of ['WAYFINDER_DATA_DIR', 'WAYFINDER_CONFIG_DIR', 'SNW_DATA_DIR', 'SNW_CONFIG_DIR']) delete env[name];
    const paths = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import { DATA_DIR, CONFIG_DIR } from './src/server/config.ts'; console.log(JSON.stringify([DATA_DIR, CONFIG_DIR]));",
    ], { env, encoding: 'utf8' }));
    expect(paths).toEqual([join(home, 'wayfinder-data'), join(home, '.config', 'wayfinder')]);
    for (const path of paths) expect(statSync(path).isDirectory()).toBe(true);
    expect(lstatSync(other).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(other, 'workbench.db'), 'utf8')).toBe('keep');
  });
});

describe('private data and config folders', () => {
  const mode = (d: string) => statSync(d).mode & 0o777;
  const quiet = () => {};

  it('creates a missing folder as 0700, whatever the umask', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'wf-perm-')), 'wayfinder-data');
    const old = process.umask(0o002);
    try { ownerOnly(d, quiet); } finally { process.umask(old); }
    expect(mode(d)).toBe(0o700);
  });

  it('tightens a folder an older version left at 0775, and says so', () => {
    const d = mkdtempSync(join(tmpdir(), 'wf-perm-'));
    chmodSync(d, 0o775);
    const said: string[] = [];
    ownerOnly(d, (m) => said.push(m));
    expect(mode(d)).toBe(0o700);
    expect(said[0]).toContain('was 775, now 700');
  });

  it('leaves a private folder alone, quietly', () => {
    const d = mkdtempSync(join(tmpdir(), 'wf-perm-'));
    chmodSync(d, 0o700);
    const said: string[] = [];
    ownerOnly(d, (m) => said.push(m));
    expect(mode(d)).toBe(0o700);
    expect(said).toEqual([]);
  });
});
