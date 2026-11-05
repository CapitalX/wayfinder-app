import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
const { options } = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (args: any) => {
    options(args.options);
    return (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Answer completed.' }] } };
      yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, session_id: 's' };
    })();
  },
}));

describe('an answer with user MCP servers', () => {
  it('keeps built-ins and the healthy server, notes the failed server, and finishes the answer', async () => {
    const { chats, messages, settings } = await import('../src/server/db.ts');
    const { toolServers } = await import('../src/server/toolServers.ts');
    const { runChat } = await import('../src/server/agent.ts');
    const fixture = fileURLToPath(new URL('./fixtures/toolServer.mjs', import.meta.url));
    toolServers.save({ key: 'healthy', label: 'Healthy tools', enabled: true, transport: 'stdio', command: process.execPath, args: [fixture] });
    toolServers.save({ key: 'failed', label: 'Failed tools', enabled: true, transport: 'stdio', command: process.execPath, args: [fixture, '--fail'] });
    toolServers.save({ key: 'disabled', label: 'Disabled tools', enabled: false, transport: 'stdio', command: process.execPath, args: [fixture] });
    settings.set({ writeEnabled: true });
    const chat = chats.create('build', null), events: any[] = [];
    await runChat(chat.id, 'Use the tools.', (e) => events.push(e));
    const config = options.mock.calls[0][0];
    expect(Object.keys(config.mcpServers).sort()).toEqual(['build', 'healthy', 'project']);
    expect(config.strictMcpConfig).toBe(true);
    expect(config.systemPrompt).toContain('healthy: "Healthy tools"');
    expect(config.systemPrompt).toContain('unavailable for this answer: failed');
    expect(config.systemPrompt).not.toContain('Disabled tools');
    expect(events.at(-1)).toEqual({ t: 'done' });
    expect(messages.list(chat.id).at(-1)!.blocks).toContainEqual({ type: 'text', text: 'Answer completed.' });
    expect(events.some((e) => e.level === 'error')).toBe(false);
    const call = config.canUseTool('mcp__healthy__lookup', {}, { signal: new AbortController().signal, toolUseID: 't' });
    const approval = events.find((e) => e.t === 'approval');
    expect(approval.input).toMatchObject({ kind: 'tool-server', server: 'Healthy tools', tool: 'lookup' });
    const { decide } = await import('../src/server/policy.ts');
    decide(chat.id, approval.id, false); await call;
  });
});
