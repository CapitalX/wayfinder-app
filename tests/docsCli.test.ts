import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `wayfinder docs ...` runs src/server/docsCli.ts with the app's Node and tsx. These run it as a separate process,
// with its own empty data folder and a stand-in docs repository (release branch brazil), so no network.
let env: NodeJS.ProcessEnv;
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/docsCli.ts', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'wayfinder-docscli-'));
  const repo = join(dir, 'upstream');
  mkdirSync(join(repo, 'markdown', 'itsm'), { recursive: true });
  writeFileSync(join(repo, 'markdown', 'itsm', 'sla-timer.md'), '---\ntitle: SLA timer\ncanonical_url: https://www.servicenow.com/docs/r/itsm/sla-timer.html\n---\n\n# SLA timer\n\nThe timer pauses.\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  for (const args of [['init', '-q', '-b', 'brazil'], ['add', 'markdown/itsm/sla-timer.md'], ['commit', '-q', '-m', 'docs']]) execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: 'ignore' });
  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WAYFINDER_') && !k.startsWith('SNW_'))),
    WAYFINDER_DATA_DIR: join(dir, 'data'), WAYFINDER_CONFIG_DIR: join(dir, 'config'), SNDOCS_TOKEN_FILE: join(dir, 'no-token'),
    WAYFINDER_DOCS_REPO: `file://${repo}`,
  };
});

describe('wayfinder docs', () => {
  it('status with nothing set up says how to set it up', () => {
    const r = cli('status');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/No local docs yet\. Set them up with: wayfinder docs setup/);
  });

  it('update with nothing set up fails with exit 1 and says what to run', () => {
    const r = cli('update');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/No docs are set up yet\. Run: wayfinder docs setup/);
  });

  it('setup with a release that does not exist fails with exit 1 and lists the ones that do', () => {
    const r = cli('setup', '--release', 'washington');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/There are no docs for "washington"\. Available: brazil\./);
  });

  it('setup picks the release, indexes it and says it is ready; status and update then report on it', () => {
    const s = cli('setup', '--instance', 'zurich'); // the instance's release isn't published: the newest is used
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/Downloading the docs: brazil/);
    expect(s.out).toMatch(/The brazil docs are ready/);
    const st = cli('status');
    expect(st.code).toBe(0);
    expect(st.out).toMatch(/^brazil: 1 pages, indexed \d{4}-\d\d-\d\dT/m);
    const u = cli('update');
    expect(u.code).toBe(0);
    expect(u.out).toMatch(/Updated brazil: 0 pages changed, 0 removed\./);
  });

  it('refuses an unknown command with usage and exit 2', () => {
    const r = cli('frobnicate');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage: wayfinder docs setup \[--release <family>\] \| update \| status/);
  });
});
