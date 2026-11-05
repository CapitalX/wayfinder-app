import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { discoverTools } from '../src/server/toolServers.ts';

const args = [fileURLToPath(new URL('./fixtures/toolServer.mjs', import.meta.url))];
const config = { type: 'stdio' as const, command: process.execPath, args, env: {} };
describe('MCP discovery with a local fixture, no network', () => {
  it('starts, initializes, lists tools and closes a real stdio process', async () => {
    expect(await discoverTools(config)).toEqual(['lookup']);
  });
  it('reports failed startup', async () => {
    await expect(discoverTools({ ...config, args: [...args, '--fail'] })).rejects.toThrow();
  });
  it('times out a process that never answers and closes it', async () => {
    await expect(discoverTools({ ...config, args: [...args, '--hang'] }, AbortSignal.timeout(100))).rejects.toThrow();
  });
  it('does not start after cancellation', async () => {
    await expect(discoverTools(config, AbortSignal.abort())).rejects.toThrow();
  });
});


describe('HTTP discovery with mocked fetch, no network', () => {
  it('initializes, forwards configured headers and lists tools', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result = request.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
        : { tools: [{ name: 'http_lookup', inputSchema: { type: 'object' } }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await discoverTools({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'configured-placeholder' } })).toEqual(['http_lookup']);
      for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get('Authorization')).toBe('configured-placeholder');
    } finally { vi.unstubAllGlobals(); }
  });
});
