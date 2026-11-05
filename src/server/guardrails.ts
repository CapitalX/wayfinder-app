import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { lessonRecorder } from './toolLessons.ts';

// Guardrail hints: after a tool fails (or something looks off), add one short line of guidance to Pip's context so
// the next step is right instead of a retry loop. Cheap: no extra model calls, only text the model reads anyway.
const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, 4000);

export function guardrails(lessons?: ReturnType<typeof lessonRecorder>) {
  const failures = new Map<string, number>();
  let calls = 0;
  const hint = (additionalContext: string) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext } });

  const adviseOnError = (tool: string, err: string): string | null => {
    const n = (failures.get(tool) ?? 0) + 1;
    failures.set(tool, n);
    if (n >= 3) return `${tool} has failed ${n} times in this answer. Stop retrying it: tell the user what you tried and what's blocking, in two lines.`;
    if (/unsafe JavaScript expression/i.test(err)) return 'instance only allows these javascript: functions in queries: gs.daysAgo(n), gs.hoursAgo(n), gs.minutesAgo(n), gs.monthsAgo(n), gs.beginningOfToday(), gs.endOfToday(), gs.beginningOfLast7Days(), gs.beginningOfThisMonth(), gs.getUserID(), gs.now(). No *Start/*End variants such as hoursAgoStart: use gs.hoursAgo(24). For log summaries prefer pdi log_summary.';
    if (/\b401\b|sign-in/i.test(err)) return 'That was a sign-in failure, not a query problem. Stop and tell the user to reconnect in Settings.';
    if (/\b403\b|not authorized|insufficient_privileges|acl/i.test(err)) return "The account isn't allowed to do that. Don't retry or try a workaround; say which role is likely needed.";
    if (/invalid (table|field)|unknown (table|field)|no such (table|field)|is not a valid/i.test(err)) return 'A table or field name was wrong. Check it once with get_table_schema (or the docs), then query again with the exact names.';
    if (/build failed|error TS\d+|diagnostic/i.test(err)) return 'Fix every reported build error in one pass (they include file and line), then build once. If a record type is unclear, read its fluent_docs page first.';
    if (/timed? ?out|ETIMEDOUT|503|502/i.test(err)) return 'The instance was slow or unavailable. Try once more with a narrower query (fewer rows and fields); if it fails again, tell the user.';
    return null;
  };

  const post: HookCallbackMatcher = { hooks: [async (input: any) => {
    calls++;
    const tool = String(input.tool_name ?? '');
    const out = text(input.tool_response);
    const isError = /"isError":\s*true|^Error:|"is_error":\s*true/.test(out);
    if (isError) { lessons?.failed(tool, input.tool_input, out); const a = adviseOnError(tool, out); if (a) return hint(a); }
    else { failures.delete(tool); lessons?.worked(tool, input.tool_input); }
    if (calls === 30) return hint("You've made 30 tool calls in this answer. Unless the task is a build, wrap up: answer with what you have and say what's left.");
    return {};
  }] };
  const failure: HookCallbackMatcher = { hooks: [async (input: any) => {
    lessons?.failed(String(input.tool_name ?? ''), input.tool_input, String(input.error ?? ''));
    const a = adviseOnError(String(input.tool_name ?? ''), String(input.error ?? ''));
    return a ? { hookSpecificOutput: { hookEventName: 'PostToolUseFailure' as const, additionalContext: a } } : {};
  }] };
  return { PostToolUse: [post], PostToolUseFailure: [failure] } as Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}
