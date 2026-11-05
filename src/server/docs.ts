import { existsSync, readFileSync } from 'node:fs';
import { SNDOCS_TOKEN_FILE, SNDOCS_URL } from './config.ts';
import { localReleases } from './docsLocal.ts';

// Where cited docs come from: a docs server set up on this host (its token file exists), else the local index
// (`wayfinder docs setup`), else nowhere (answers fall back to the public docs site through the web allowlist).
export type DocsSource = 'server' | 'local' | null;
export const docsSource = (): DocsSource => existsSync(SNDOCS_TOKEN_FILE) ? 'server' : localReleases().length ? 'local' : null;

// Which releases the docs server has indexed (tools/call list_releases over streamable HTTP), cached an hour.
let cached: { at: number; list: string[] } | null = null;

async function rpc(session: string | null, token: string, body: unknown) {
  const res = await fetch(SNDOCS_URL, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : text;
  return { session: res.headers.get('mcp-session-id'), json: data ? JSON.parse(data) : null };
}

export async function docReleases(): Promise<string[]> {
  const source = docsSource();
  if (source === 'local') return localReleases();
  if (source !== 'server') return [];
  if (cached && Date.now() - cached.at < 3_600_000) return cached.list;
  try {
    const token = readFileSync(SNDOCS_TOKEN_FILE, 'utf8').trim();
    const init = await rpc(null, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wayfinder', version: '1' } } });
    await rpc(init.session, token, { jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => null);
    const r = await rpc(init.session, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_releases', arguments: {} } });
    const text = r.json?.result?.content?.[0]?.text ?? r.json?.result?.structuredContent;
    const parsed = typeof text === 'string' ? JSON.parse(text) : text;
    const list = (parsed?.releases ?? []).map((x: any) => x.release).filter(Boolean);
    cached = { at: Date.now(), list };
    return list;
  } catch { return cached?.list ?? []; }
}
