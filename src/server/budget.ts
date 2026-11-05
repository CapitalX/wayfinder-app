import { perf } from './db.ts';

// What answers cost today, against the optional daily limit in Settings. Costs are the Agent SDK's estimate per answer
// (not a bill). The limit warns once at 80%, and at 100% Wayfinder stops starting answers until the next day; an
// answer that reaches its share is stopped by the SDK (maxBudgetUsd, see budgetGate).

export const WARN_AT = 0.8;
export const BUDGET_CHOICES = [0, 2, 5, 10, 20, 50]; // dollars per day; 0 is off

export const startOfDay = (at = Date.now()) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const spentToday = (at = Date.now()) => perf.costSince(startOfDay(at));

export const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

// A resumed chat reports its running total (the SDK's total_cost_usd carries the earlier answers of the same session),
// so one answer's cost is the difference from the last total seen in that session. A new session, or a total that went
// down (the session was reset), counts in full.
export interface CostSnapshot { session: string; total: number }
export function answerCost(total: number | null, session: string, prev: CostSnapshot | null): number | null {
  if (total === null) return null;
  return prev && prev.session === session && total >= prev.total ? total - prev.total : total;
}

// Before an answer: refused when the day's limit is used up, else the most this answer may spend. `held` is what
// answers still running have reserved; each new answer gets half of what's free, so parallel chats together stay
// inside the limit (spend is only recorded when an answer ends).
export function budgetGate(limit: number, spent: number, held = 0): { refuse: string } | { maxBudgetUsd?: number } {
  if (!limit) return {};
  if (spent >= limit) return { refuse: `Today's spending limit (${usd(limit)}) is used up: about ${usd(spent)} so far. Raise it in Settings → Pip, or carry on tomorrow.` };
  const free = limit - spent - held;
  if (free < 0.01) return { refuse: `The rest of today's spending limit (${usd(limit)}) is reserved by answers running in other chats. Try again when one finishes, or raise the limit in Settings → Pip.` };
  return { maxBudgetUsd: free / 2 };
}

// Reservations of running answers, one per chat (a chat runs one answer at a time). Released when the answer ends.
const held = new Map<string, number>();
export const heldNow = () => [...held.values()].reduce((a, b) => a + b, 0);
export function reserveBudget(chatId: string, limit: number, spent: number) {
  held.delete(chatId);
  const gate = budgetGate(limit, spent, heldNow());
  if ('maxBudgetUsd' in gate && gate.maxBudgetUsd) held.set(chatId, gate.maxBudgetUsd);
  return gate;
}
export const releaseBudget = (chatId: string) => { held.delete(chatId); };

// After an answer: one note when the day first crosses 80% of the limit.
export function budgetNotice(limit: number, before: number, after: number): string | null {
  if (!limit || before >= limit * WARN_AT || after < limit * WARN_AT) return null;
  return after >= limit
    ? `Today's spending limit (${usd(limit)}) is reached: about ${usd(after)} so far. New answers wait until tomorrow, or raise the limit in Settings → Pip.`
    : `About ${usd(after)} of today's ${usd(limit)} limit is used (${Math.round((after / limit) * 100)}%).`;
}

// Why an answer stopped early, in plain words.
export function stoppedEarly(subtype: string, limit: number, maxTurns: number): string {
  if (subtype === 'error_max_turns') return `Pip used all ${maxTurns} steps one answer can take in this mode, so it stopped here. Say "continue" to pick up where it left off.`;
  if (subtype === 'error_max_budget_usd') return `Stopped: this answer used its share of today's spending limit (${usd(limit)}). Say "continue" to go on with what's left, or raise the limit in Settings → Pip.`;
  return `The answer stopped early (${subtype}).`;
}

// Working time of an answer so far: wall time minus the time spent waiting on approval cards (finished waits, plus any
// card still open). An answer past its mode's maxMinutes is stopped with a plain note.
export function workedMs(now: number, t0: number, waitedMs: number, openSince: Iterable<number>): number {
  let open = 0;
  for (const s of openSince) open += Math.max(0, now - s);
  return Math.max(0, now - t0 - waitedMs - open);
}
export const workLimitNote = (minutes: number, mode: string) =>
  `Stopped after ${minutes} minutes of work, the limit for one ${mode} answer. Say "continue" to pick up where it left off.`;
