import { describe, expect, it } from 'vitest';
import { BUDGET_CHOICES, answerCost, budgetGate, budgetNotice, heldNow, releaseBudget, reserveBudget, spentToday, startOfDay, stoppedEarly, usd } from '../src/server/budget.ts';
import { MODE_CONFIG } from '../src/server/prompts.ts';
import { perf } from '../src/server/db.ts';

const row = (at: number, cost: number | null) => perf.add({ at, chat_id: 'budget-chat', mode: 'explore', start_ms: 1, first_word_ms: 1, total_ms: 1, tools: [], cost_usd: cost });

describe('daily spending limit', () => {
  it('is off by default and never refuses or caps', () => {
    expect(budgetGate(0, 999)).toEqual({});
    expect(budgetNotice(0, 0, 999)).toBeNull();
  });

  it('lets an answer spend half of what is left, and refuses once the day is used up', () => {
    expect(budgetGate(5, 1.5)).toEqual({ maxBudgetUsd: 1.75 });
    expect(budgetGate(5, 5)).toHaveProperty('refuse');
    expect((budgetGate(5, 6.2) as { refuse: string }).refuse).toMatch(/Today's spending limit \(\$5\.00\) is used up: about \$6\.20/);
  });

  it('keeps parallel answers inside the limit together, and frees a share when its answer ends', () => {
    const shares = ['a', 'b', 'c', 'd'].map((id) => reserveBudget(`par-${id}`, 10, 2) as { maxBudgetUsd: number });
    expect(shares.map((s) => s.maxBudgetUsd)).toEqual([4, 2, 1, 0.5]);
    expect(heldNow()).toBeLessThanOrEqual(8);
    expect(budgetGate(10, 2, 7.995)).toHaveProperty('refuse');
    expect((budgetGate(10, 2, 8) as { refuse: string }).refuse).toMatch(/reserved by answers running in other chats/);
    for (const id of ['a', 'b', 'c', 'd']) releaseBudget(`par-${id}`);
    expect(heldNow()).toBe(0);
    expect(reserveBudget('par-a', 0, 99)).toEqual({});
    expect(heldNow()).toBe(0);
  });

  it('warns once when the day first crosses 80%, and says when the limit is reached', () => {
    expect(budgetNotice(10, 5, 7.9)).toBeNull();
    expect(budgetNotice(10, 7.9, 8.2)).toMatch(/About \$8\.20 of today's \$10\.00 limit is used \(82%\)/);
    expect(budgetNotice(10, 8.2, 9)).toBeNull();
    expect(budgetNotice(10, 7, 10.4)).toMatch(/limit \(\$10\.00\) is reached/);
  });

  it('adds up today only', () => {
    const before = spentToday();
    row(startOfDay() - 1000, 3);
    row(Date.now(), 0.25);
    row(Date.now(), null);
    expect(spentToday() - before).toBeCloseTo(0.25);
  });

  it('only accepts the offered limits', () => {
    expect(BUDGET_CHOICES[0]).toBe(0);
    expect(BUDGET_CHOICES.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });

  it('shows small amounts with three decimals', () => {
    expect(usd(0.0042)).toBe('$0.004');
    expect(usd(1.5)).toBe('$1.50');
  });
});

describe('step limits', () => {
  it('stay low enough to notice, Build and Debug get the most room', () => {
    expect(MODE_CONFIG.build.maxTurns).toBeLessThanOrEqual(80);
    for (const m of ['explore', 'mockup', 'decide'] as const) expect(MODE_CONFIG[m].maxTurns).toBeLessThan(MODE_CONFIG.debug.maxTurns);
    expect(MODE_CONFIG.debug.maxTurns).toBeLessThan(MODE_CONFIG.build.maxTurns);
  });

  it('say in plain words why an answer stopped', () => {
    expect(stoppedEarly('error_max_turns', 0, 80)).toBe('Pip used all 80 steps one answer can take in this mode, so it stopped here. Say "continue" to pick up where it left off.');
    expect(stoppedEarly('error_max_budget_usd', 5, 80)).toMatch(/share of today's spending limit \(\$5\.00\)/);
    expect(stoppedEarly('error_during_execution', 0, 80)).toBe('The answer stopped early (error_during_execution).');
  });
});

describe('an answer when the day is used up', () => {
  it('is refused before it starts, with the reason kept in the chat', async () => {
    const { chats, messages, settings } = await import('../src/server/db.ts');
    const { runChat } = await import('../src/server/agent.ts');
    settings.set({ dailyBudgetUsd: 2 });
    row(Date.now(), 2.5);
    const chat = chats.create('explore', null);
    const events: any[] = [];
    await runChat(chat.id, 'What is a business rule?', (e) => events.push(e));
    expect(events.map((e) => e.t)).toEqual(['notice', 'done']);
    expect(events[0].text).toMatch(/Today's spending limit \(\$2\.00\) is used up/);
    const saved = messages.list(chat.id);
    expect(saved.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(saved[1].blocks[0]).toMatchObject({ type: 'notice', level: 'warn' });
    settings.set({ dailyBudgetUsd: 0 });
  });
});

describe('one answer\'s cost in a resumed chat', () => {
  // Measured with the Agent SDK: three answers in one resumed session reported 0.00165, 0.00238, 0.00320.
  it('is the difference from the last running total in the same session', () => {
    expect(answerCost(0.00165, 's1', null)).toBeCloseTo(0.00165);
    expect(answerCost(0.00238, 's1', { session: 's1', total: 0.00165 })).toBeCloseTo(0.00073);
    expect(answerCost(0.0032, 's1', { session: 's1', total: 0.00238 })).toBeCloseTo(0.00082);
  });
  it('counts in full after a new session or a reset total, and stays unknown when the SDK gave none', () => {
    expect(answerCost(0.5, 's2', { session: 's1', total: 2 })).toBe(0.5);
    expect(answerCost(0.5, 's1', { session: 's1', total: 2 })).toBe(0.5);
    expect(answerCost(null, 's1', { session: 's1', total: 2 })).toBeNull();
  });
});
