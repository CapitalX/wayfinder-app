import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

// The local docs index: ServiceNow's docs repo (one branch per release family, Markdown with front matter) in one
// SQLite FTS5 database per release. Indexing is incremental by git blob sha, so an update re-reads changed files only.
// Search and reads take an open database, so they test without any server.

const CHUNK_CHARS = 3200; // ~800 tokens

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE, sha TEXT, publication TEXT,
  title TEXT, description TEXT, product TEXT, classification TEXT, topic_type TEXT,
  breadcrumb TEXT, canonical_url TEXT, last_updated TEXT, body TEXT);
CREATE INDEX IF NOT EXISTS docs_pub ON docs(publication);
CREATE INDEX IF NOT EXISTS docs_url ON docs(canonical_url);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, doc_id INTEGER, ord INTEGER, heading TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title, heading, text, tokenize='porter unicode61');
`;

const ESCAPES = /\\([_()[\]*#<>`~|\-.!{}+])/g;
const unescape = (s: string) => s.replace(ESCAPES, '$1');

// Raw HTML tables become pipe rows; Markdown escapes go.
export function clean(body: string): string {
  return unescape(body.replace(/\s*<\/t[dh]>\s*/gi, ' | ').replace(/\s*<\/tr>\s*/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]*\|\s*\|[ \t]*/g, ' | ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The front matter is flat: `key: value`, quoted strings and `[a, b]` lists. Anything else is kept as plain text.
export function parseDoc(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of raw.slice(3, end).split('\n')) {
        const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean).join(' > ');
        else if (/^"(.*)"$/.test(v) || /^'([^']*)'$/.test(v)) v = v.slice(1, -1);
        if (v && !/^[|>]-?$/.test(v)) meta[m[1]] = unescape(v);
      }
      body = raw.slice(end + 4);
    }
  }
  return { meta, body: clean(body) };
}

// Split by heading, packing sections up to CHUNK_CHARS; each chunk keeps its heading path.
export function chunk(body: string): { heading: string; text: string }[] {
  const sections: { heading: string; text: string }[] = [];
  const path: string[] = [];
  let buf: string[] = [];
  const flush = () => { const text = buf.join('\n').trim(); if (text) sections.push({ heading: path.join(' > '), text }); buf = []; };
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) { flush(); path.splice(m[1].length - 1, Infinity, m[2].trim()); }
    buf.push(line);
  }
  flush();
  const out: { heading: string; text: string }[] = [];
  for (const { heading, text: whole } of sections) {
    let text = whole;
    while (text.length > CHUNK_CHARS) {
      let cut = text.lastIndexOf('\n\n', CHUNK_CHARS);
      if (cut <= CHUNK_CHARS / 3) cut = CHUNK_CHARS;
      out.push({ heading, text: text.slice(0, cut).trim() });
      text = text.slice(cut).trim();
    }
    if (text) out.push({ heading, text });
  }
  return out;
}

// Credentials in a URL (https://user:token@host/...) never reach a message, log or API answer: git echoes the repo
// URL in its errors, and the docs repo is configurable.
export const redact = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(redact(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`));
  return r.stdout;
}

// Markdown files under markdown/ and their blob shas. Only regular files (git mode 100644/100755): the repo is third
// party, and a symlink (120000) could point at a local file, such as Wayfinder's own keys, and pull it into the index.
function blobShas(repo: string): Map<string, string> {
  const shas = new Map<string, string>();
  for (const line of git(repo, ['ls-files', '-s', 'markdown']).split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    const [mode, sha] = line.slice(0, tab).split(' ');
    if (path.endsWith('.md') && (mode === '100644' || mode === '100755')) shas.set(path, sha);
  }
  return shas;
}

// Read one page, only if it's a regular file whose real location is inside the clone (a second guard behind the
// mode check: a folder on the way could still be a link).
function readPage(repo: string, rel: string): string | null {
  const full = join(repo, rel);
  try {
    if (!lstatSync(full).isFile()) return null;
    const root = realpathSync(repo);
    if (!realpathSync(full).startsWith(root + sep)) return null;
    return readFileSync(full, 'utf8');
  } catch { return null; }
}

export interface IndexResult { indexed: number; removed: number; total: number; ms: number }

// Bring one release's database in line with its clone: drop what's gone, (re)index what changed.
export function indexRepo(db: DatabaseSync, repo: string, onProgress: (done: number, todo: number) => void = () => {}): IndexResult {
  const t0 = Date.now();
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  const shas = blobShas(repo);
  const have = new Map((db.prepare('SELECT path, sha FROM docs').all() as { path: string; sha: string }[]).map((r) => [r.path, r.sha]));
  const stale = [...have.keys()].filter((p) => !shas.has(p));
  const todo = [...shas].filter(([p, sha]) => have.get(p) !== sha).map(([p]) => p);

  const find = db.prepare('SELECT id FROM docs WHERE path = ?');
  const dropFts = db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)');
  const dropChunks = db.prepare('DELETE FROM chunks WHERE doc_id = ?');
  const dropDoc = db.prepare('DELETE FROM docs WHERE id = ?');
  const addDoc = db.prepare('INSERT INTO docs(path, sha, publication, title, description, product, classification, topic_type, breadcrumb, canonical_url, last_updated, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const addChunk = db.prepare('INSERT INTO chunks(doc_id, ord, heading, text) VALUES (?,?,?,?)');
  const addFts = db.prepare('INSERT INTO chunks_fts(rowid, title, heading, text) VALUES (?,?,?,?)');
  const drop = (path: string) => {
    const row = find.get(path) as { id: number } | undefined;
    if (row) { dropFts.run(row.id); dropChunks.run(row.id); dropDoc.run(row.id); }
  };

  db.exec('BEGIN');
  try {
    for (const p of stale) drop(p);
    todo.forEach((p, i) => {
      drop(p);
      const raw = readPage(repo, p);
      if (raw === null) return;
      const { meta, body } = parseDoc(raw);
      const parts = p.split('/'); // markdown/<publication>/...
      const title = meta.title || basename(p, '.md');
      const doc = addDoc.run(p, shas.get(p)!, parts.length > 2 ? parts[1] : null, title, meta.description ?? null, meta.product ?? null,
        meta.classification ?? null, meta.topic_type ?? null, meta.breadcrumb ?? null, meta.canonical_url ?? null, meta.last_updated ?? null, body);
      chunk(body).forEach((c, ord) => {
        const row = addChunk.run(doc.lastInsertRowid, ord, c.heading, c.text);
        addFts.run(row.lastInsertRowid, title, c.heading, c.text);
      });
      if ((i + 1) % 2000 === 0) { db.exec('COMMIT'); onProgress(i + 1, todo.length); db.exec('BEGIN'); }
    });
    const setMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    setMeta.run('commit', git(repo, ['rev-parse', 'HEAD']).trim());
    setMeta.run('indexed_at', new Date().toISOString().slice(0, 19));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (todo.length || stale.length) db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('optimize')");
  onProgress(todo.length, todo.length);
  const total = (db.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n;
  return { indexed: todo.length, removed: stale.length, total, ms: Date.now() - t0 };
}

// ---------- reading ----------

const STOP = new Set(`a an and are as at be by can do does for from has have how i in is it its me my of on or our
should so that the their them then there these this to use used using was we what when where which who
why will with you your about into than also any all get set doing make`.split(/\s+/));

export const terms = (q: string) => [...new Set((q.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t)))];

export interface Hit {
  title: string; heading: string; breadcrumb: string | null; product: string | null; topic_type: string | null;
  path: string; canonical_url: string | null; last_updated: string | null; text: string;
}

// Every term first, then all-but-one, then any term: precise hits lead and recall fills the rest. At most two
// sections per doc; listing pages (index.md) are left out because they match everything.
export function search(db: DatabaseSync, query: string, opts: { product?: string; topic_type?: string; limit?: number } = {}): Hit[] {
  const toks = terms(query);
  if (!toks.length) return [];
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
  const where: string[] = ["d.path NOT LIKE '%/index.md'"];
  const args: string[] = [];
  if (opts.product) { where.push('(d.product LIKE ? OR d.publication LIKE ? OR d.breadcrumb LIKE ?)'); args.push(...Array(3).fill(`%${opts.product}%`)); }
  if (opts.topic_type) { where.push('d.topic_type = ?'); args.push(opts.topic_type); }
  const sql = db.prepare(`SELECT c.id, c.heading, c.text, d.path, d.title, d.product, d.topic_type, d.breadcrumb, d.canonical_url, d.last_updated
    FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN docs d ON d.id = c.doc_id
    WHERE chunks_fts MATCH ? AND ${where.join(' AND ')} ORDER BY bm25(chunks_fts, 6.0, 3.0, 1.0) LIMIT ?`);
  const quoted = toks.map((t) => `"${t}"`);
  const stages = [quoted.join(' ')];
  if (quoted.length >= 3 && quoted.length <= 8) stages.push(...quoted.map((_, i) => [...quoted.slice(0, i), ...quoted.slice(i + 1)].join(' ')));
  stages.push(quoted.join(' OR '));
  const seen = new Set<number>(), per = new Map<string, number>(), out: Hit[] = [];
  for (const match of stages) {
    for (const r of sql.all(match, ...args, limit * 6) as any[]) {
      if (seen.has(r.id) || (per.get(r.path) ?? 0) >= 2) continue;
      seen.add(r.id);
      per.set(r.path, (per.get(r.path) ?? 0) + 1);
      out.push({ title: r.title, heading: r.heading, breadcrumb: r.breadcrumb, product: r.product, topic_type: r.topic_type, path: r.path,
        canonical_url: r.canonical_url, last_updated: r.last_updated, text: r.text.length <= 1200 ? r.text : `${r.text.slice(0, 1200)} …` });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// One doc by repo path (with or without markdown/) or canonical_url; a docs-site URL also matches by its file name.
export function getDoc(db: DatabaseSync, ref: string, maxChars = 60_000): Record<string, unknown> | null {
  ref = ref.trim().replace(/\\_/g, '_');
  let row = db.prepare('SELECT * FROM docs WHERE path = ? OR path = ? OR canonical_url = ? LIMIT 1').get(ref, `markdown/${ref}`, ref) as Record<string, any> | undefined;
  if (!row && ref.startsWith('http')) {
    const tail = ref.replace(/\/+$/, '').split('/').pop()!.replace(/\.html$/, '');
    row = db.prepare('SELECT * FROM docs WHERE path LIKE ? LIMIT 1').get(`%/${tail}.md`) as Record<string, any> | undefined;
  }
  if (!row) return null;
  const { sha: _sha, id: _id, ...doc } = row;
  if (doc.body.length > maxChars) doc.body = `${doc.body.slice(0, maxChars)}\n\n[truncated]`;
  return doc;
}

export const listProducts = (db: DatabaseSync) =>
  db.prepare('SELECT publication, count(*) AS docs FROM docs GROUP BY publication ORDER BY publication').all();

export const browse = (db: DatabaseSync, publication: string, contains?: string, limit = 200) =>
  db.prepare(`SELECT title, path, topic_type FROM docs WHERE publication = ?${contains ? ' AND title LIKE ?' : ''} ORDER BY title LIMIT ?`)
    .all(...[publication, ...(contains ? [`%${contains}%`] : []), Math.min(limit, 500)]);

// Combined upgrade notes between two families live in publication delta-<from>-<to> of the newer one.
export function whatsChanged(db: DatabaseSync, from: string, to: string, product?: string): Record<string, unknown> {
  const pub = `delta-${from.toLowerCase()}-${to.toLowerCase()}`;
  if (!product) {
    const docs = db.prepare('SELECT title, path FROM docs WHERE publication = ? ORDER BY title').all(pub);
    if (docs.length) return { from, to, products: docs };
    const have = (db.prepare("SELECT DISTINCT publication FROM docs WHERE publication LIKE 'delta-%'").all() as { publication: string }[]).map((r) => r.publication);
    return { error: `no notes for ${pub}`, available: have };
  }
  const row = db.prepare('SELECT path FROM docs WHERE publication = ? AND title LIKE ? ORDER BY length(title) LIMIT 1').get(pub, `%${product}%`) as { path: string } | undefined;
  return row ? getDoc(db, row.path)! : { error: `no ${pub} notes matching ${JSON.stringify(product)}; call without product to list them` };
}

export function indexInfo(db: DatabaseSync) {
  const meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  return { docs: (db.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n, ...meta };
}
