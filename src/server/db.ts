import { createHash, randomUUID } from 'node:crypto';
import { DB_FILE, DEFAULT_ALLOWLIST } from './config.ts';
import { announce } from './events.ts';

// Loaded here rather than imported at the top, so an old Node gets the plain message from nodeCheck.ts first.
const { DatabaseSync } = await import('node:sqlite');

// A plan's fingerprint, so an approval covers exactly the plan that was shown.
export const specHash = (spec: string) => createHash('sha256').update(spec).digest('hex');

export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL, instance_id TEXT,
    session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, blocks TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, client_id TEXT NOT NULL,
    login_user TEXT NOT NULL DEFAULT 'admin', status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tool_servers (key TEXT PRIMARY KEY, config TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, chat_id TEXT, kind TEXT NOT NULL, target TEXT NOT NULL,
    progress_id TEXT NOT NULL, status TEXT NOT NULL, percent INTEGER NOT NULL DEFAULT 0, message TEXT,
    started_at INTEGER NOT NULL, finished_at INTEGER);
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, project_id TEXT, chat_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id, created_at);
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY, project_id TEXT, chat_id TEXT, instance_id TEXT, name TEXT NOT NULL, scope TEXT NOT NULL UNIQUE,
    scope_id TEXT, spec TEXT NOT NULL, status TEXT NOT NULL, last_output TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL, project_id TEXT,
    status TEXT NOT NULL, chat_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS board_items (
    id TEXT PRIMARY KEY, board TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    link TEXT, status TEXT NOT NULL, author TEXT NOT NULL, chat_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS board_items_board ON board_items(board, updated_at);
  CREATE TABLE IF NOT EXISTS perf (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, chat_id TEXT, mode TEXT, start_ms INTEGER, first_word_ms INTEGER,
    total_ms INTEGER, tools TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS fluent_lessons (
    id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, code TEXT, message TEXT NOT NULL, fix TEXT,
    rule TEXT, example TEXT, seen INTEGER NOT NULL DEFAULT 1, sdk TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tool_lessons (
    id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, tool TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
    failed TEXT, worked TEXT, rule TEXT, seen INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, chat_id TEXT, instance_id TEXT,
    tool TEXT NOT NULL, input TEXT NOT NULL, decision TEXT NOT NULL);
`);

// Columns added after the first release.
const hasColumn = (table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
if (!hasColumn('chats', 'project_id')) db.exec('ALTER TABLE chats ADD COLUMN project_id TEXT');
// Auto mode (per chat): which approvals the app may grant by itself, until when, and for which app.
if (!hasColumn('chats', 'auto_mode')) db.exec("ALTER TABLE chats ADD COLUMN auto_mode TEXT NOT NULL DEFAULT 'ask'");
if (!hasColumn('chats', 'auto_until')) db.exec('ALTER TABLE chats ADD COLUMN auto_until INTEGER');
if (!hasColumn('chats', 'auto_app_id')) db.exec('ALTER TABLE chats ADD COLUMN auto_app_id TEXT');
// The chat's running cost from the SDK at its last answer, so the next answer counts only its own share (budget.ts).
if (!hasColumn('chats', 'cost_snapshot')) db.exec('ALTER TABLE chats ADD COLUMN cost_snapshot TEXT');
// Where this chat's work lives (placement.ts): the card waiting for a choice, then the choice. JSON.
if (!hasColumn('chats', 'placement')) db.exec('ALTER TABLE chats ADD COLUMN placement TEXT');
// Session hygiene: the SDK's summary when a chat was compacted, and what a fresh chat carried over from the one before.
if (!hasColumn('chats', 'compact_summary')) db.exec('ALTER TABLE chats ADD COLUMN compact_summary TEXT');
if (!hasColumn('chats', 'carried')) db.exec('ALTER TABLE chats ADD COLUMN carried TEXT');
// When the chat's answer started, while it runs: still set at start-up means a restart cut that answer off.
if (!hasColumn('chats', 'answering_since')) db.exec('ALTER TABLE chats ADD COLUMN answering_since INTEGER');
// Every Agent SDK session a chat has used, so deleting the chat can delete their transcripts too (transcripts.ts).
if (!hasColumn('chats', 'sessions')) db.exec("ALTER TABLE chats ADD COLUMN sessions TEXT NOT NULL DEFAULT '[]'");
// The routine that started this chat on its schedule (routines.ts), so its runs can be found.
if (!hasColumn('chats', 'routine_id')) db.exec('ALTER TABLE chats ADD COLUMN routine_id TEXT');
// The build last installed on the PDI, so an install approval can show what changed since.
if (!hasColumn('apps', 'installed_commit')) db.exec('ALTER TABLE apps ADD COLUMN installed_commit TEXT');
if (!hasColumn('apps', 'installed_at')) db.exec('ALTER TABLE apps ADD COLUMN installed_at INTEGER');
// The plan the user approved (a hash of the spec when they clicked Approve plan). Writing, building and installing wait
// for it, and a changed plan needs a new click. Apps that existed before the gate count as approved as they stand.
if (!hasColumn('apps', 'plan_approved')) {
  db.exec('ALTER TABLE apps ADD COLUMN plan_approved TEXT');
  for (const a of db.prepare('SELECT id, spec FROM apps').all() as { id: string; spec: string }[])
    db.prepare('UPDATE apps SET plan_approved = ? WHERE id = ?').run(specHash(a.spec), a.id);
}
// PDIs connect as usual; a production or vendor instance is an explicit opt-in and stays labelled.
if (!hasColumn('instances', 'kind')) db.exec("ALTER TABLE instances ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdi'");
if (!hasColumn('instances', 'full_permissions')) db.exec('ALTER TABLE instances ADD COLUMN full_permissions INTEGER NOT NULL DEFAULT 0');
// How Wayfinder signs in: client credentials (an integration user), username + password, or as the user via OAuth.
if (!hasColumn('instances', 'auth')) db.exec("ALTER TABLE instances ADD COLUMN auth TEXT NOT NULL DEFAULT 'client_credentials'");
if (!hasColumn('instances', 'auth_user')) db.exec('ALTER TABLE instances ADD COLUMN auth_user TEXT');
// What the signed-in account can actually do (roles, readable tables, refusals learned from 403s).
if (!hasColumn('instances', 'profile')) db.exec('ALTER TABLE instances ADD COLUMN profile TEXT');
for (const col of ['script_runner_path', 'script_runner_records']) if (!hasColumn('instances', col)) db.exec(`ALTER TABLE instances ADD COLUMN ${col} TEXT`);
// Efficiency metrics per answer: model turns, failed tool calls, cost.
for (const [c, t] of [['turns', 'INTEGER'], ['tool_errors', 'INTEGER'], ['cost_usd', 'REAL'], ['context_tokens', 'INTEGER']]) if (!hasColumn('perf', c)) db.exec(`ALTER TABLE perf ADD COLUMN ${c} ${t}`);
// Which tool call or approval card an audit row belongs to, so one action's ask, decision and outcome line up.
if (!hasColumn('audit', 'ref')) db.exec('ALTER TABLE audit ADD COLUMN ref TEXT');

// A rich result card on a notice: installs, test runs and removals finish with one of these.
export interface NoticeCard {
  kind: 'install' | 'atf' | 'remove'; title: string; ok: boolean;
  stats?: { label: string; value: string | number; tone?: 'good' | 'warn' | 'bad' | 'plain' }[];
  links?: { label: string; href: string }[];
  items?: { label: string; status: 'pass' | 'fail' | 'skip'; href?: string; detail?: string }[];
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; status: 'running' | 'done' | 'error' | 'denied'; result?: string; parent?: string | null; ms?: number }
  | { type: 'approval'; id: string; tool: string; input: unknown; decision?: 'allow' | 'deny'; auto?: boolean; full_permissions?: boolean }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; card?: NoticeCard; action?: 'fresh-chat' | 'continue'; detail?: string[] }
  | { type: 'guided'; count: number; steps?: number | null; limit?: number; cost?: number | null }; // the answer's footer

export type AutoMode = 'ask' | 'app' | 'project';
export interface Chat { id: string; title: string; mode: string; instance_id: string | null; session_id: string | null; created_at: number; updated_at: number; project_id: string | null; auto_mode: AutoMode; auto_until: number | null; auto_app_id: string | null; placement: string | null; compact_summary?: string | null; carried?: string | null; cost_snapshot?: string | null; routine_id?: string | null; answering_since?: number | null }
export type AuthMethod = 'client_credentials' | 'basic' | 'oauth_user';
export interface Instance { id: string; name: string; url: string; client_id: string; login_user: string; status: string; created_at: number; kind: 'pdi' | 'other'; full_permissions: number; auth: AuthMethod; auth_user: string | null; profile: string | null; script_runner_path?: string | null; script_runner_records?: string | null }
export const fullPermissions = (inst: Instance | undefined | null) => inst?.kind === 'pdi' && inst.status === 'active' && inst.full_permissions === 1;

const now = () => Date.now();

export const chats = {
  stopAutoOn: (instanceId: string) => db.prepare("UPDATE chats SET auto_mode = 'ask', auto_until = NULL, auto_app_id = NULL WHERE instance_id = ?").run(instanceId),
  list: () => db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as unknown as Chat[],
  get: (id: string) => db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as unknown as Chat | undefined,
  create(mode: string, instanceId: string | null, projectId: string | null = null): Chat {
    const chat: Chat = { id: randomUUID(), title: 'New chat', mode, instance_id: instanceId, session_id: null, created_at: now(), updated_at: now(), project_id: projectId, auto_mode: 'ask', auto_until: null, auto_app_id: null, placement: null, compact_summary: null, carried: null };
    db.prepare('INSERT INTO chats (id, title, mode, instance_id, session_id, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(chat.id, chat.title, chat.mode, chat.instance_id, null, chat.created_at, chat.updated_at, projectId);
    return chat;
  },
  update(id: string, fields: Partial<Pick<Chat, 'title' | 'mode' | 'session_id' | 'instance_id' | 'project_id' | 'auto_mode' | 'auto_until' | 'auto_app_id' | 'placement' | 'compact_summary' | 'carried' | 'cost_snapshot' | 'routine_id'>>) {
    // undefined leaves a field alone; null clears it (e.g. moving a chat out of a project).
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) db.prepare(`UPDATE chats SET ${k} = ? WHERE id = ?`).run(v, id);
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), id);
  },
  // Compare-and-set for the placement card: only one click can move it on (see placement.ts choose()).
  swapPlacement: (id: string, from: string, to: string) => Number(db.prepare('UPDATE chats SET placement = ? WHERE id = ? AND placement = ?').run(to, id, from).changes) === 1,
  // A new session id is remembered with the chat's earlier ones (deleting the chat deletes all their transcripts).
  addSession(id: string, sessionId: string) {
    const row = db.prepare('SELECT sessions FROM chats WHERE id = ?').get(id) as { sessions?: string } | undefined;
    const list: string[] = JSON.parse(row?.sessions || '[]');
    if (!list.includes(sessionId)) db.prepare('UPDATE chats SET sessions = ? WHERE id = ?').run(JSON.stringify([...list, sessionId].slice(-200)), id);
  },
  // Every session id this chat has used (for deleting their transcripts with it).
  sessions(id: string): string[] {
    const row = db.prepare('SELECT session_id, sessions FROM chats WHERE id = ?').get(id) as { session_id: string | null; sessions?: string } | undefined;
    if (!row) return [];
    return [...new Set([...JSON.parse(row.sessions || '[]'), ...(row.session_id ? [row.session_id] : [])])];
  },
  remove(id: string) {
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
    db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  },
  // Marks an answer as running (or done); doesn't touch updated_at, so the chat list keeps its order.
  setAnswering: (id: string, at: number | null) => db.prepare('UPDATE chats SET answering_since = ? WHERE id = ?').run(at, id),
  cutOff: () => (db.prepare('SELECT id FROM chats WHERE answering_since IS NOT NULL').all() as { id: string }[]).map((r) => r.id),
  idsOn: (instanceId: string) => (db.prepare('SELECT id FROM chats WHERE instance_id = ?').all(instanceId) as { id: string }[]).map((r) => r.id),
};

export const messages = {
  list: (chatId: string) =>
    (db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at').all(chatId) as any[]).map((m) => ({ ...m, blocks: JSON.parse(m.blocks) as Block[] })),
  add(chatId: string, role: 'user' | 'assistant', blocks: Block[]) {
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chatId, role, JSON.stringify(blocks), now());
    announce('chats', { chat_id: chatId });
  },
};

export const instances = {
  list: () => db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all() as unknown as Instance[],
  get: (id: string) => db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as unknown as Instance | undefined,
  active: () => db.prepare("SELECT * FROM instances WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get() as unknown as Instance | undefined,
  create(i: Pick<Instance, 'name' | 'url' | 'client_id' | 'login_user' | 'kind' | 'auth' | 'auth_user'>): Instance {
    const row: Instance = { id: randomUUID(), status: 'active', created_at: now(), profile: null, full_permissions: 0, ...i };
    // Only one instance is active; connecting a new PDI retires the old one but keeps its chats.
    db.prepare("UPDATE instances SET status = 'retired' WHERE status = 'active'").run();
    db.prepare('INSERT INTO instances (id, name, url, client_id, login_user, status, created_at, kind, auth, auth_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.name, row.url, row.client_id, row.login_user, row.status, row.created_at, row.kind, row.auth, row.auth_user);
    return row;
  },
  update(id: string, fields: Partial<Pick<Instance, 'name' | 'url' | 'client_id' | 'login_user' | 'auth_user' | 'profile' | 'kind' | 'full_permissions' | 'script_runner_path' | 'script_runner_records'>>) {
    const inst = instances.get(id);
    if (fields.full_permissions !== undefined && ![0, 1].includes(fields.full_permissions)) throw new Error('Full permissions must be on or off.');
    if (fields.full_permissions === 1 && (fields.kind ?? inst?.kind) !== 'pdi') throw new Error('Full permissions is only available for personal developer instances.');
    const patch = { ...fields };
    if ((fields.kind ?? inst?.kind) !== 'pdi' || (fields.url !== undefined && fields.url !== inst?.url)) patch.full_permissions = 0;
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length) db.prepare(`UPDATE instances SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v!), id);
    // Reconnect updates sign-in fields before access is ready; only permission changes need this refresh.
    if (patch.full_permissions !== undefined && patch.full_permissions !== inst?.full_permissions) announce('instance', { instance_id: id });
  },
  activate(id: string) {
    db.prepare("UPDATE instances SET status = 'retired' WHERE status = 'active'").run();
    db.prepare("UPDATE instances SET status = 'active' WHERE id = ?").run(id);
  },
  // Sign-in method and its user; also clears the access profile (it described the old sign-in). auth_user may become
  // null, which update() can't do.
  setAuth(id: string, auth: Instance['auth'], authUser: string | null) {
    db.prepare('UPDATE instances SET auth = ?, auth_user = ?, profile = NULL WHERE id = ?').run(auth, authUser, id);
  },
  // Instances at this address that are still in use (active or retired; not removed), the active one first.
  byUrl: (url: string) => db.prepare("SELECT * FROM instances WHERE url = ? AND status != 'removed' ORDER BY status = 'active' DESC, created_at DESC").all(url) as unknown as Instance[],
  // A removed instance keeps its row (name, address) so its chats stay labelled; everything that signs in is cleared.
  markRemoved(id: string) {
    db.prepare("UPDATE instances SET status = 'removed', client_id = '', auth_user = NULL, profile = NULL WHERE id = ? AND status != 'active'").run(id);
  },
  // How much points at an instance: chats, audit entries, jobs, apps and conventions.
  references(id: string) {
    const n = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
    return {
      chats: n('SELECT COUNT(*) AS n FROM chats WHERE instance_id = ?'),
      audit: n('SELECT COUNT(*) AS n FROM audit WHERE instance_id = ?'),
      jobs: n('SELECT COUNT(*) AS n FROM jobs WHERE instance_id = ?'),
      apps: n('SELECT COUNT(*) AS n FROM apps WHERE instance_id = ?'),
      conventions: n('SELECT COUNT(*) AS n FROM conventions WHERE instance_id = ?'),
    };
  },
  // Only for rows nothing points at (see references); anything with history is marked removed instead.
  deleteUnreferenced(id: string) {
    if (Object.values(instances.references(id)).some((n) => n > 0)) return false;
    db.prepare("DELETE FROM instances WHERE id = ? AND status != 'active'").run(id);
    return true;
  },
};

export interface Settings {
  allowlist: string[];
  writeEnabled: boolean;
  scriptingEnabled: boolean;
  model: string;
  reminderDays: number;
  presence: 'alive' | 'still' | 'off'; // Pip: animated, still, or no character at all
  setupDone: boolean;                  // first-run setup finished (or skipped)
  docsRelease: string;                 // docs release for answers: 'auto' follows the instance
  dailyBudgetUsd: number;              // spending limit per day in dollars; 0 is off
  smallModel: 'haiku' | 'sonnet';      // model for small jobs (titles, summaries, lessons); smallJob.ts
  timeZone: string;                    // the user's clock, as the browser last reported it (clock.ts); '' until then
}

const DEFAULTS: Settings = { allowlist: DEFAULT_ALLOWLIST, writeEnabled: false, scriptingEnabled: false, model: 'opus', reminderDays: 7, presence: 'alive', setupDone: false, docsRelease: 'auto', dailyBudgetUsd: 0, smallModel: 'haiku', timeZone: '' };

export const settings = {
  get(): Settings {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    return { ...DEFAULTS, ...stored };
  },
  set(patch: Partial<Settings>) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS) || v === undefined) continue;
      db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
    }
  },
};

// Audit inputs keep what was asked for, never a credential: values under secret-looking keys and anything shaped like a
// key or bearer token are masked before the row is written.
const SECRET_KEY = /pass(word|wd)?$|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
export const SECRET_VALUE = /\b(sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|Basic\s+[A-Za-z0-9+/=]{12,})/g;
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.replace(SECRET_VALUE, '[redacted]');
  if (Array.isArray(v)) return depth > 8 ? '[…]' : v.map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 8) return '[…]';
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) && x !== null && x !== '' ? '[redacted]' : redact(x, depth + 1)]));
  }
  return v;
}

export const audit = {
  add(chatId: string | null, instanceId: string | null, tool: string, input: unknown, decision: string, ref: string | null = null) {
    db.prepare('INSERT INTO audit (at, chat_id, instance_id, tool, input, decision, ref) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), chatId, instanceId, tool, JSON.stringify(redact(input) ?? null).slice(0, 20000), decision, ref);
  },
  recent: (limit = 200) => db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit),
  forChat: (chatId: string) => db.prepare('SELECT at, tool, input, decision FROM audit WHERE chat_id = ? ORDER BY id').all(chatId) as { at: number; tool: string; input: string; decision: string }[],
  // The newest entry of one kind for an instance (e.g. when and why Pip last switched the update set).
  latest: (instanceId: string, tool: string) => db.prepare('SELECT * FROM audit WHERE instance_id = ? AND tool = ? ORDER BY id DESC LIMIT 1').get(instanceId, tool) as { at: number; chat_id: string | null; input: string; decision: string } | undefined,
};

export interface Project { id: string; name: string; brief: string; created_at: number; updated_at: number }

export const projects = {
  list: () => db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as Project[],
  get: (id: string) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project | undefined,
  create(name: string, brief = ''): Project {
    const row: Project = { id: randomUUID(), name, brief, created_at: now(), updated_at: now() };
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(row.id, row.name, row.brief, row.created_at, row.updated_at);
    return row;
  },
  update(id: string, f: Partial<Pick<Project, 'name' | 'brief'>>) {
    for (const [k, v] of Object.entries(f)) if (v !== undefined) db.prepare(`UPDATE projects SET ${k} = ? WHERE id = ?`).run(v, id);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id);
  },
  // Chats, saved items and apps stay; they just move out of the project.
  remove(id: string) {
    for (const t of ['chats', 'artifacts', 'apps']) db.prepare(`UPDATE ${t} SET project_id = NULL WHERE project_id = ?`).run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
};

// Things worth keeping from a chat: mockups, scripts, decisions, notes and app specs.
export type ArtifactKind = 'mockup' | 'script' | 'decision' | 'note' | 'spec';
export interface Artifact { id: string; project_id: string | null; chat_id: string | null; kind: ArtifactKind; title: string; content: string; created_at: number }

export const artifacts = {
  forChat: (chatId: string) => db.prepare('SELECT * FROM artifacts WHERE chat_id = ? ORDER BY created_at').all(chatId) as unknown as Artifact[],
  list: (projectId: string | null) =>
    (projectId
      ? db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : db.prepare('SELECT * FROM artifacts WHERE project_id IS NULL ORDER BY created_at DESC').all()) as unknown as Artifact[],
  get: (id: string) => db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as unknown as Artifact | undefined,
  add(a: Omit<Artifact, 'id' | 'created_at'>): Artifact {
    const row: Artifact = { id: randomUUID(), created_at: now(), ...a };
    db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.chat_id, row.kind, row.title, row.content, row.created_at);
    if (row.project_id) projects.update(row.project_id, {});
    return row;
  },
  remove: (id: string) => db.prepare('DELETE FROM artifacts WHERE id = ?').run(id),
};

// Apps made in Build mode. The source lives in APPS_DIR/<scope>; status follows it from draft to installed.
export type AppStatus = 'draft' | 'built' | 'build_failed' | 'installing' | 'installed' | 'install_failed' | 'removing' | 'removed';
export interface App {
  id: string; project_id: string | null; chat_id: string | null; instance_id: string | null; name: string; scope: string;
  scope_id: string | null; spec: string; status: AppStatus; last_output: string | null; created_at: number; updated_at: number;
  installed_commit: string | null; installed_at: number | null; plan_approved?: string | null;
}

export const apps = {
  list: (projectId?: string | null) =>
    (projectId === undefined
      ? db.prepare('SELECT * FROM apps ORDER BY updated_at DESC').all()
      : projectId
        ? db.prepare('SELECT * FROM apps WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
        : db.prepare('SELECT * FROM apps WHERE project_id IS NULL ORDER BY updated_at DESC').all()) as unknown as App[],
  get: (id: string) => db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as unknown as App | undefined,
  byScope: (scope: string) => db.prepare('SELECT * FROM apps WHERE scope = ?').get(scope) as unknown as App | undefined,
  add(a: Pick<App, 'project_id' | 'chat_id' | 'instance_id' | 'name' | 'scope' | 'scope_id' | 'spec'>): App {
    const row: App = { id: randomUUID(), status: 'draft', last_output: null, created_at: now(), updated_at: now(), installed_commit: null, installed_at: null, ...a };
    db.prepare('INSERT INTO apps (id, project_id, chat_id, instance_id, name, scope, scope_id, spec, status, last_output, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.project_id, row.chat_id, row.instance_id, row.name, row.scope, row.scope_id, row.spec, row.status, row.last_output, row.created_at, row.updated_at);
    return row;
  },
  update(id: string, f: Partial<Pick<App, 'name' | 'spec' | 'status' | 'last_output' | 'instance_id' | 'scope_id' | 'project_id' | 'installed_commit' | 'installed_at' | 'plan_approved'>>) {
    for (const [k, v] of Object.entries(f)) if (v !== undefined) db.prepare(`UPDATE apps SET ${k} = ? WHERE id = ?`).run(v, id);
    db.prepare('UPDATE apps SET updated_at = ? WHERE id = ?').run(now(), id);
    announce('apps');
  },
};

// Memories: lessons Pip keeps across chats (e.g. "VR has a multithreaded background job processor; use it
// instead of a plain scheduled job"). Pip only proposes them; the user saves or dismisses each one.
export type MemoryScope = 'core' | 'project';
export type MemoryStatus = 'proposed' | 'saved' | 'dismissed';
export interface Memory { id: string; text: string; why: string; scope: MemoryScope; project_id: string | null; status: MemoryStatus; chat_id: string | null; created_at: number; updated_at: number }

export const memories = {
  list: (status?: MemoryStatus) =>
    (status ? db.prepare('SELECT * FROM memories WHERE status = ? ORDER BY updated_at DESC').all(status) : db.prepare("SELECT * FROM memories WHERE status != 'dismissed' ORDER BY updated_at DESC").all()) as unknown as Memory[],
  listAll: () => db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as unknown as Memory[],
  get: (id: string) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as Memory | undefined,
  // What a chat should know: every saved core memory, plus saved memories for its project.
  forChat: (projectId: string | null) =>
    db.prepare("SELECT * FROM memories WHERE status = 'saved' AND (scope = 'core' OR project_id = ?) ORDER BY scope, updated_at DESC LIMIT 80").all(projectId) as unknown as Memory[],
  add(m: Pick<Memory, 'text' | 'why' | 'scope' | 'project_id' | 'status' | 'chat_id'>): Memory {
    const row: Memory = { id: randomUUID(), created_at: now(), updated_at: now(), ...m };
    db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.text, row.why, row.scope, row.project_id, row.status, row.chat_id, row.created_at, row.updated_at);
    announce('memories', { chat_id: row.chat_id });
    return row;
  },
  update(id: string, f: Partial<Pick<Memory, 'text' | 'why' | 'scope' | 'project_id' | 'status'>>) {
    for (const [k, v] of Object.entries(f)) if (v !== undefined) db.prepare(`UPDATE memories SET ${k} = ? WHERE id = ?`).run(v, id);
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(now(), id);
    announce('memories');
  },
  remove: (id: string) => { db.prepare('DELETE FROM memories WHERE id = ?').run(id); announce('memories'); },
};

// The investigation board: clues pinned while chasing a problem (errors, records, log lines, docs, guesses), each
// marked open, tested, ruled out or confirmed. One board per project, or per chat when the chat has no project.
export type BoardKind = 'error' | 'record' | 'log' | 'doc' | 'hypothesis' | 'note';
export type BoardStatus = 'open' | 'tested' | 'ruled_out' | 'confirmed';
export interface BoardItem {
  id: string; board: string; kind: BoardKind; title: string; detail: string; link: string | null; status: BoardStatus;
  author: 'pip' | 'you'; chat_id: string | null; created_at: number; updated_at: number;
}
export const boardKey = (projectId: string | null, chatId: string | null) => (projectId ? `project:${projectId}` : `chat:${chatId}`);

export const board = {
  list: (key: string) => db.prepare('SELECT * FROM board_items WHERE board = ? ORDER BY created_at').all(key) as unknown as BoardItem[],
  get: (id: string) => db.prepare('SELECT * FROM board_items WHERE id = ?').get(id) as unknown as BoardItem | undefined,
  add(i: Pick<BoardItem, 'board' | 'kind' | 'title' | 'detail' | 'link' | 'status' | 'author' | 'chat_id'>): BoardItem {
    const row: BoardItem = { id: randomUUID(), created_at: now(), updated_at: now(), ...i };
    db.prepare('INSERT INTO board_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.board, row.kind, row.title, row.detail, row.link, row.status, row.author, row.chat_id, row.created_at, row.updated_at);
    announce('board', { board: row.board });
    return row;
  },
  update(id: string, f: Partial<Pick<BoardItem, 'title' | 'detail' | 'status' | 'kind' | 'link'>>) {
    for (const [k, v] of Object.entries(f)) if (v !== undefined) db.prepare(`UPDATE board_items SET ${k} = ? WHERE id = ?`).run(v, id);
    db.prepare('UPDATE board_items SET updated_at = ? WHERE id = ?').run(now(), id);
    announce('board');
  },
  remove: (id: string) => { db.prepare('DELETE FROM board_items WHERE id = ?').run(id); announce('board'); },
};

// Speed: one row per answer, so slowdowns show up as numbers instead of a feeling.
export interface PerfRow { at: number; chat_id: string; mode: string; start_ms: number | null; first_word_ms: number | null; total_ms: number; tools: { name: string; ms: number }[]; turns?: number | null; tool_errors?: number; cost_usd?: number | null; context_tokens?: number | null }
// Build errors the cheat sheet didn't predict, what fixed them, and the rule Pip drafted from them.
// status: miss (seen, no fix yet) → fixed (a later build passed) → proposed (rule drafted and compiled) → approved | dismissed.
export interface FluentLesson { id: string; key: string; status: 'miss' | 'fixed' | 'proposed' | 'approved' | 'dismissed'; code: string | null; message: string; fix: string | null; rule: string | null; example: string | null; seen: number; sdk: string | null; created_at: number; updated_at: number }
export const fluentLessons = {
  list: (status?: FluentLesson['status']) => (status
    ? db.prepare('SELECT * FROM fluent_lessons WHERE status = ? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT * FROM fluent_lessons ORDER BY updated_at DESC LIMIT 200').all()) as unknown as FluentLesson[],
  get: (id: string) => db.prepare('SELECT * FROM fluent_lessons WHERE id = ?').get(id) as FluentLesson | undefined,
  miss(key: string, code: string | null, message: string, sdk: string) {
    const hit = db.prepare('SELECT id, status FROM fluent_lessons WHERE key = ?').get(key) as { id: string; status: string } | undefined;
    if (hit) db.prepare('UPDATE fluent_lessons SET seen = seen + 1, updated_at = ? WHERE id = ?').run(now(), hit.id);
    else db.prepare("INSERT INTO fluent_lessons (id, key, status, code, message, sdk, created_at, updated_at) VALUES (?, ?, 'miss', ?, ?, ?, ?, ?)").run(randomUUID(), key, code, message, sdk, now(), now());
    announce('lessons');
  },
  update(id: string, f: Partial<Pick<FluentLesson, 'status' | 'fix' | 'rule' | 'example'>>) {
    const cur = fluentLessons.get(id);
    if (!cur) return;
    const n = { ...cur, ...f };
    db.prepare('UPDATE fluent_lessons SET status = ?, fix = ?, rule = ?, example = ?, updated_at = ? WHERE id = ?').run(n.status, n.fix, n.rule, n.example, now(), id);
    announce('lessons');
  },
};

// Tool calls that failed, and (when a later call of the same tool worked) both inputs and the rule drafted from them.
// status: miss → fixed (a later call worked) → learned (rule drafted; in Pip's prompt) | removed.
export interface ToolLesson { id: string; key: string; tool: string; status: 'miss' | 'fixed' | 'learned' | 'removed'; message: string; failed: string | null; worked: string | null; rule: string | null; seen: number; created_at: number; updated_at: number }
export const toolLessons = {
  list: (status?: ToolLesson['status']) => (status
    ? db.prepare('SELECT * FROM tool_lessons WHERE status = ? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT * FROM tool_lessons ORDER BY updated_at DESC LIMIT 200').all()) as unknown as ToolLesson[],
  get: (id: string) => db.prepare('SELECT * FROM tool_lessons WHERE id = ?').get(id) as ToolLesson | undefined,
  byKey: (key: string) => db.prepare('SELECT * FROM tool_lessons WHERE key = ?').get(key) as ToolLesson | undefined,
  miss(key: string, tool: string, message: string, failed: string) {
    const hit = toolLessons.byKey(key);
    if (hit) db.prepare('UPDATE tool_lessons SET seen = seen + 1, updated_at = ? WHERE id = ?').run(now(), hit.id);
    else db.prepare("INSERT INTO tool_lessons (id, key, tool, status, message, failed, created_at, updated_at) VALUES (?, ?, ?, 'miss', ?, ?, ?, ?)").run(randomUUID(), key, tool, message, failed, now(), now());
    announce('lessons');
  },
  update(id: string, f: Partial<Pick<ToolLesson, 'status' | 'worked' | 'rule' | 'failed'>>) {
    const cur = toolLessons.get(id);
    if (!cur) return;
    const n = { ...cur, ...f };
    db.prepare('UPDATE tool_lessons SET status = ?, failed = ?, worked = ?, rule = ?, updated_at = ? WHERE id = ?').run(n.status, n.failed, n.worked, n.rule, now(), id);
    announce('lessons');
  },
};

export const perf = {
  add(r: PerfRow) {
    db.prepare('INSERT INTO perf (at, chat_id, mode, start_ms, first_word_ms, total_ms, tools, turns, tool_errors, cost_usd, context_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.at, r.chat_id, r.mode, r.start_ms, r.first_word_ms, r.total_ms, JSON.stringify(r.tools), r.turns ?? null, r.tool_errors ?? 0, r.cost_usd ?? null, r.context_tokens ?? null);
    db.prepare('DELETE FROM perf WHERE id <= (SELECT MAX(id) - 2000 FROM perf)').run();
  },
  // The largest step any earlier answer in this chat read, so the long-chat note shows once per step size.
  peakContext: (chatId: string) => ((db.prepare('SELECT MAX(context_tokens) AS m FROM perf WHERE chat_id = ?').get(chatId) as any)?.m as number | null) ?? 0,
  costSince: (at: number) => ((db.prepare('SELECT SUM(cost_usd) AS c FROM perf WHERE at >= ?').get(at) as any)?.c as number | null) ?? 0,
  recent: (limit = 200) => (db.prepare('SELECT * FROM perf ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({ ...r, tools: JSON.parse(r.tools) })) as PerfRow[],
};

// Plugin activations and store app installs run for minutes; they're tracked here instead of holding the chat.
// App installs and removals run the SDK on this host (no progress_id); ATF runs are polled like installs.
export type JobKind = 'plugin' | 'store_app' | 'app_install' | 'app_remove' | 'atf';
export interface Job {
  id: string; instance_id: string; chat_id: string | null; kind: JobKind; target: string;
  progress_id: string; status: 'running' | 'successful' | 'failed' | 'cancelled'; percent: number; message: string | null;
  started_at: number; finished_at: number | null;
}

export const jobs = {
  add(j: Pick<Job, 'instance_id' | 'chat_id' | 'kind' | 'target' | 'progress_id'>): Job {
    const row: Job = { id: randomUUID(), status: 'running', percent: 0, message: null, started_at: now(), finished_at: null, ...j };
    db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.instance_id, row.chat_id, row.kind, row.target, row.progress_id, row.status, row.percent, row.message, row.started_at, row.finished_at);
    announce('jobs');
    return row;
  },
  running: () => db.prepare("SELECT * FROM jobs WHERE status = 'running'").all() as unknown as Job[],
  // Running jobs plus anything that finished in the last 12 hours.
  recent: () => db.prepare("SELECT * FROM jobs WHERE status = 'running' OR finished_at > ? ORDER BY started_at DESC").all(now() - 12 * 3_600_000) as unknown as Job[],
  update(id: string, f: Partial<Pick<Job, 'status' | 'percent' | 'message' | 'finished_at'>>) {
    for (const [k, v] of Object.entries(f)) db.prepare(`UPDATE jobs SET ${k} = ? WHERE id = ?`).run(v ?? null, id);
    announce('jobs');
  },
  get: (id: string) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Job | undefined,
};

// An instance's development conventions, learned from its existing customizations (opt-in, per instance).
// status: proposed (a scan's suggestions, waiting for the user) → on (approved rules are in Pip's prompt). Turning it off
// deletes the row.
db.exec(`CREATE TABLE IF NOT EXISTS conventions (
  instance_id TEXT PRIMARY KEY, status TEXT NOT NULL, proposed TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL DEFAULT '[]',
  scanned_at INTEGER, updated_at INTEGER NOT NULL)`);
export interface ConventionRule { id: string; area: string; rule: string; example: string; support?: string }
export interface Conventions { instance_id: string; status: 'proposed' | 'on'; proposed: ConventionRule[]; rules: ConventionRule[]; scanned_at: number | null; updated_at: number }
export const conventions = {
  get(instanceId: string): Conventions | undefined {
    const r = db.prepare('SELECT * FROM conventions WHERE instance_id = ?').get(instanceId) as any;
    return r ? { ...r, proposed: JSON.parse(r.proposed), rules: JSON.parse(r.rules) } : undefined;
  },
  propose(instanceId: string, proposed: ConventionRule[]) {
    const had = conventions.get(instanceId);
    db.prepare('INSERT OR REPLACE INTO conventions VALUES (?, ?, ?, ?, ?, ?)').run(instanceId, had?.status === 'on' ? 'on' : 'proposed', JSON.stringify(proposed), JSON.stringify(had?.rules ?? []), now(), now());
    announce('conventions');
  },
  approve(instanceId: string, rules: ConventionRule[]) {
    const had = conventions.get(instanceId);
    db.prepare('INSERT OR REPLACE INTO conventions VALUES (?, ?, ?, ?, ?, ?)').run(instanceId, 'on', '[]', JSON.stringify(rules), had?.scanned_at ?? null, now());
    announce('conventions');
  },
  clear(instanceId: string) {
    db.prepare('DELETE FROM conventions WHERE instance_id = ?').run(instanceId);
    announce('conventions');
  },
};

// The checks a chat has run before building (buildGate.ts): a docs lookup and an out-of-the-box plugin/Store check.
db.exec(`CREATE TABLE IF NOT EXISTS chat_checks (chat_id TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (chat_id, kind))`);
export type CheckKind = 'docs' | 'oob';
export const chatChecks = {
  get: (chatId: string) => new Set((db.prepare('SELECT kind FROM chat_checks WHERE chat_id = ?').all(chatId) as { kind: CheckKind }[]).map((r) => r.kind)),
  record: (chatId: string, kind: CheckKind, tool: string) => { db.prepare('INSERT OR REPLACE INTO chat_checks VALUES (?, ?, ?, ?)').run(chatId, kind, tool, now()); },
};

// Paused rules (the Memory page): a memory, convention, tool lesson or Fluent lesson that stays saved but stays out of
// Pip's prompt until resumed. Its own table, so nothing already stored changes.
db.exec(`CREATE TABLE IF NOT EXISTS rule_pauses (kind TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, id))`);
// Convention ids repeat across instances (rule-1, update-set-date…), so a convention's pause is keyed
// <instance id>:<rule id>. Older rows keyed by the rule id alone paused that id on every instance: each becomes one row
// per instance whose approved rules have it, so nothing that was paused comes back on its own.
export function migrateConventionPauses() {
  for (const old of db.prepare("SELECT id, at FROM rule_pauses WHERE kind = 'convention' AND instr(id, ':') = 0").all() as { id: string; at: number }[]) {
    for (const c of db.prepare('SELECT instance_id, rules FROM conventions').all() as { instance_id: string; rules: string }[]) {
      let ids: string[] = [];
      try { ids = (JSON.parse(c.rules) as { id: string }[]).map((r) => r.id); } catch { /* unreadable row: skip */ }
      if (ids.includes(old.id)) db.prepare('INSERT OR IGNORE INTO rule_pauses VALUES (?, ?, ?)').run('convention', `${c.instance_id}:${old.id}`, old.at);
    }
    db.prepare("DELETE FROM rule_pauses WHERE kind = 'convention' AND id = ?").run(old.id);
  }
}
migrateConventionPauses();
export type RuleKind = 'memory' | 'convention' | 'tool' | 'fluent';
export const conventionKey = (instanceId: string, ruleId: string) => `${instanceId}:${ruleId}`;
export const pauses = {
  all: () => new Set((db.prepare('SELECT kind, id FROM rule_pauses').all() as { kind: string; id: string }[]).map((r) => `${r.kind}:${r.id}`)),
  has: (kind: RuleKind, id: string) => !!db.prepare('SELECT 1 FROM rule_pauses WHERE kind = ? AND id = ?').get(kind, id),
  set(kind: RuleKind, id: string, paused: boolean) {
    if (paused) db.prepare('INSERT OR IGNORE INTO rule_pauses VALUES (?, ?, ?)').run(kind, id, now());
    else db.prepare('DELETE FROM rule_pauses WHERE kind = ? AND id = ?').run(kind, id);
    announce('memories');
  },
};

// Sends the server has taken, by the id the page gives each message. The page resends a message when it can't tell
// whether a restart for an update caught it (no reply at all), so a resend of one already taken must start nothing.
// On disk, because the resend usually reaches the next server. A day is plenty: the page stops resending after two minutes.
// Routines: a question Pip answers on a schedule, each run in a fresh chat of its own (routines.ts). `every` is hour,
// day or week; `hour` and `weekday` (0 = Sunday) are local time and only matter for day and week.
db.exec(`CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL, every TEXT NOT NULL,
  hour INTEGER NOT NULL DEFAULT 8, weekday INTEGER NOT NULL DEFAULT 1, project_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL, last_run_at INTEGER, last_chat_id TEXT, created_at INTEGER NOT NULL)`);
export interface Routine {
  id: string; title: string; prompt: string; mode: string; every: 'hour' | 'day' | 'week'; hour: number; weekday: number;
  project_id: string | null; enabled: number; next_run_at: number; last_run_at: number | null; last_chat_id: string | null; created_at: number;
}
export const routines = {
  list: () => db.prepare('SELECT * FROM routines ORDER BY created_at').all() as unknown as Routine[],
  get: (id: string) => db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as unknown as Routine | undefined,
  due: (at: number) => db.prepare('SELECT * FROM routines WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at').all(at) as unknown as Routine[],
  add(r: Pick<Routine, 'title' | 'prompt' | 'mode' | 'every' | 'hour' | 'weekday' | 'project_id' | 'enabled' | 'next_run_at'>): Routine {
    const row: Routine = { id: randomUUID(), last_run_at: null, last_chat_id: null, created_at: now(), ...r };
    db.prepare('INSERT INTO routines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.title, row.prompt, row.mode, row.every, row.hour, row.weekday, row.project_id, row.enabled, row.next_run_at, row.last_run_at, row.last_chat_id, row.created_at);
    announce('routines');
    return row;
  },
  update(id: string, f: Partial<Pick<Routine, 'title' | 'prompt' | 'mode' | 'every' | 'hour' | 'weekday' | 'project_id' | 'enabled' | 'next_run_at' | 'last_run_at' | 'last_chat_id'>>) {
    for (const [k, v] of Object.entries(f)) if (v !== undefined) db.prepare(`UPDATE routines SET ${k} = ? WHERE id = ?`).run(v, id);
    announce('routines');
  },
  remove: (id: string) => { db.prepare('DELETE FROM routines WHERE id = ?').run(id); announce('routines'); },
};

db.exec(`CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, at INTEGER NOT NULL)`);
export const sends = {
  seen: (id: string) => !!db.prepare('SELECT 1 FROM sends WHERE id = ?').get(id),
  take(id: string, chatId: string) {
    db.prepare('DELETE FROM sends WHERE at < ?').run(now() - 86_400_000);
    db.prepare('INSERT OR IGNORE INTO sends VALUES (?, ?, ?)').run(id, chatId, now());
  },
};
