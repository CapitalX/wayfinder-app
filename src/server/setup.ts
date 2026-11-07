import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_CWD } from './config.ts';
import { activeBackend } from './sandbox/index.ts';
import { docsSource } from './docs.ts';
import { instances, settings } from './db.ts';
import { secrets } from './secrets.ts';
import { claudeEnv, claudeSource } from './claudeAccess.ts';

// First-run setup: is Claude reachable, is an instance connected, which optional extras are on.

let lastTest: { ok: boolean; source?: string; error?: string; at: number } | null = null;

export function setupState() {
  const s = settings.get();
  const backend = activeBackend();
  return {
    done: s.setupDone || !!instances.active(),
    claude: { keySaved: !!secrets.anthropicKey(), envKey: !!process.env.ANTHROPIC_API_KEY, test: lastTest },
    instance: !!instances.active(),
    extras: {
      docs: !!docsSource(),
      docsSource: docsSource(),
      sandbox: backend.name !== 'none' && backend.available().ok,
    },
  };
}

// One tiny, tool-less request proves the credentials work and says where they came from.
export async function testClaude(): Promise<NonNullable<typeof lastTest>> {
  const t0 = Date.now();
  try {
    let source: string | undefined, ok = false, error: string | undefined;
    for await (const m of query({
      prompt: 'Reply with the single word OK.',
      options: {
        cwd: AGENT_CWD, maxTurns: 1, tools: [], settingSources: [], strictMcpConfig: true, model: 'haiku',
        env: claudeEnv(),
      },
    })) {
      if (m.type === 'system' && m.subtype === 'init') source = (m as any).apiKeySource;
      if (m.type === 'result') { ok = m.subtype === 'success'; if (!ok) error = `Claude stopped: ${m.subtype}`; }
    }
    lastTest = { ok, source: claudeSource(source), error, at: Date.now() };
  } catch (e) {
    lastTest = { ok: false, error: (e as Error).message.slice(0, 300), at: Date.now() };
  }
  console.log(`claude test ${lastTest.ok ? 'ok' : 'failed'} in ${Date.now() - t0} ms`);
  return lastTest;
}
