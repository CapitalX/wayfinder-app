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
  | { type: 'guided'; count: number; steps?: number | null; limit?: number; cost?: number | null };

export interface Message { id: string; role: 'user' | 'assistant'; blocks: Block[]; created_at: number }
export interface Chat { id: string; title: string; mode: string; instance_id: string | null; updated_at: number; project_id: string | null; auto_mode?: 'ask' | 'app' | 'project'; auto_until?: number | null; auto_app_id?: string | null }
export interface Project { id: string; name: string; brief: string; updated_at: number }
export interface Saved { id: string; project_id: string | null; chat_id: string | null; kind: 'mockup' | 'script' | 'decision' | 'note' | 'spec'; title: string; content: string; created_at: number }
export interface Spec {
  name: string; scope: string; summary: string;
  tables: { name: string; label: string; extends?: string; fields: { name: string; label: string; type: string; notes?: string }[] }[];
  roles?: { name: string; description: string }[]; access?: string[];
  logic?: { kind: string; name: string; does: string }[]; ui?: string[]; sample_data?: string[]; tests?: string[];
}
export interface AppInfo {
  id: string; project_id: string | null; chat_id: string | null; name: string; scope: string; scope_id: string | null;
  spec: Spec | null; status: string; last_output: string | null; updated_at: number; link: string | null; folder: string;
  installed_commit?: string | null; timeline?: Checkpoint[];
}
export interface Checkpoint { ref: string; short: string; at: number; label: string; named: boolean; installed: boolean }
export interface ShowSnapshot {
  kind: 'record' | 'form' | 'list'; table: string; table_label: string; title: string; instance: string; as_of: string; link: string; sys_id?: string; query?: string;
  fields?: ShowField[]; sections?: { caption: string; top?: ShowField[]; columns: ShowField[][]; full?: ShowField[] }[]; columns?: { name: string; label: string }[];
  rows?: { sys_id: string; cells: Record<string, string> }[]; total?: number; omitted: string[];
}
export interface ShowField { name: string; label: string; value: string; display: string }
export interface ProjectData { project: Project | null; chats: Chat[]; saved: Saved[]; apps: AppInfo[] }
export interface Instance { id: string; name: string; url: string; client_id: string; login_user: string; status: string; has_secret: boolean; kind?: 'pdi' | 'other'; full_permissions?: number; auth?: 'client_credentials' | 'basic' | 'oauth_user'; auth_user?: string | null; access?: Access | null; can?: Can; chat_count?: number; script_runner_path?: string | null; script_runner_records?: string | null }
export interface ScriptRunnerCard { kind: 'script-runner'; action: 'setup' | 'remove'; instance: string; scope: string; why: string; records: { table: string; name?: string; sys_id?: string; script?: string }[]; script?: string }
export interface Settings { allowlist: string[]; writeEnabled: boolean; scriptingEnabled: boolean; model: string; reminderDays: number; presence?: 'alive' | 'still' | 'off'; dailyBudgetUsd?: number; smallModel?: 'haiku' | 'sonnet'; timeZone?: string }
export interface Status {
  state: 'awake' | 'hibernating' | 'auth_failed' | 'unreachable' | 'error';
  message?: string; build?: string; lastLogin?: string | null; daysSinceLogin?: number | null; loginNote?: string;
  checkedAt: number; instanceId: string; url: string; remind: boolean; kind?: 'pdi' | 'other'; name?: string; auth?: string; user?: string; can?: Can; deploy?: { at: number; ok: boolean; version: string; message: string } | null;
}
export interface Can { known: boolean; install: boolean; build: boolean; write: boolean }
export interface Access { user: string; roles: string[] | null; admin: boolean | null; cicd: boolean; reads: Record<string, boolean>; denied: string[]; checkedAt: number }

export interface Job {
  id: string; chat_id: string | null; kind: 'plugin' | 'store_app' | 'app_install' | 'app_remove' | 'atf'; target: string;
  status: 'running' | 'successful' | 'failed' | 'cancelled'; percent: number; message: string | null;
  started_at: number; finished_at: number | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
    body: init.body === undefined ? (init.method && init.method !== 'GET' ? '{}' : undefined) : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? res.statusText, res.status);
  return json as T;
}

// Sends a message and calls onEvent for each server-sent event until the answer is done.
// A send that lands while Wayfinder restarts for an update is held, not failed: the server says so (a 503 marked
// updating, before it saves anything) or isn't answering at all for those few seconds. The page shows that it's
// updating, then sends again until the new server takes it. Every try carries the same send id: if a try did reach a
// server before the restart, the server knows the resend and nothing starts twice; the page follows that answer instead.
export const UPDATING = 'Wayfinder is updating, starting in a moment.';
export const HOLD = { ms: 120_000, pollMs: 1000 };
export async function send(chatId: string, text: string, onEvent: (e: any) => void) {
  const until = Date.now() + HOLD.ms;
  const sendId = crypto.randomUUID();
  let told = false;
  for (;;) {
    let res: Response | null = null;
    try {
      res = await fetch(`/api/chats/${chatId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sendId, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        credentials: 'same-origin',
      });
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;   // nothing listening: the restart itself
    }
    if (res?.status === 503) {
      const json = await res.json().catch(() => ({}));
      if (!json.updating) throw new ApiError(json.error ?? res.statusText, 503);
    } else if (res?.status === 409) {
      const json = await res.json().catch(() => ({}));
      if (json.duplicate) return follow(chatId, onEvent);
      throw new ApiError(json.error ?? res.statusText, 409);
    } else if (res) {
      return readEvents(res, onEvent);
    }
    if (Date.now() >= until) throw new ApiError('Wayfinder is taking longer than usual to come back after an update. Try again in a minute.', 503);
    if (!told) { onEvent({ t: 'notice', level: 'info', text: UPDATING }); told = true; }
    await new Promise((r) => setTimeout(r, HOLD.pollMs));
  }
}

// Joins the answer a chat is giving right now: every event from its first, then live until it's done (a reload, a
// chat left and reopened, another device).
export async function follow(chatId: string, onEvent: (e: any) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/chats/${chatId}/live`, { credentials: 'same-origin', signal });
  await readEvents(res, onEvent);
}

async function readEvents(res: Response, onEvent: (e: any) => void) {
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(json.error ?? res.statusText, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}

// Applies one streamed event to the in-progress assistant message.
export function applyEvent(blocks: Block[], e: any): Block[] {
  const next = blocks.slice();
  const last = next[next.length - 1];
  switch (e.t) {
    case 'text':
      if (last?.type === 'text') next[next.length - 1] = { ...last, text: last.text + e.d };
      else next.push({ type: 'text', text: e.d });
      break;
    case 'tool_start':
      next.push({ type: 'tool', id: e.id, name: e.name, input: e.input, status: 'running', parent: e.parent });
      break;
    case 'tool_result':
      return next.map((b) => (b.type === 'tool' && b.id === e.id ? { ...b, status: e.status, result: e.result, ms: e.ms } : b));
    case 'approval':
      next.push({ type: 'approval', id: e.id, tool: e.tool, input: e.input, auto: e.auto || undefined, full_permissions: e.full_permissions === true || undefined });
      break;
    case 'approval_done':
      return next.map((b) => (b.type === 'approval' && b.id === e.id ? { ...b, decision: e.decision } : b));
    case 'notice':
      next.push({ type: 'notice', level: e.level, text: e.text, action: e.action });
      break;
  }
  return next;
}

export interface Memory { id: string; text: string; why: string; scope: 'core' | 'project'; project_id: string | null; status: 'proposed' | 'saved' | 'dismissed'; chat_id: string | null; updated_at: number }
export type FeatureStatus = 'on' | 'ready' | 'store' | 'blocked' | 'pdi_unavailable' | 'unknown';
export interface Feature {
  kind: 'plugin' | 'store_app'; id: string; name: string; scope?: string; description: string; plain?: string; status: FeatureStatus; why?: string;
  version?: string; requires: { id: string; name: string; on: boolean | null }[]; help?: string; demo_data?: boolean; paid?: boolean;
}

export type BoardStatus = 'open' | 'tested' | 'ruled_out' | 'confirmed';
export type BoardKind = 'error' | 'record' | 'log' | 'doc' | 'hypothesis' | 'note';
export interface BoardItem { id: string; kind: BoardKind; title: string; detail: string; link: string | null; status: BoardStatus; author: 'pip' | 'you'; chat_id: string | null; updated_at: number }
