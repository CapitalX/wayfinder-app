import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secrets } from '../src/server/secrets.ts';
import { claudeEnv } from '../src/server/claudeApiKey.ts';
import { chats, messages, settings } from '../src/server/db.ts';
import { setSmallJobRunner, smallJob } from '../src/server/smallJob.ts';

// setup.ts preloads smallJob; reload it so its credential import uses the policy below.
vi.hoisted(() => vi.resetModules());

// Exercise the public credential policy through each real caller, without making a model request.
vi.mock('../src/server/claudeAccess.ts', async () => import('../src/server/claudeApiKey.ts'));
const { query } = vi.hoisted(() => ({ query: vi.fn(() => (async function* () {
  yield { type: 'system', subtype: 'init', apiKeySource: 'env', session_id: 'test' };
  yield { type: 'result', subtype: 'success', result: 'OK', num_turns: 1, total_cost_usd: 0, session_id: 'test' };
})()) }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()), query,
}));

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'test-other-credential');
  secrets.setAnthropicKey(null);
  settings.set({ dailyBudgetUsd: 0 });
  query.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); secrets.setAnthropicKey(null); setSmallJobRunner(async () => ({ text: '', cost: null })); });

describe('API key access', () => {
  it('requires a nonblank key even when other credentials are available', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '  ');
    expect(() => claudeEnv()).toThrow('An Anthropic API key is required');
  });

  it('uses the saved key first, then the environment, and strips other auth methods', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-env-key');
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']) vi.stubEnv(k, '1');
    secrets.setAnthropicKey('test-saved-key');
    expect(claudeEnv().ANTHROPIC_API_KEY).toBe('test-saved-key');
    secrets.setAnthropicKey(null);
    const env = claudeEnv();
    expect(env.ANTHROPIC_API_KEY).toBe('test-env-key');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(Object.keys(env).filter(k => /OAUTH_TOKEN|AUTH_TOKEN|FILE_DESCRIPTOR|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY/.test(k))).toEqual([]);
  });

  it('does not call Claude from setup without a key, and explains how to connect', async () => {
    const { testClaude } = await import('../src/server/setup.ts');
    expect(await testClaude()).toMatchObject({ ok: false, error: expect.stringContaining('An Anthropic API key is required') });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not call Claude from chat without a key, and saves the error', async () => {
    const { runChat } = await import('../src/server/agent.ts');
    const chat = chats.create('explore', null);
    await runChat(chat.id, 'Hello', () => {});
    expect(JSON.stringify(messages.list(chat.id))).toContain('An Anthropic API key is required');
    expect(query).not.toHaveBeenCalled();
  });

  it('does not call Claude from background jobs without a key', async () => {
    setSmallJobRunner();
    expect(await smallJob({ job: 'title', system: '', prompt: 'Hello' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['saved', 'environment'])('allows setup, chat and background calls with a %s key', async (source) => {
    if (source === 'saved') secrets.setAnthropicKey('test-key');
    else vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const { testClaude } = await import('../src/server/setup.ts');
    expect(await testClaude()).toMatchObject({ ok: true, source: 'Anthropic API key' });
    const { runChat } = await import('../src/server/agent.ts');
    await runChat(chats.create('explore', null).id, 'Hello', () => {});
    setSmallJobRunner();
    expect(await smallJob({ job: 'title', system: '', prompt: 'Hello' })).toBe('OK');
    expect(query).toHaveBeenCalledTimes(3);
  });
});
