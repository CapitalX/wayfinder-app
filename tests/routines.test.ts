import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, chats, instances, projects, routines } from '../src/server/db.ts';
import { nextRun, routineSchema, runDue, runRoutine, saveRoutine, scheduleWords, templates, UNATTENDED, type Run } from '../src/server/routines.ts';

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const base = { title: 'Log errors', prompt: 'Summarise new log errors.', mode: 'debug', every: 'day', hour: 8, weekday: 1 };
beforeEach(() => { for (const r of routines.list()) routines.remove(r.id); });

describe('nextRun', () => {
  // 2026-10-28 is a Wednesday.
  it('hourly: the next whole hour, strictly later', () => {
    expect(nextRun({ every: 'hour', hour: 0, weekday: 0 }, local(2026, 10, 28, 9, 20))).toBe(local(2026, 10, 28, 10));
    expect(nextRun({ every: 'hour', hour: 0, weekday: 0 }, local(2026, 10, 28, 10))).toBe(local(2026, 10, 28, 11));
  });
  it('daily: today at the hour if still ahead, else tomorrow', () => {
    expect(nextRun({ every: 'day', hour: 8, weekday: 0 }, local(2026, 10, 28, 7, 59))).toBe(local(2026, 10, 28, 8));
    expect(nextRun({ every: 'day', hour: 8, weekday: 0 }, local(2026, 10, 28, 8))).toBe(local(2026, 10, 29, 8));
    expect(nextRun({ every: 'day', hour: 8, weekday: 0 }, local(2026, 10, 28, 9))).toBe(local(2026, 10, 29, 8));
  });
  it('weekly: the next such weekday at the hour, a week ahead when that is today and past', () => {
    expect(nextRun({ every: 'week', hour: 8, weekday: 1 }, local(2026, 10, 28, 9))).toBe(local(2026, 11, 2, 8));
    expect(nextRun({ every: 'week', hour: 8, weekday: 3 }, local(2026, 10, 28, 7))).toBe(local(2026, 10, 28, 8));
    expect(nextRun({ every: 'week', hour: 8, weekday: 3 }, local(2026, 10, 28, 9))).toBe(local(2026, 11, 4, 8));
  });
  it('says the schedule in words', () => {
    expect(scheduleWords({ every: 'hour', hour: 8, weekday: 1 })).toBe('every hour');
    expect(scheduleWords({ every: 'day', hour: 8, weekday: 1 })).toBe('every day at 08:00');
    expect(scheduleWords({ every: 'week', hour: 17, weekday: 5 })).toBe('every Friday at 17:00');
  });
});

describe('saving a routine', () => {
  it.each([{ mode: 'build' }, { mode: 'nope' }, { prompt: '' }, { title: ' ' }, { hour: 24 }, { weekday: 7 }, { every: 'minute' }, { extra: 1 }])('refuses %o', (bad) => {
    expect(routineSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    expect(() => saveRoutine({ ...base, ...bad })).toThrow('Invalid routine');
  });
  it('saves with the next run ahead, audits it, edits in place and checks the project', () => {
    const before = Date.now();
    const r = saveRoutine(base);
    expect(r.enabled).toBe(1);
    expect(r.next_run_at).toBeGreaterThan(before);
    expect(routines.list().map((x) => x.id)).toEqual([r.id]);
    expect((audit.recent(1)[0] as { tool: string; decision: string }).tool).toBe('routine');
    const edited = saveRoutine({ ...base, title: 'Renamed', every: 'hour', enabled: false }, r.id);
    expect(edited.id).toBe(r.id);
    expect(routines.get(r.id)).toMatchObject({ title: 'Renamed', every: 'hour', enabled: 0 });
    expect(() => saveRoutine(base, 'missing')).toThrow('No such routine');
    expect(() => saveRoutine({ ...base, project_id: 'missing' })).toThrow('No such project');
  });
  it('offers the Insights checks as templates, read-only modes only', () => {
    const t = templates();
    expect(t.length).toBeGreaterThan(3);
    for (const x of t) expect(routineSchema.safeParse({ ...base, mode: x.mode, prompt: x.prompt }).success).toBe(true);
  });
});

describe('running', () => {
  it('a run opens a chat titled after the routine, on the active instance and project, with the unattended note', async () => {
    const inst = instances.create({ name: 'dev', url: 'https://dev12345.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    const project = projects.create('Loaners');
    const r = saveRoutine({ ...base, project_id: project.id });
    const run = vi.fn<Run>().mockResolvedValue();
    const { chatId, done } = runRoutine(r, run);
    await done;
    const chat = chats.get(chatId)!;
    expect(chat).toMatchObject({ mode: 'debug', instance_id: inst.id, project_id: project.id, routine_id: r.id });
    expect(chat.title.startsWith('Log errors · ')).toBe(true);
    expect(run).toHaveBeenCalledWith(chatId, `${base.prompt}\n\n${UNATTENDED}`, expect.any(Function), { system: expect.stringContaining('ran on its schedule (every day at 08:00)') });
    const after = routines.get(r.id)!;
    expect(after.last_chat_id).toBe(chatId);
    expect(after.next_run_at).toBeGreaterThan(Date.now());
  });
  it('runs only what is due, in order, one after another; a failed run is logged and still moves on', async () => {
    const due1 = saveRoutine({ ...base, title: 'First' }), due2 = saveRoutine({ ...base, title: 'Second' }), later = saveRoutine({ ...base, title: 'Later' }), off = saveRoutine({ ...base, title: 'Off', enabled: false });
    const now = Date.now();
    routines.update(due1.id, { next_run_at: now - 60_000 }); routines.update(due2.id, { next_run_at: now - 30_000 }); routines.update(off.id, { next_run_at: now - 30_000 });
    const order: string[] = [];
    let inFlight = 0, overlap = false;
    const run = vi.fn<Run>(async (chatId) => {
      inFlight++; if (inFlight > 1) overlap = true;
      order.push(chats.get(chatId)!.title.split(' · ')[0]);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (order.length === 1) throw new Error('model unavailable');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran = await runDue(now, run);
    expect(ran.map((r) => r.title)).toEqual(['First', 'Second']);
    expect(order).toEqual(['First', 'Second']);
    expect(overlap).toBe(false);
    expect(err).toHaveBeenCalledWith('routine run failed', due1.id, 'model unavailable');
    expect(routines.get(later.id)!.last_chat_id).toBeNull();
    expect(routines.get(off.id)!.last_chat_id).toBeNull();
    for (const r of [due1, due2]) expect(routines.get(r.id)!.next_run_at).toBeGreaterThan(now);
    err.mockRestore();
  });
  it('waits for the next slot while its last run is still answering', async () => {
    const r = saveRoutine(base);
    const run = vi.fn<Run>().mockResolvedValue();
    const { chatId } = runRoutine(r, run);
    chats.setAnswering(chatId, Date.now());
    const now = Date.now();
    routines.update(r.id, { next_run_at: now - 1000 });
    expect(await runDue(now, run)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(routines.get(r.id)!.next_run_at).toBeGreaterThan(now);
    chats.setAnswering(chatId, null);
    routines.update(r.id, { next_run_at: now - 1000 });
    expect((await runDue(now, run)).length).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
