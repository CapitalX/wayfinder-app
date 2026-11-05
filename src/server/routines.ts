import { z } from 'zod';
import { audit, chats, instances, projects, routines, type Routine } from './db.ts';
import { QUICK } from './insights.ts';
import { WRITES_IN } from './modeTools.ts';
import { MODES, type Mode } from './prompts.ts';
import { runChat } from './agent.ts';
import { dayWords, parts, zone, zoned } from './clock.ts';

// Routines: a question Pip answers on a schedule (every hour, day or week), each run in a fresh chat titled after the
// routine. Nobody is watching a run, so routines only get the read-only modes: an approval card would just time out,
// and a routine can never change the instance. Runs count toward the daily budget like any answer (budget.ts).

const READ_ONLY_MODES = (Object.keys(MODES) as Mode[]).filter((m) => !WRITES_IN[m]);
export const routineSchema = z.object({
  title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(4000),
  mode: z.enum(READ_ONLY_MODES as [Mode, ...Mode[]]),
  every: z.enum(['hour', 'day', 'week']),
  hour: z.number().int().min(0).max(23).default(8),
  weekday: z.number().int().min(0).max(6).default(1),
  project_id: z.string().max(100).nullable().default(null),
  enabled: z.boolean().default(true),
}).strict();

// The next time a routine is due after `from`, on the user's clock (clock.ts): the next whole hour, the next
// `hour`:00, or the next `weekday` at `hour`:00. Always strictly later than `from`, so a run never lands twice on the
// same slot. Days are stepped on the wall calendar, so a DST switch neither skips nor doubles a run.
export function nextRun(r: Pick<Routine, 'every' | 'hour' | 'weekday'>, from = Date.now(), tz = zone()): number {
  if (r.every === 'hour') return (Math.floor(from / 3_600_000) + 1) * 3_600_000;
  const p = parts(from, tz);
  let day = Date.UTC(p.y, p.m - 1, p.d);
  if (r.every === 'week') day += ((r.weekday - p.weekday + 7) % 7) * 86_400_000;
  const at = (d: number) => { const u = new Date(d); return zoned(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), r.hour, tz); };
  while (at(day) <= from) day += (r.every === 'week' ? 7 : 1) * 86_400_000;
  return at(day);
}

export function saveRoutine(raw: unknown, id?: string): Routine {
  const parsed = routineSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid routine. Check the title, prompt, mode and schedule.');
  const v = parsed.data;
  if (v.project_id && !projects.get(v.project_id)) throw new Error('No such project.');
  const row = { ...v, enabled: v.enabled ? 1 : 0, next_run_at: nextRun(v) };
  if (id) {
    if (!routines.get(id)) throw new Error('No such routine.');
    routines.update(id, row);
  }
  const saved = id ? routines.get(id)! : routines.add(row);
  // A routine spends on its own while nobody is watching, so the log says who set one up and when.
  audit.add(null, null, 'routine', { title: v.title, mode: v.mode, every: v.every, enabled: v.enabled }, id ? 'changed' : 'created', saved.id);
  return saved;
}

// Starting points for the form: the one-click Insights checks (log errors, failed jobs, changed ACLs…).
export const templates = () => QUICK.map((q) => ({ id: q.id, label: q.label, mode: q.mode, prompt: q.prompt }));

export const UNATTENDED = 'This runs unattended on a schedule: nobody is watching to answer a question or approve anything, so work from what you can read and end with a short report of what you found and what deserves a look.';
export const scheduleWords = (r: Pick<Routine, 'every' | 'hour' | 'weekday'>) => {
  const at = `${String(r.hour).padStart(2, '0')}:00`;
  return r.every === 'hour' ? 'every hour' : r.every === 'day' ? `every day at ${at}` : `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][r.weekday]} at ${at}`;
};

export type Run = (chatId: string, text: string, emit: () => void, opts: { system: string }) => Promise<void>;

// One run: a fresh chat on the active instance (and the routine's project), the schedule moved on first so a failed
// run doesn't repeat every minute, then Pip's answer with the routine's prompt as the chat's opening note.
export function runRoutine(r: Routine, run: Run = runChat): { chatId: string; done: Promise<void> } {
  const project = r.project_id ? projects.get(r.project_id) : undefined;
  const chat = chats.create(r.mode, instances.active()?.id ?? null, project?.id ?? null);
  chats.update(chat.id, { title: `${r.title} · ${dayWords()}`, routine_id: r.id });
  routines.update(r.id, { last_run_at: Date.now(), last_chat_id: chat.id, next_run_at: nextRun(r) });
  const done = run(chat.id, `${r.prompt}\n\n${UNATTENDED}`, () => {}, { system: `Routine “${r.title}” ran on its schedule (${scheduleWords(r)}). Asked: ${r.prompt}` })
    .catch((e) => console.error('routine run failed', r.id, (e as Error).message));
  return { chatId: chat.id, done };
}

// Every routine that is due runs, one after another, so a busy hour can't start many answers at once. A routine
// whose last run is still answering waits for the next slot instead of piling up.
export async function runDue(now = Date.now(), run: Run = runChat): Promise<Routine[]> {
  const ran: Routine[] = [];
  for (const r of routines.due(now)) {
    if (r.last_chat_id && chats.get(r.last_chat_id)?.answering_since) { routines.update(r.id, { next_run_at: nextRun(r, now) }); continue; }
    ran.push(r);
    await runRoutine(r, run).done;
  }
  return ran;
}

let busy = false;
export function startRoutines() {
  setInterval(() => {
    if (busy) return;
    busy = true;
    runDue().finally(() => { busy = false; });
  }, 60_000);
}
