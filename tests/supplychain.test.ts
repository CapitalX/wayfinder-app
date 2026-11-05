import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const workflows = readdirSync(new URL('../.github/workflows', import.meta.url)).map((f) => `.github/workflows/${f}`);
const installers = ['ops/auto-deploy.sh', 'Dockerfile', 'README.md', 'docs/RUNBOOK.md', ...workflows];

describe('installs and CI actions', () => {
  it.each(workflows)('%s uses only GitHub-hosted Linux for every job', (p) => {
    const jobs = read(p).split('\n').filter((l) => /^    [\w-]+:$/.test(l));
    const runners = read(p).split('\n').filter((l) => /^\s*runs-on:/.test(l)).map((l) => l.trim());
    expect(runners).toHaveLength(jobs.length);
    expect(runners.length).toBeGreaterThan(0);
    expect(runners.every((l) => l === 'runs-on: ubuntu-latest')).toBe(true);
  });

  it.each(installers)('%s never runs dependency install scripts', (p) => {
    // Comments (whole-line or trailing) can mention npm ci; only commands count.
    const installs = read(p).split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).filter((l) => /\bnpm (ci|install|i)\b/.test(l) && !/--ignore-scripts/.test(l));
    expect(installs).toEqual([]);
  });

  it.each(workflows)('%s pins every action to a full commit', (p) => {
    const uses = read(p).split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}(\s+#.*)?$/);
  });
});
