import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { db } from './db.ts';
import { secrets } from './secrets.ts';

const RESERVED = new Set(['instance', 'pdi', 'project', 'build', 'sndocs', 'docs', 'constructor', 'prototype']);
// Double underscores are the SDK's server/tool separator.
const keySchema = z.string().max(40).regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).refine((k) => !RESERVED.has(k));
const text = z.string().max(4000).refine((v) => !v.includes('\0'));
const secretMap = (key: z.ZodString) => z.record(key, text).refine((v) => Object.keys(v).length <= 100);
const common = { key: keySchema, label: z.string().trim().min(1).max(100), enabled: z.boolean().default(false) };
export const toolServerSchema = z.discriminatedUnion('transport', [
  z.object({ ...common, transport: z.literal('stdio'), command: text.refine((v) => !!v.trim()), args: z.array(text).max(100).default([]), env: secretMap(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional() }).strict(),
  z.object({ ...common, transport: z.literal('http'), url: z.string().max(4000).refine((s) => {
    try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash; } catch { return false; }
  }), headers: secretMap(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)).refine((v) => Object.values(v).every((s) => !/[\r\n]/.test(s))).optional() }).strict(),
]);
type Input = z.infer<typeof toolServerSchema>;
export type ToolServer = (Omit<Extract<Input, { transport: 'stdio' }>, 'env'> | Omit<Extract<Input, { transport: 'http' }>, 'headers'>) & { revision: string };

export const toolServers = {
  list(): ToolServer[] { return (db.prepare('SELECT config FROM tool_servers ORDER BY key').all() as { config: string }[]).map((r) => JSON.parse(r.config)); },
  get(key: string): ToolServer | undefined { return this.list().find((s) => s.key === key); },
  publicList() {
    return this.list().map((s) => {
      const values = secrets.toolServer(s.key);
      const flags = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).map(([k, value]) => [k, value ? 'set' : 'not set']));
      return { ...s, env: flags(values.env), headers: flags(values.headers) };
    });
  },
  save(raw: unknown, edit = false): ToolServer {
    const parsed = toolServerSchema.safeParse(raw);
    // Never echo validation inputs or remote errors: they can contain credentials.
    if (!parsed.success) throw new Error('Invalid tool server. Check the key, transport and fields.');
    const value = parsed.data, old = this.get(value.key);
    if (edit ? !old : !!old) throw new Error(edit ? 'No such tool server.' : 'That tool server key is already used.');
    const previous = secrets.toolServer(value.key);
    const { env, headers, ...config } = { env: undefined, headers: undefined, ...value };
    const saved = { ...config, revision: randomUUID() } as ToolServer;
    secrets.setToolServer(value.key, {
      env: value.transport === 'stdio' ? env ?? (old?.transport === 'stdio' ? previous.env : {}) : {},
      headers: value.transport === 'http' ? headers ?? (old?.transport === 'http' ? previous.headers : {}) : {},
    });
    db.prepare('INSERT INTO tool_servers VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET config = excluded.config').run(value.key, JSON.stringify(saved));
    return saved;
  },
  enable(key: string, enabled: boolean) {
    const s = this.get(key);
    if (!s) throw new Error('No such tool server.');
    db.prepare('UPDATE tool_servers SET config = ? WHERE key = ?').run(JSON.stringify({ ...s, enabled, revision: randomUUID() }), key);
  },
  remove(key: string) {
    db.prepare('DELETE FROM tool_servers WHERE key = ?').run(key);
    secrets.setToolServer(key, null);
  },
};

export function serverConfig(server: ToolServer): McpServerConfig {
  const values = secrets.toolServer(server.key);
  if (server.transport === 'http') return { type: 'http', url: server.url, headers: values.headers };
  // The agent process inherits credentials; explicitly blank them before supplying the user's env.
  const env = { ...Object.fromEntries(Object.keys(process.env).map((k) => [k, ''])), ANTHROPIC_API_KEY: '', ...getDefaultEnvironment(), ...values.env };
  return { type: 'stdio', command: server.command, args: server.args, env };
}

// Discovery is bounded and closes its session on success, failure or cancellation. It never calls a tool.
export async function discoverTools(config: McpServerConfig, signal = AbortSignal.timeout(8000)): Promise<string[]> {
  const client = new Client({ name: 'wayfinder', version: '1.0.0' });
  const transport = config.type === 'http'
    ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }) })
    : config.type === 'stdio' || !config.type ? new StdioClientTransport({ ...config, stderr: 'ignore' }) : null;
  if (!transport) throw new Error('Unsupported transport.');
  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal, timeout: 8000 });
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 8000 });
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
      if (names.length > 1000) throw new Error('Too many tools.');
    } while (cursor);
    return names;
  } finally { await client.close().catch(() => {}); }
}

export async function assembleToolServers(list = toolServers.list(), discover = discoverTools, signal?: AbortSignal) {
  const servers: Record<string, McpServerConfig> = {}, revisions: Record<string, string> = {}, unavailable: string[] = [];
  await Promise.all(list.filter((s) => s.enabled).map(async (s) => {
    try {
      const config = serverConfig(s);
      await discover(config, signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : undefined);
      // An edit during discovery does not silently change the server for this answer.
      if (toolServers.get(s.key)?.revision !== s.revision) throw new Error('Server changed.');
      servers[s.key] = config; revisions[s.key] = s.revision;
    } catch { unavailable.push(s.key); }
  }));
  return { servers, revisions, unavailable };
}
