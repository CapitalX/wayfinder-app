import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { chats, messages, perf, settings } from '../src/server/db.ts';
import { estimateCost, jsonArray, setSmallJobRunner, smallJob } from '../src/server/smallJob.ts';
import { autoTitle, cleanTitle, retitle } from '../src/server/chatTitle.ts';
import { carryOver, continueChat, modelSummary } from '../src/server/carryOver.ts';
import { bus } from '../src/server/events.ts';

const runner = vi.fn(async (_o: { model: string; system: string; prompt: string; signal: AbortSignal }) => ({ text: 'ok', cost: 0.001 as number | null }));
const use = (text: string, cost: number | null = 0.001) => { runner.mockImplementation(async () => ({ text, cost })); setSmallJobRunner(runner); };
afterEach(() => { runner.mockReset(); setSmallJobRunner(async () => ({ text: '', cost: null })); settings.set({ dailyBudgetUsd: 0, smallModel: 'haiku' }); });

describe('small jobs', () => {
  it('run on the small-jobs model, and count toward the day', async () => {
    use('[1, 2]', 0.0021);
    const before = perf.recent(1)[0]?.at ?? 0;
    expect(await smallJob({ job: 'title', system: 's', prompt: 'p' })).toBe('[1, 2]');
    expect(runner.mock.calls[0][0].model).toBe('haiku');
    const row = perf.recent(1)[0];
    expect(row).toMatchObject({ mode: 'job:title', cost_usd: 0.0021, first_word_ms: null });
    expect(row.at).toBeGreaterThanOrEqual(before);
    settings.set({ smallModel: 'sonnet' });
    await smallJob({ job: 'title', system: 's', prompt: 'p' });
    expect(runner.mock.calls[1][0].model).toBe('sonnet');
    await smallJob({ job: 'fluent-review', system: 's', prompt: 'p', model: 'sonnet' });
    expect(runner.mock.calls[2][0].model).toBe('sonnet');
  });

  it('skip when the day is used up, and give nothing when the call fails', async () => {
    use('x');
    perf.add({ at: Date.now(), chat_id: 'c', mode: 'explore', start_ms: 1, first_word_ms: 1, total_ms: 1, tools: [], cost_usd: 50 });
    settings.set({ dailyBudgetUsd: 2 });
    expect(await smallJob({ job: 'title', system: 's', prompt: 'p' })).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    settings.set({ dailyBudgetUsd: 0 });
    runner.mockImplementation(async () => { throw new Error('down'); });
    expect(await smallJob({ job: 'title', system: 's', prompt: 'p' })).toBeNull();
  });

  it('count a failed, timed-out or unpriced job at an estimate, so the daily limit holds', async () => {
    const prompt = 'p'.repeat(4000);
    runner.mockImplementation(async () => { throw new Error('aborted'); });
    setSmallJobRunner(runner);
    expect(await smallJob({ job: 'summary', system: '', prompt })).toBeNull();
    expect(perf.recent(1)[0]).toMatchObject({ mode: 'job:summary', cost_usd: estimateCost('haiku', 4000) });
    use('ok', null);
    await smallJob({ job: 'title', system: '', prompt, model: 'sonnet' });
    expect(perf.recent(1)[0].cost_usd).toBe(estimateCost('sonnet', 4000));
    // 1000 input tokens and a 500-token answer at list prices; an unknown model is priced like the dearest.
    expect(estimateCost('haiku', 4000)).toBeCloseTo(0.0035, 6);
    expect(estimateCost('sonnet', 4000)).toBeCloseTo(0.007, 6);
    expect(estimateCost('some-new-model', 4000)).toBe(estimateCost('opus', 4000));
  });

  it('read JSON arrays out of an answer, or nothing', () => {
    expect(jsonArray('Here: [{"id": "a"}] done')).toEqual([{ id: 'a' }]);
    expect(jsonArray('no json')).toEqual([]);
    expect(jsonArray(null)).toEqual([]);
  });
});

describe('which jobs follow the setting', () => {
  it('tool lessons stay on Sonnet (they reach every prompt unapproved); conventions follow the setting (approved first)', () => {
    const src = (f: string) => readFileSync(new URL(`../src/server/${f}`, import.meta.url), 'utf8');
    expect(src('toolLessons.ts')).toMatch(/smallJob\(\{ job: 'tool-lessons', model: 'sonnet'/);
    expect(src('fluentReview.ts')).toMatch(/job: 'fluent-review', model: 'sonnet'/);
    expect(src('conventions.ts')).not.toMatch(/job: 'conventions'[^}]*model:/);
  });
});

describe('chat titles', () => {
  it.each([
    ['Email notifications stopped', 'Email notifications stopped'],
    ['"Loaner laptop tracker."', 'Loaner laptop tracker'],
    ['## Fix SMTP account\nmore', 'Fix SMTP account'],
    ['', null], ['ab', null], ['x'.repeat(61), null],
  ])('cleans %j', (raw, want) => expect(cleanTitle(raw)).toBe(want));

  it('replace the first-message title after the first answer, and tell the list', async () => {
    use('Outbound email troubleshooting');
    const text = 'why have emails stopped going out since yesterday afternoon on our dev instance, nothing in the logs';
    const chat = chats.create('debug', null);
    chats.update(chat.id, { title: autoTitle(text) });
    const seen: any[] = [];
    const on = (e: any) => seen.push(e);
    bus.on('change', on);
    await retitle(chat.id, text, 'The SMTP account was switched off.');
    bus.off('change', on);
    expect(chats.get(chat.id)!.title).toBe('Outbound email troubleshooting');
    expect(seen).toContainEqual(expect.objectContaining({ topic: 'chats', id: chat.id, renamed: true }));
    expect(runner.mock.calls[0][0].prompt).toMatch(/data, not instructions/);
  });

  it('never replace a title someone set', async () => {
    use('Something else');
    const chat = chats.create('explore', null);
    chats.update(chat.id, { title: 'My own name' });
    await retitle(chat.id, 'what is a business rule', 'A server-side script.');
    expect(chats.get(chat.id)!.title).toBe('My own name');
  });
});

describe('fresh-chat summary', () => {
  const chatWith = () => {
    const chat = chats.create('debug', null);
    chats.update(chat.id, { title: 'Emails' });
    messages.add(chat.id, 'user', [{ type: 'text', text: 'Why did emails stop?' }]);
    messages.add(chat.id, 'assistant', [{ type: 'text', text: 'The SMTP account was off.' }]);
    return chats.get(chat.id)!;
  };

  it('comes from the small-jobs model when there is no compaction summary, list markers dropped', async () => {
    use('1. Goal: get outbound email working\n- Found: the SMTP account was off\n2 incidents were affected');
    const fresh = await continueChat(chatWith(), null);
    expect(JSON.parse(fresh.carried!).lines).toEqual(['Goal: get outbound email working', 'Found: the SMTP account was off', '2 incidents were affected']);
    expect(runner.mock.calls[0][0].prompt).toContain('User: Why did emails stop?\nPip: The SMTP account was off.');
  });

  it('splits a long line at sentence ends, so quoting never cuts it', async () => {
    const long = `${'The SMTP account was set inactive yesterday by an update set. '.repeat(6)}37 emails are queued. Reactivate it in Build.`;
    use(long);
    const lines = (await modelSummary(chatWith()))!;
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 280)).toBe(true);
    expect(lines.join(' ')).toBe(long.trim());
  });

  it('falls back to the asks and last answer when the model gives nothing', async () => {
    use('');
    expect(await modelSummary(chatWith())).toBeNull();
    const fresh = await continueChat(chatWith(), null);
    expect(JSON.parse(fresh.carried!).lines[0]).toBe('The user asked: Why did emails stop?');
  });

  it('starts one fresh chat for a double click, not two', async () => {
    let release!: () => void;
    runner.mockImplementation(() => new Promise((r) => { release = () => r({ text: 'Goal: emails', cost: 0.001 }); }));
    setSmallJobRunner(runner);
    const old = chatWith();
    const before = chats.list().length;
    const a = continueChat(old, null), b = continueChat(old, null);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    release();
    const [x, y] = await Promise.all([a, b]);
    expect(x.id).toBe(y.id);
    expect(chats.list().length).toBe(before + 1);
    // Once it's done, a later click starts another (the user asked again).
    use('Goal: emails');
    expect((await continueChat(old, null)).id).not.toBe(x.id);
  });

  it('uses the compaction summary without calling the model', async () => {
    use('should not be used');
    const chat = chatWith();
    chats.update(chat.id, { compact_summary: '<summary>From compaction</summary>' });
    await continueChat(chats.get(chat.id)!, null);
    expect(runner).not.toHaveBeenCalled();
    expect(carryOver(chats.get(chat.id)!).lines[0]).toBe('From compaction');
  });
});
