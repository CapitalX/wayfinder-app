import { AGENT_CWD, envVar } from './config.ts';
import { perf, settings } from './db.ts';
import { claudeEnv } from './claudeAccess.ts';
import { budgetGate, spentToday } from './budget.ts';

// Small jobs: one-shot calls with no tools (chat titles, a fresh chat's summary, lessons, conventions). They run on the
// small-jobs model from Settings (Haiku unless changed), count toward the daily spending limit (each is a perf row
// with mode "job:<name>"), and skip quietly when the limit is used up or the call fails: every caller has a fallback.

export type JobName = 'title' | 'summary' | 'tool-lessons' | 'conventions' | 'fluent-review';
export const SMALL_MODELS = ['haiku', 'sonnet'] as const;

type Runner = (o: { model: string; system: string; prompt: string; signal: AbortSignal }) => Promise<{ text: string; cost: number | null }>;
const sdk: Runner = async ({ model, system, prompt, signal }) => {
  // Loaded on first use, so a test file's mock of the SDK applies even though tests/setup.ts loads this module first.
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  signal.addEventListener('abort', () => abortController.abort());
  let text = '', cost: number | null = null;
  for await (const m of query({
    prompt,
    options: {
      cwd: AGENT_CWD, model, maxTurns: 1, tools: [], settingSources: [], strictMcpConfig: true, abortController, systemPrompt: system,
      env: claudeEnv(),
    },
  })) if (m.type === 'result') { cost = m.total_cost_usd ?? null; if (m.subtype === 'success') text = m.result; }
  return { text, cost };
};
let runner: Runner = sdk;
// Tests swap the model call out (tests/setup.ts): no test ever reaches Claude.
export const setSmallJobRunner = (r?: Runner) => { runner = r ?? sdk; };

// A job that times out, fails or reports no cost still spent money, so it's counted at an estimate (or the daily limit
// could be outrun by failing jobs): input at about 4 characters a token, plus a typical answer, at list prices per
// million tokens (input, output). An unknown model is priced like the dearest, so the estimate errs high.
const PRICES: Record<string, [number, number]> = { haiku: [1, 5], sonnet: [2, 10], opus: [4, 20] };
export const ESTIMATED_OUTPUT_TOKENS = 500;
export function estimateCost(model: string, chars: number): number {
  const [inp, out] = PRICES[Object.keys(PRICES).find((k) => model.toLowerCase().includes(k)) ?? 'opus'];
  return (Math.ceil(chars / 4) * inp + ESTIMATED_OUTPUT_TOKENS * out) / 1_000_000;
}

// `model` overrides the setting for a job that needs the bigger model (the Fluent review writes code examples).
export async function smallJob(o: { job: JobName; system: string; prompt: string; timeoutMs?: number; model?: string }): Promise<string | null> {
  // WAYFINDER_SMALL_JOBS=off turns them all off (the UI test server uses it, so it never reaches Claude).
  if (envVar('SMALL_JOBS') === 'off') return null;
  const s = settings.get();
  if ('refuse' in budgetGate(s.dailyBudgetUsd, spentToday())) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? 30_000);
  const at = Date.now();
  const model = o.model ?? s.smallModel;
  const record = (cost: number | null) => perf.add({ at, chat_id: `job:${o.job}`, mode: `job:${o.job}`, start_ms: null, first_word_ms: null, total_ms: Date.now() - at, tools: [], turns: 1, cost_usd: cost ?? estimateCost(model, o.system.length + o.prompt.length) });
  try {
    const { text, cost } = await runner({ model, system: o.system, prompt: o.prompt, signal: abort.signal });
    record(cost);
    return text.trim() || null;
  } catch { record(null); return null; } finally { clearTimeout(timer); }
}

// Most jobs answer with a JSON array; anything else counts as no answer.
export const jsonArray = <T>(text: string | null): T[] => { try { const j = JSON.parse(/\[[\s\S]*\]/.exec(text ?? '')?.[0] ?? '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
