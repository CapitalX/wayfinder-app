import { describe, expect, it, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunk, clean, parseDoc, redact } from '../src/server/docsIndex.ts';
import { docsJob, familiesOf, localDocsServer, localReleases, pickRelease, setupDocs, startDocsSetup } from '../src/server/docsLocal.ts';
import { docReleases, docsSource } from '../src/server/docs.ts';
import { setupState } from '../src/server/setup.ts';

// A tiny stand-in for ServiceNow's docs repository: markdown/<publication>/<page>.md on a release branch.
const page = (title: string, url: string, body: string, extra = '') =>
  `---\ntitle: ${title}\ndescription: About ${title}.\ncanonical_url: ${url}\nrelease: brazil\ntopic_type: concept\nlast_updated: "2026-09-10"\nbreadcrumb: [Overview, Service Level Management]\n${extra}---\n\n# ${title}\n\n${body}\n`;
const URL_SLA = 'https://www.servicenow.com/docs/r/it-service-management/sla-timer.html';
let upstream: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
function write(rel: string, text: string) { mkdirSync(join(upstream, rel, '..'), { recursive: true }); writeFileSync(join(upstream, rel), text); }

beforeAll(() => {
  upstream = mkdtempSync(join(tmpdir(), 'wayfinder-docs-upstream-'));
  git(upstream, 'init', '-q', '-b', 'brazil');
  write('markdown/it-service-management/sla-timer.md', page('SLA timer', URL_SLA, 'The SLA timer pauses when the pause condition matches, for example when the incident state is On Hold.\n\n## Pause conditions\n\nPause conditions are evaluated on every update of the task.'));
  write('markdown/it-service-management/index.md', page('IT Service Management', 'https://www.servicenow.com/docs/r/it-service-management/index.html', 'SLA timer pause condition incident on hold'));
  write('markdown/servicenow-platform/gliderecord.md', page('GlideRecord', 'https://www.servicenow.com/docs/r/api/gliderecord.html', 'Use addEncodedQuery to filter records with an encoded query string.'));
  write('markdown/delta-australia-brazil/sla-notes.md', page('Combined Service Level Management release notes', 'https://www.servicenow.com/docs/r/delta/sla.html', 'New in Brazil.'));
  write('README.md', 'not a doc');
  git(upstream, 'add', 'markdown/it-service-management/sla-timer.md', 'markdown/it-service-management/index.md', 'markdown/servicenow-platform/gliderecord.md', 'markdown/delta-australia-brazil/sla-notes.md', 'README.md');
  git(upstream, 'commit', '-q', '-m', 'docs');
  git(upstream, 'branch', 'feature/brazil');
  git(upstream, 'branch', 'main');
});

describe('parsing', () => {
  it('reads flat front matter: quotes, lists, escapes, empty values', () => {
    const { meta, body } = parseDoc("---\ntitle: 'Crawl' stage reports\nlast_updated: \"2026-09-10\"\nbreadcrumb: [An app's table, Administer]\ndescription: \nproduct: sn\\_cs\\_sm\n---\n\n# Hi\n\nText \\(com.sn\\_cs\\_sm\\).");
    expect(meta).toEqual({ title: "'Crawl' stage reports", last_updated: '2026-09-10', breadcrumb: "An app's table > Administer", product: 'sn_cs_sm' });
    expect(body).toBe('# Hi\n\nText (com.sn_cs_sm).');
  });
  it('turns HTML tables into pipe rows', () => {
    expect(clean('<table><tr><td>Role</td><td>Grants</td></tr><tr><td>itil</td><td>work</td></tr></table>')).toBe('Role | Grants |\nitil | work |');
  });
  it('chunks by heading path and splits long sections', () => {
    const parts = chunk(`# A\n\nintro\n\n## B\n\n${'word '.repeat(1000)}\n\n${'more '.repeat(400)}`);
    expect(parts[0]).toEqual({ heading: 'A', text: '# A\n\nintro' });
    expect(parts.slice(1).every((p) => p.heading === 'A > B' && p.text.length <= 3200)).toBe(true);
    expect(parts.length).toBeGreaterThan(2);
  });
});

describe('release choice', () => {
  const fams = familiesOf(['australia', 'brazil', 'feature/brazil', 'main', 'mobile', 'nofamily', 'other', 'store', 'xanadu', 'yokohama', 'zurich']);
  it('keeps families in release order, newest last', () => expect(fams).toEqual(['xanadu', 'yokohama', 'zurich', 'australia', 'brazil']));
  it('picks the asked one, else the instance\'s, else the newest', () => {
    expect(pickRelease(fams, 'Zurich', 'brazil')).toBe('zurich');
    expect(pickRelease(fams, null, 'australia')).toBe('australia');
    expect(pickRelease(fams, null, 'washington')).toBe('brazil');
    expect(() => pickRelease(fams, 'nope')).toThrow(/no docs for "nope"/);
  });
  it('treats a family it has never heard of as newer', () => expect(familiesOf(['brazil', 'canberra', 'zurich']).at(-1)).toBe('canberra'));
});

describe('local docs, end to end', () => {
  it('refuses on low disk before downloading anything', async () => {
    await expect(setupDocs({ repo: `file://${upstream}`, needBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/Not enough disk space/);
    expect(localReleases()).toEqual([]);
    expect(docsSource()).toBe(null);
  });

  it('sets up, searches with titles and links, and backs the docs tool', async () => {
    const steps: string[] = [];
    const r = await setupDocs({ repo: `file://${upstream}`, instance: 'washington', onProgress: (s) => steps.push(s) });
    expect(r).toMatchObject({ release: 'brazil', indexed: 4, removed: 0, total: 4 });
    expect(steps).toContain('Downloading the docs');
    expect(steps.at(-1)).toBe('Done');
    expect(localReleases()).toEqual(['brazil']);
    expect(docsSource()).toBe('local');
    expect(await docReleases()).toEqual(['brazil']);
    expect(setupState().extras).toMatchObject({ docs: true, docsSource: 'local' });

    const tools = (localDocsServer() as any).instance._registeredTools;
    const call = async (name: string, args: unknown) => JSON.parse((await tools[name].handler(args, {})).content[0].text);
    const found = await call('search_docs', { query: 'when does the SLA timer pause', release: 'brazil' });
    expect(found.results[0]).toMatchObject({ title: 'SLA timer', canonical_url: URL_SLA, breadcrumb: 'Overview > Service Level Management' });
    // listing pages match everything, so they're left out
    expect(found.results.some((h: any) => h.path.endsWith('/index.md'))).toBe(false);
    expect((await call('get_doc', { ref: URL_SLA, release: 'Brazil' })).title).toBe('SLA timer');
    expect((await call('get_doc', { ref: 'it-service-management/sla-timer.md', release: 'brazil' })).canonical_url).toBe(URL_SLA);
    expect((await call('whats_changed', { from_release: 'australia', to_release: 'brazil' })).products).toHaveLength(1);
    expect((await call('list_releases', {})).releases[0]).toMatchObject({ release: 'brazil', docs: 4 });
    expect((await call('list_products', { release: 'brazil' })).publications).toEqual([
      { publication: 'delta-australia-brazil', docs: 1 }, { publication: 'it-service-management', docs: 2 }, { publication: 'servicenow-platform', docs: 1 },
    ]);
    const itsm = await call('browse', { release: 'brazil', publication: 'it-service-management' });
    expect(itsm.docs.map((d: any) => d.title)).toEqual(['IT Service Management', 'SLA timer']);
    expect(itsm.docs[1]).toEqual({ title: 'SLA timer', path: 'markdown/it-service-management/sla-timer.md', topic_type: 'concept' });
    expect((await call('browse', { release: 'brazil', publication: 'it-service-management', contains: 'sla' })).docs.map((d: any) => d.title)).toEqual(['SLA timer']);
    expect((await call('browse', { release: 'brazil', publication: 'it-service-management', limit: 1 })).docs).toHaveLength(1);
    expect((await call('browse', { release: 'brazil', publication: 'nope' })).docs).toEqual([]);
    const missing = await tools.search_docs.handler({ query: 'x', release: 'zurich' }, {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/zurich docs aren't on this machine/);
  });

  it('updates only what changed upstream', async () => {
    write('markdown/servicenow-platform/gliderecord.md', page('GlideRecord', 'https://www.servicenow.com/docs/r/api/gliderecord.html', 'Use addQuery and addEncodedQuery.'));
    rmSync(join(upstream, 'markdown/delta-australia-brazil'), { recursive: true });
    git(upstream, 'add', 'markdown/servicenow-platform/gliderecord.md', 'markdown/delta-australia-brazil/sla-notes.md');
    git(upstream, 'commit', '-q', '-m', 'change');
    const r = await setupDocs({ repo: `file://${upstream}`, update: true });
    expect(r).toMatchObject({ release: 'brazil', indexed: 1, removed: 1, total: 3 });
    const tools = (localDocsServer() as any).instance._registeredTools;
    const hit = JSON.parse((await tools.search_docs.handler({ query: 'addQuery', release: 'brazil' }, {})).content[0].text);
    expect(hit.results[0].title).toBe('GlideRecord');
    expect(existsSync(join(process.env.WAYFINDER_DATA_DIR!, 'docs', 'brazil.db.building'))).toBe(false);
  });
});

describe('a third-party repo', () => {
  it('never indexes a symlink, so a link to a local file (like the keys file) stays out of the index', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'wayfinder-secret-')), 'secrets.json');
    writeFileSync(outside, '{"appToken": "zebracorn-secret-token"}');
    symlinkSync(outside, join(upstream, 'markdown/servicenow-platform/keys.md'));
    git(upstream, 'add', 'markdown/servicenow-platform/keys.md');
    git(upstream, 'commit', '-q', '-m', 'a link');
    const r = await setupDocs({ repo: `file://${upstream}`, update: true });
    expect(r.indexed).toBe(0);
    const tools = (localDocsServer() as any).instance._registeredTools;
    const hit = JSON.parse((await tools.search_docs.handler({ query: 'zebracorn', release: 'brazil' }, {})).content[0].text);
    expect(hit.results).toEqual([]);
    const doc = JSON.parse((await tools.get_doc.handler({ ref: 'markdown/servicenow-platform/keys.md', release: 'brazil' }, {})).content[0].text);
    expect(doc.error).toMatch(/no doc/);
  });
});

describe('credentials in the docs repo address', () => {
  it('are hidden in every message', () => {
    expect(redact("fatal: unable to access 'https://bot:ghp_s3cret@203.0.113.10/docs.git/': 403")).toBe("fatal: unable to access 'https://***@203.0.113.10/docs.git/': 403");
    expect(redact('ssh://git@203.0.113.10/x and https://203.0.113.10/y')).toBe('ssh://***@203.0.113.10/x and https://203.0.113.10/y');
  });

  it('never reach the error of a setup that fails, even from a git that prints them', async () => {
    // Current git hides the password in its errors; older ones print the URL as given. This stand-in does.
    const bin = mkdtempSync(join(tmpdir(), 'wayfinder-fakegit-'));
    writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "fatal: unable to access \'$3\': The requested URL returned error: 403" >&2\nexit 128\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const err = (await setupDocs({ repo: 'https://bot:ghp_s3cret@203.0.113.10/docs.git', release: 'brazil' }).then(() => null, (e) => e)) as Error;
      expect(err.message).toMatch(/Couldn't reach the docs repository \(fatal: unable to access 'https:\/\/\*\*\*@203.0.113.10\/docs.git'/);
      expect(err.message).not.toContain('ghp_s3cret');
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('one setup at a time', () => {
  const lock = () => join(process.env.WAYFINDER_DATA_DIR!, 'docs', '.setup.lock');
  // A pid that is certainly not running: past the usual pid range.
  const DEAD = 2 ** 22 + 12345;

  it('refuses while another process holds the lock, and leaves its lock alone', async () => {
    writeFileSync(lock(), `${process.ppid} brazil`);
    await expect(setupDocs({ repo: `file://${upstream}`, update: true })).rejects.toThrow(/already being set up/);
    expect(existsSync(lock())).toBe(true);
    rmSync(lock());
  });

  it('recovers a stale lock (its process is gone, or it is this process\'s own leftover) and cleans up after', async () => {
    for (const pid of [DEAD, process.pid]) {
      writeFileSync(lock(), `${pid} brazil`);
      await expect(setupDocs({ repo: `file://${upstream}`, update: true })).resolves.toMatchObject({ release: 'brazil' });
      expect(existsSync(lock())).toBe(false);
    }
  });

  it('lets only one of two setups started at the same moment go ahead', async () => {
    const [a, b] = await Promise.allSettled([setupDocs({ update: true }), setupDocs({ update: true })]);
    const states = [a.status, b.status].sort();
    expect(states).toEqual(['fulfilled', 'rejected']);
    expect(String(((a.status === 'rejected' ? a : b) as PromiseRejectedResult).reason)).toMatch(/already being set up/);
    expect(existsSync(lock())).toBe(false);
  });

  it('runs one app-started setup at a time', async () => {
    const changes: string[] = [];
    const first = startDocsSetup({ update: true }, (j) => changes.push(j.state));
    expect(() => startDocsSetup({ update: true }, () => {})).toThrow(/already being set up/);
    await vi.waitFor(() => expect(docsJob()?.state).toBe('done'));
    expect(first.state).toBe('done');
    expect(changes.at(-1)).toBe('done');
    expect(existsSync(lock())).toBe(false);
  });
});
