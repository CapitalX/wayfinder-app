import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoUpdateDocs, docsPlan, headsOf, localInfo, localReleases, setupDocs, type DocsJob } from '../src/server/docsLocal.ts';

// The daily check that keeps the local docs current: what it decides (pure), and one run against a stand-in docs
// repository on disk (release branches brazil and later calgary), so no network.
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

describe('upstream heads', () => {
  it('reads branch heads from ls-remote and ignores anything else', () => {
    expect(headsOf(`${A}\trefs/heads/brazil\n${B}\trefs/heads/feature/x\n${C}\trefs/tags/v1\nwarning: redirecting\n${'z'.repeat(40)}\trefs/heads/zurich\n`)).toEqual({ brazil: A, 'feature/x': B });
  });
});

describe('the plan', () => {
  it.each([
    ['nothing local (docs never set up): nothing, whatever is upstream', [], { brazil: A, calgary: C }, 'brazil', []],
    ['local at the upstream commit, newest and selected: nothing', [{ release: 'brazil', commit: A }], { brazil: A }, 'brazil', []],
    ['upstream moved: update', [{ release: 'brazil', commit: A }], { brazil: B }, null, [{ release: 'brazil', action: 'update' }]],
    ['no commit recorded (an older index): update', [{ release: 'brazil' }], { brazil: A }, null, [{ release: 'brazil', action: 'update' }]],
    ['a newer release published: download it, then remove the old one', [{ release: 'brazil', commit: A }], { brazil: A, calgary: C }, null, [{ release: 'calgary', action: 'download' }, { release: 'brazil', action: 'remove' }]],
    ['the old one is selected: download the newest, keep both', [{ release: 'brazil', commit: A }], { brazil: A, calgary: C }, 'brazil', [{ release: 'calgary', action: 'download' }]],
    ['the selected one is published and not here: download it too', [{ release: 'calgary', commit: C }], { zurich: A, brazil: B, calgary: C }, 'zurich', [{ release: 'zurich', action: 'download' }]],
    ['the selected one is not published: keep what is here for it', [{ release: 'xanadu', commit: A }, { release: 'brazil', commit: B }], { brazil: B }, 'xanadu', []],
    ['a name that is a branch but no release is not a selection', [{ release: 'brazil', commit: A }], { brazil: A, main: C }, 'main', []],
    ['everything at once: updates, downloads, then removals', [{ release: 'zurich', commit: A }, { release: 'australia', commit: A }, { release: 'brazil', commit: A }], { zurich: A, australia: A, brazil: B, calgary: C }, 'australia',
      [{ release: 'brazil', action: 'update' }, { release: 'calgary', action: 'download' }, { release: 'zurich', action: 'remove' }, { release: 'brazil', action: 'remove' }]],
    ['release names wrap the alphabet: zurich is older than australia', [{ release: 'zurich', commit: A }], { zurich: A, australia: B }, null, [{ release: 'australia', action: 'download' }, { release: 'zurich', action: 'remove' }]],
    ['no release upstream at all (an odd answer): nothing is removed', [{ release: 'brazil', commit: A }], {}, null, []],
    ['only non-release branches upstream: nothing is removed', [{ release: 'brazil', commit: A }], { main: A, mobile: B }, null, []],
  ])('%s', (_name, local, upstream, want, plan) => {
    expect(docsPlan(local, upstream, want)).toEqual(plan);
  });
});

describe('a daily run', () => {
  let upstream: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: upstream, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  const write = (rel: string, body: string) => { mkdirSync(join(upstream, rel, '..'), { recursive: true }); writeFileSync(join(upstream, rel), `---\ntitle: ${rel}\ncanonical_url: https://www.servicenow.com/docs/r/${rel}\n---\n\n# Page\n\n${body}\n`); };
  const events: { job?: DocsJob }[] = [];
  const notify = (d: { job?: DocsJob }) => events.push(d);
  const run = (want: string | null) => autoUpdateDocs(async () => want, notify, `file://${upstream}`);

  beforeAll(() => {
    upstream = mkdtempSync(join(tmpdir(), 'wayfinder-docs-auto-'));
    git('init', '-q', '-b', 'brazil');
    write('markdown/itsm/sla.md', 'The timer pauses.');
    git('add', 'markdown/itsm/sla.md'); git('commit', '-q', '-m', 'docs');
  });

  it('does nothing until docs were set up once (no network either)', async () => {
    const r = await autoUpdateDocs(async () => 'brazil', notify, 'file:///nonexistent/docs.git');
    expect(r).toMatchObject({ actions: [] });
    expect(r.error).toBeUndefined();
    expect(localReleases()).toEqual([]);
    expect(events).toEqual([{}]);   // the page is told the check is over
  });

  it('leaves docs at the upstream commit alone', async () => {
    await setupDocs({ repo: `file://${upstream}`, release: 'brazil' });
    events.length = 0;
    expect(await run('brazil')).toMatchObject({ actions: [] });
    expect(events).toEqual([{}]);
  });

  it('re-indexes a release whose branch moved, with progress for the page', async () => {
    write('markdown/itsm/sla.md', 'The timer pauses and resumes.');
    git('commit', '-q', '-am', 'change');
    events.length = 0;
    expect(await run(null)).toMatchObject({ actions: [{ release: 'brazil', action: 'update' }] });
    expect(localInfo()[0].commit).toBe(git('rev-parse', 'HEAD').toString().trim());
    expect(events.at(-2)?.job).toMatchObject({ state: 'done', release: 'brazil' });
    expect(events.at(-1)).toEqual({});
  });

  it('a download that fails stops the run before any removal, and says so', async () => {
    git('checkout', '-q', '-b', 'calgary');
    write('markdown/itsm/new.md', 'New in Calgary.');
    git('add', 'markdown/itsm/new.md'); git('commit', '-q', '-m', 'calgary');
    git('checkout', '-q', 'brazil');
    // A folder where the new index would be written makes that setup fail after the clone.
    const docs = join(process.env.WAYFINDER_DATA_DIR!, 'docs');
    mkdirSync(join(docs, 'calgary.db.building'));
    const r = await run(null);   // the plan: download calgary, then remove brazil
    expect(r.actions).toEqual([]);
    expect(r.error).toMatch(/^calgary: /);
    expect(localReleases()).toEqual(['brazil']);
    expect(existsSync(join(docs, 'brazil.db'))).toBe(true);
    rmSync(join(docs, 'calgary.db.building'), { recursive: true });
  });

  it('downloads the newest release once ServiceNow publishes it, keeping the selected one', async () => {
    expect(await run('Brazil')).toMatchObject({ actions: [{ release: 'calgary', action: 'download' }] });
    expect(localReleases()).toEqual(['brazil', 'calgary']);
    expect(await run('brazil')).toMatchObject({ actions: [] });
  });

  it('removes a release that is neither the newest nor selected, index and download both', async () => {
    const docs = join(process.env.WAYFINDER_DATA_DIR!, 'docs');
    expect(existsSync(join(docs, 'brazil.db'))).toBe(true);
    expect(await run(null)).toMatchObject({ actions: [{ release: 'brazil', action: 'remove' }] });
    expect(localReleases()).toEqual(['calgary']);
    expect(readdirSync(docs).filter((f) => f.startsWith('brazil'))).toEqual([]);
    expect(existsSync(join(docs, 'repos', 'brazil'))).toBe(false);
    expect(existsSync(join(docs, 'repos', 'calgary'))).toBe(true);
    expect(await run(null)).toMatchObject({ actions: [] });
  });

  it('reports a repository it cannot reach instead of throwing', async () => {
    const r = await autoUpdateDocs(async () => null, notify, 'file:///nonexistent/docs.git');
    expect(r.actions).toEqual([]);
    expect(r.error).toMatch(/Couldn't reach the docs repository/);
  });
});
