import { useEffect, useState } from 'react';
import { api, type Project } from '../api.ts';
import { useLive } from '../live.ts';

// Routines: a question Pip answers on a schedule, each run a chat of its own (read-only modes only; see routines.ts).
type Routine = { id: string; title: string; prompt: string; mode: string; every: 'hour' | 'day' | 'week'; hour: number; weekday: number; project_id: string | null; enabled: number; next_run_at: number; last_run_at: number | null; last_chat_id: string | null };
type Template = { id: string; label: string; mode: string; prompt: string };
type Draft = Omit<Routine, 'id' | 'next_run_at' | 'last_run_at' | 'last_chat_id'>;
const EMPTY: Draft = { title: '', prompt: '', mode: 'debug', every: 'day', hour: 8, weekday: 1, project_id: null, enabled: 1 };
const MODES = ['explore', 'debug', 'decide', 'mockup'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const at = (h: number) => `${String(h).padStart(2, '0')}:00`;
const scheduleWords = (r: Pick<Routine, 'every' | 'hour' | 'weekday'>) => (r.every === 'hour' ? 'every hour' : r.every === 'day' ? `every day at ${at(r.hour)}` : `every ${DAYS[r.weekday]} at ${at(r.hour)}`);
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const body = (d: Draft) => ({ title: d.title, prompt: d.prompt, mode: d.mode, every: d.every, hour: d.hour, weekday: d.weekday, project_id: d.project_id, enabled: !!d.enabled });

export function Routines({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const [list, setList] = useState<Routine[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => { api<Routine[]>('/routines').then(setList).catch((e) => setError(e.message)); };
  useEffect(() => { load(); api<Template[]>('/routines/templates').then(setTemplates).catch(() => {}); api<Project[]>('/projects').then(setProjects).catch(() => {}); }, []);
  useLive('routines', load);
  const mutate = async (path: string, method: string, payload: unknown = {}) => {
    setBusy(true); setError('');
    try { setList(await api<Routine[]>(path, { method, body: payload })); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft) return;
    if (await mutate(editing ? `/routines/${editing}` : '/routines', editing ? 'PUT' : 'POST', body(draft))) setDraft(null);
  };
  const runNow = async (r: Routine) => {
    setBusy(true); setError('');
    try { const { chat_id } = await api<{ chat_id: string }>(`/routines/${r.id}/run`, { body: {} }); onOpenChat(chat_id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <p className="muted">A routine asks Pip the same question on a schedule, in a fresh chat each time, so a report is waiting for you: new log errors, failed jobs, what changed this week. Routines only read the instance (nobody is there to approve a change) and count toward the daily budget.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {list.map((r) => <section className="card set-card" key={r.id} aria-label={r.title}>
      <h3>{r.title}</h3>
      <p className="small muted">{scheduleWords(r)} · {r.mode}{r.project_id ? ` · ${projects.find((p) => p.id === r.project_id)?.name ?? 'project'}` : ''}</p>
      <p className="small">{r.enabled ? `Next run ${when(r.next_run_at)}` : 'Paused'}{r.last_run_at ? ` · last ran ${when(r.last_run_at)}` : ''}</p>
      <label className="toggle"><input type="checkbox" checked={!!r.enabled} disabled={busy} onChange={(e) => void mutate(`/routines/${r.id}`, 'PUT', { ...body(r), enabled: e.target.checked })} />Run {r.title} on its schedule</label>
      <div className="row-actions wrap">
        <button disabled={busy} onClick={() => void runNow(r)}>Run {r.title} now</button>
        {r.last_chat_id && <button disabled={busy} onClick={() => onOpenChat(r.last_chat_id!)}>Open last run</button>}
        <button disabled={busy} onClick={() => { setDraft(r); setEditing(r.id); setError(''); }}>Edit {r.title}</button>
        <button disabled={busy} onClick={() => void mutate(`/routines/${r.id}`, 'DELETE')}>Remove {r.title}</button>
      </div>
    </section>)}
    {!draft ? <button onClick={() => { setDraft(EMPTY); setEditing(null); setError(''); }}>Add routine</button> : <form className="card set-card routine-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3>{editing ? 'Edit routine' : 'Add routine'}</h3>
      {!!templates.length && <label className="field">Start from<select value="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) setDraft({ ...draft, title: draft.title || t.label, prompt: t.prompt, mode: t.mode }); }}>
        <option value="">A check from Insights…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>}
      <label className="field">Title<input required value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <label className="field">What to ask Pip<textarea required value={draft.prompt} maxLength={4000} rows={4} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} /></label>
      <label className="field">Mode<select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>{MODES.map((m) => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}</select></label>
      <label className="field">Every<select value={draft.every} onChange={(e) => setDraft({ ...draft, every: e.target.value as Routine['every'] })}><option value="hour">Hour</option><option value="day">Day</option><option value="week">Week</option></select></label>
      {draft.every === 'week' && <label className="field">On<select value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
      {draft.every !== 'hour' && <label className="field">At<select value={draft.hour} onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{at(h)}</option>)}</select></label>}
      {!!projects.length && <label className="field">Project<select value={draft.project_id ?? ''} onChange={(e) => setDraft({ ...draft, project_id: e.target.value || null })}><option value="">None</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <div className="row-actions wrap"><button className="primary" disabled={busy} type="submit">Save routine</button><button disabled={busy} type="button" onClick={() => setDraft(null)}>Cancel</button></div>
    </form>}
  </>;
}
