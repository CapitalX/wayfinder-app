import { describe, expect, it, vi } from 'vitest';

// Claude is replaced by a script: a docs search that comes back with results, and a plugin check that fails.
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' };
    yield { type: 'assistant', parent_tool_use_id: null, message: { usage: {}, content: [
      { type: 'tool_use', id: 't1', name: 'mcp__sndocs__search_docs', input: { query: 'loaner laptops', release: 'brazil' } },
      { type: 'tool_use', id: 't2', name: 'mcp__pdi__check_features', input: { need: 'loaner laptops' } },
    ] } };
    yield { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"results": [{"title": "Asset loans"}]}' }] },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'The instance did not answer (timeout).' }] },
    ] } };
    yield { type: 'assistant', parent_tool_use_id: null, message: { usage: {}, content: [{ type: 'text', text: 'Checked.' }] } };
    yield { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0, session_id: 's', result: 'Checked.' };
  })(),
}));

describe('build gate, through a real answer', () => {
  it('counts a check whose tool came back with a result, not one that failed', async () => {
    const { chatChecks, chats } = await import('../src/server/db.ts');
    const { missingChecks } = await import('../src/server/buildGate.ts');
    const { runChat } = await import('../src/server/agent.ts');
    const chat = chats.create('build', null);
    await runChat(chat.id, 'Build me a loaner laptop app', () => {});
    expect([...chatChecks.get(chat.id)]).toEqual(['docs']);
    expect(missingChecks(chat.id, true)).toEqual(['oob']);
  });
});

describe('build gate with the local docs (the in-process sndocs tool)', () => {
  it('counts a real result from the local docs tool as a docs lookup, and not its errors', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { setupDocs, localDocsServer } = await import('../src/server/docsLocal.ts');
    const { chatChecks, chats } = await import('../src/server/db.ts');
    const { noteToolResult } = await import('../src/server/buildGate.ts');
    const repo = mkdtempSync(join(tmpdir(), 'wayfinder-gate-docs-'));
    mkdirSync(join(repo, 'markdown', 'itsm'), { recursive: true });
    writeFileSync(join(repo, 'markdown', 'itsm', 'loans.md'), '---\ntitle: Asset loans\ncanonical_url: https://www.servicenow.com/docs/r/itsm/loans.html\n---\n\n# Asset loans\n\nLoaner laptops are tracked as asset loans.\n');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
    for (const args of [['init', '-q', '-b', 'brazil'], ['add', 'markdown/itsm/loans.md'], ['commit', '-q', '-m', 'docs']]) execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
    await setupDocs({ repo: `file://${repo}` });

    const tools = (localDocsServer() as any).instance._registeredTools;
    const chat = chats.create('build', null);
    const bad = await tools.search_docs.handler({ query: 'loaner', release: 'zurich' }, {});
    expect(noteToolResult(chat.id, 'mcp__sndocs__search_docs', { query: 'loaner', release: 'zurich' }, !!bad.isError, bad.content[0].text)).toBe(null);
    expect(chatChecks.get(chat.id).has('docs')).toBe(false);
    const good = await tools.search_docs.handler({ query: 'loaner laptops', release: 'brazil' }, {});
    expect(JSON.parse(good.content[0].text).results[0].title).toBe('Asset loans');
    expect(noteToolResult(chat.id, 'mcp__sndocs__search_docs', { query: 'loaner laptops', release: 'brazil' }, !!good.isError, good.content[0].text)).toBe('docs');
    for (const t of ['get_doc', 'browse', 'whats_changed']) expect(noteToolResult(chat.id, `mcp__sndocs__${t}`, {}, false, '{"ok": true}'), t).toBe('docs');
  });
});
