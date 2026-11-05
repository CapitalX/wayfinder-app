import { useEffect, useState } from 'react';
import { api, type Memory, type Project } from '../api.ts';
import { useLive } from '../live.ts';
import { Pip } from './Pip.tsx';
import { AutoTextarea } from './AutoTextarea.tsx';
import { ConfirmButton } from './SettingsView.tsx';

// Everything Pip follows, in one place: your memories, suggestions you kept, your instance's naming rules and what
// Pip learned from builds and failed tool calls. Grouped by where each applies, with where it came from, and Edit,
// Pause and Delete. Suggestions wait in a queue, one at a time. Rules guide Pip; they never grant permission.
type Kind = 'memory' | 'convention' | 'tool' | 'fluent' | 'placement';
type Origin = 'you' | 'pip' | 'instance' | 'builds' | 'tool-calls' | 'placement' | 'placement-yours';
interface Conflict { id: string; text: string }
interface HubRule { kind: Kind; id: string; text: string; where: string; group: string; origin: Origin; paused: boolean; editable: boolean; readOnly?: boolean; conflict?: Conflict }
interface QueueItem { kind: 'memory' | 'fluent'; id: string; text: string; why: string; origin: Origin; group: string; conflict?: Conflict }
interface Hub { rules: HubRule[]; queue: QueueItem[]; words: number; budget: number; conventions_waiting: number; placement_file: string | null }

const ORIGIN: Record<Origin, string> = { you: 'You', pip: 'Pip suggested', instance: 'Your instance', builds: 'From builds', 'tool-calls': 'From failed calls', placement: 'Placement rule', 'placement-yours': 'Your placement rule' };
const WHERE_ORDER = ['all', 'project', 'instance', 'build', 'tools', 'placement'];
const short = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function MemoryView({ projects, onChanged }: { projects: Project[]; onChanged?: () => void }) {
  const [hub, setHub] = useState<Hub | null>(null);
  const [dismissed, setDismissed] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [error, setError] = useState('');
  const load = () => {
    api<Hub>('/memory-hub').then((h) => { setHub(h); onChanged?.(); }).catch((e) => setError((e as Error).message));
    api<Memory[]>('/memories?all=1').then((m) => setDismissed(m.filter((x) => x.status === 'dismissed'))).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  useLive('memories', load);
  useLive('lessons', load);
  useLive('conventions', load);

  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } load(); };
  const pause = (r: HubRule) => run(() => api('/memory-hub/pause', { body: { kind: r.kind, id: r.id, paused: !r.paused } }));
  const remove = (r: { kind: Exclude<Kind, 'placement'>; id: string }) => run(() => api('/memory-hub/delete', { body: { kind: r.kind, id: r.id } }));
  const saveEdit = (id: string) => run(async () => { await api(`/memories/${id}`, { method: 'PATCH', body: { text: editText } }); setEditing(null); });
  const review = (q: QueueItem, keep: boolean, text?: string) => run(async () => { await api('/memory-hub/review', { body: { kind: q.kind, id: q.id, keep, text } }); setEditing(null); });
  const add = () => run(async () => { if (!draft.trim()) return; await api('/memories', { body: { text: draft } }); setDraft(''); });

  if (!hub) return <div className="settings">{error && <p className="error small">{error}</p>}</div>;
  const active = hub.rules.filter((r) => !r.paused && !r.readOnly);
  const groups = [...new Set(hub.rules.slice().sort((a, b) => WHERE_ORDER.indexOf(a.where) - WHERE_ORDER.indexOf(b.where)).map((r) => r.group))];
  const over = hub.words > hub.budget;
  const next = hub.queue[0];

  const badges = (r: { origin: Origin; conflict?: Conflict }, paused?: boolean) => (
    <span className="mem-badges">
      <span className={`mem-badge origin-${r.origin}`}>{ORIGIN[r.origin]}</span>
      {paused && <span className="mem-badge paused">Paused</span>}
      {r.conflict && <span className="mem-badge conflict" title={r.conflict.text}>May conflict with: {short(r.conflict.text, 60)}</span>}
    </span>
  );

  const row = (r: HubRule) => (
    <div key={`${r.kind}:${r.id}`} className={`memory-row${r.paused ? ' is-paused' : ''}`}>
      {editing === r.id
        ? <AutoTextarea value={editText} onChange={setEditText} onSubmit={() => saveEdit(r.id)} submitHint="to save" label="Edit this rule" />
        : <p>{r.text}</p>}
      {badges(r, r.paused)}
      {!r.readOnly && <div className="row-actions">
        {editing === r.id
          ? <><button className="primary" onClick={() => saveEdit(r.id)} disabled={!editText.trim()}>Save</button><button onClick={() => setEditing(null)}>Cancel</button></>
          : r.editable && <button className="link" onClick={() => { setEditing(r.id); setEditText(r.text); }}>Edit</button>}
        {r.kind === 'memory' && r.where === 'project' && editing !== r.id && <button className="link" onClick={() => run(() => api(`/memories/${r.id}`, { method: 'PATCH', body: { scope: 'core' } }))}>Use in every chat</button>}
        <button className="link" onClick={() => pause(r)}>{r.paused ? 'Resume' : 'Pause'}</button>
        <ConfirmButton label="Delete" question={r.kind === 'memory' ? 'Delete this for good?' : 'Delete this rule? Pip stops following it.'} confirmLabel="Delete" className="link" onConfirm={() => remove(r as HubRule & { kind: Exclude<Kind, 'placement'> })} />
      </div>}
    </div>
  );

  return (
    <div className="settings memory-hub">
      <div className="home-pip"><Pip size={48} /><div><h1 style={{ margin: 0 }}>Memory</h1><p className="muted small" style={{ margin: 0 }}>Everything Pip follows when it works with you, grouped by where it applies. Rules guide Pip; they never give permission to change anything.</p></div></div>
      {error && <p className="error small" role="alert">{error}</p>}

      <div className={`mem-budget${over ? ' over' : ''}`}>
        <span>Pip reads <strong>{active.length} rule{active.length === 1 ? '' : 's'}</strong> · {hub.words.toLocaleString()} of {hub.budget.toLocaleString()} words</span>
        <span className="mem-meter" role="meter" aria-label="Words Pip reads" aria-valuemin={0} aria-valuemax={hub.budget} aria-valuenow={hub.words}><span style={{ width: `${Math.min(100, (hub.words / hub.budget) * 100)}%` }} /></span>
        {over && <span className="small warn-text">Over the budget: every answer gets slower and costs more, and Pip reads only the opening words of older memories. Pause or delete the ones you don't need.</span>}
      </div>

      {(next || hub.conventions_waiting > 0) && (
        <section className="card mem-queue" aria-labelledby="mem-queue-h">
          <h2 id="mem-queue-h">Waiting for you{hub.queue.length > 1 ? ` · 1 of ${hub.queue.length}` : ''}</h2>
          {next && (
            <div className="memory-row">
              {editing === next.id
                ? <AutoTextarea value={editText} onChange={setEditText} onSubmit={() => review(next, true, editText)} submitHint="to keep" label="Edit before keeping" />
                : <p>{next.text}</p>}
              <div className="ver">{next.group}{next.why ? ` · ${next.why}` : ''}</div>
              {badges(next)}
              <div className="row-actions">
                {editing === next.id
                  ? <><button className="primary" onClick={() => review(next, true, editText)} disabled={!editText.trim()}>Keep</button><button onClick={() => setEditing(null)}>Cancel</button></>
                  : <><button className="primary" onClick={() => review(next, true)}>Keep</button>
                    {next.kind === 'memory' && <button className="link" onClick={() => { setEditing(next.id); setEditText(next.text); }}>Edit</button>}
                    <button className="link" onClick={() => review(next, false)}>Not now</button></>}
              </div>
            </div>
          )}
          {hub.conventions_waiting > 0 && <p className="muted small">{hub.conventions_waiting} naming rule{hub.conventions_waiting === 1 ? '' : 's'} from your instance {hub.conventions_waiting === 1 ? 'is' : 'are'} waiting in Settings → Pip.</p>}
        </section>
      )}

      <section className="card" aria-labelledby="mem-active-h">
        <h2 id="mem-active-h">Active for this work</h2>
        {!hub.rules.length && <p className="muted small">Nothing yet. When Pip learns something worth keeping it asks you in the chat, or teach it something below.</p>}
        {groups.map((g) => {
          const rows = hub.rules.filter((r) => r.group === g);
          return (
            <div key={g} className="mem-group">
              <h3>{g} <span className="muted tiny">{rows[0].readOnly ? `${rows.length} rule${rows.length === 1 ? '' : 's'}` : `${rows.filter((r) => !r.paused).length} active${rows.some((r) => r.paused) ? `, ${rows.filter((r) => r.paused).length} paused` : ''}`}</span></h3>
              {rows[0].readOnly && <p className="muted small">Where Pip suggests new work should live, first match wins. Read-only here: change them in Settings → Pip → Placement rules (saved to <code className="break">{hub.placement_file}</code>).</p>}
              {rows.map(row)}
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>Teach Pip something</h2>
        <p className="muted small">A rule or a preference, in your own words. Pip reads it in every chat. It guides answers; it never gives permission to change anything.</p>
        <div className="inline-form">
          <AutoTextarea value={draft} onChange={setDraft} onSubmit={add} submitHint="to add" label="Teach Pip something" placeholder="e.g. Prefer Flow Designer over business rules for anything with approvals" />
          <button className="primary" onClick={add} disabled={!draft.trim()}>Add</button>
        </div>
      </section>

      {!!dismissed.length && (
        <details className="card">
          <summary><h2 style={{ display: 'inline' }}>Dismissed ({dismissed.length})</h2></summary>
          <p className="muted small">Suggestions you waved off. Keep one after all, or delete it for good.</p>
          {dismissed.map((m) => (
            <div key={m.id} className="memory-row">
              <p>{m.text}</p>
              <div className="ver">{m.scope === 'core' ? 'Every chat' : `Project · ${projects.find((p) => p.id === m.project_id)?.name ?? 'removed'}`}</div>
              <div className="row-actions">
                <button className="primary" onClick={() => run(() => api(`/memories/${m.id}`, { method: 'PATCH', body: { status: 'saved' } }))}>Keep after all</button>
                <button className="link danger" onClick={() => remove({ kind: 'memory', id: m.id })}>Delete</button>
              </div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
