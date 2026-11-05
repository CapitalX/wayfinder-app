import { secrets } from './secrets.ts';

export function claudeEnv(): NodeJS.ProcessEnv {
  const key = secrets.anthropicKey()?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error('An Anthropic API key is required. Save one in setup or set ANTHROPIC_API_KEY.');
  // Only API-key authentication reaches the SDK, even when the parent shell has other credentials.
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: key, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[name];
  return env;
}
export const claudeSource = (_source?: string) => 'Anthropic API key';
