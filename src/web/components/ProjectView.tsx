import { useEffect, useState } from 'react';
import { api, type ProjectData, type Saved } from '../api.ts';
import { MODES } from '../App.tsx';
import { AppCard } from './AppCards.tsx';
import { useWork } from '../work.ts';
import { useLive } from '../live.ts';
import { ComparePanel } from './ComparePanel.tsx';

const KIND: Record<Saved['kind'], string> = { decision: 'Decision', note: 'Note', script: 'Script', mockup: 'Mockup', spec: 'Spec' };

export function ProjectView({ projectId, reloadKey, onOpenChat, onNewChat, onChanged, onDeleted }: {
  projectId: string; reloadKey: string;
  onOpenChat: (id: string) => void; onNewChat: (mode: string) => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [data, setData] = useState<ProjectData | null>(null);
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [error, setError] = useState('');
  const work = useWork();
  const setPreview = (html: string) => work.preview(html);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);

  const load = () => api<ProjectData>(`/projects/${projectId}`).then((d) => {
    setData(d);
    setName(d.project?.name ?? '');
    setBrief((b) => (document.activeElement?.id === 'brief' ? b : d.project?.brief ?? ''));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [projectId, reloadKey]);
  // App statuses arrive live as installs and removals move.
  useLive('apps', () => load());

  const save = async (patch: { name?: string; brief?: string }) => {
    await api(`/projects/${projectId}`, { method: 'PATCH', body: patch });
    setSavedNote('Saved');
    setTimeout(() => setSavedNote(''), 1500);
    onChanged();
  };

  const removeItem = async (id: string) => {
    await api(`/saved/${id}`, { method: 'DELETE' });
    load();
  };

  const removeProject = async () => {
    if (!confirm('Delete this project? Its chats, saved items and apps are kept, just no longer grouped.')) return;
    await api(`/projects/${projectId}`, { method: 'DELETE' });
    onDeleted();
  };

  if (!data?.project) return <div className="settings"><p className="muted">{error || 'Loading…'}</p></div>;

  return (
    <div className="chat-layout">
      <div className="settings project-view">
        <div className="project-title">
          <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== data.project!.name && save({ name })} aria-label="Project name" />
          <button className="link danger" onClick={removeProject}>Delete project</button>
        </div>
        <p className="panel-intro">A project keeps one goal's chats, saved work, board and apps together. Every chat in it reads the brief.</p>

        <section className="card">
          <h2>Brief <span className="muted small">{savedNote}</span></h2>
          <p className="muted small">The goal in a few lines. Every chat in this project reads it, so answers stay aimed at it.</p>
          <textarea
            id="brief"
            rows={4}
            value={brief}
            placeholder="e.g. Prototype a loaner-equipment app for the field team and learn Fluent along the way."
            onChange={(e) => setBrief(e.target.value)}
            onBlur={() => brief !== data.project!.brief && save({ brief })}
          />
          <div className="mode-row">
            {Object.entries(MODES).map(([k, v]) => <button key={k} onClick={() => onNewChat(k)}>New {v.toLowerCase()} chat</button>)}
          </div>
        </section>

        {!!data.apps.length && (
          <section>
            <h2 className="sec-title">Apps</h2>
            {data.apps.map((a) => <AppCard key={a.id} app={a} onChanged={load} />)}
          </section>
        )}

        <section className="card">
          <h2>Saved</h2>
          {data.saved.filter((x) => x.kind === 'mockup').length >= 2 && (
            <p className="muted small compare-hint">
              Tick two mockups to compare them side by side.
              {picked.length === 2 && <button className="primary" onClick={() => setComparing(true)}>Compare</button>}
            </p>
          )}
          {!data.saved.length && <p className="muted small">Nothing saved yet. Use Save on a mockup, script or answer, or ask Claude to save a decision.</p>}
          {data.saved.map((s) => (
            <div key={s.id} className="saved-row">
              {s.kind === 'mockup' && data.saved.filter((x) => x.kind === 'mockup').length >= 2 && (
                <input type="checkbox" className="pick" aria-label={`Compare ${s.title}`} checked={picked.includes(s.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked.filter((x) => x !== s.id), s.id].slice(-2) : picked.filter((x) => x !== s.id))} />
              )}
              <button className="saved-head" onClick={() => setOpenItem(openItem === s.id ? null : s.id)}>
                <span className={`kind-chip kind-${s.kind}`}>{KIND[s.kind]}</span>
                <span className="chat-title">{s.title}</span>
                <span className="muted tiny">{new Date(s.created_at).toLocaleDateString()}</span>
              </button>
              {openItem === s.id && (
                <div className="saved-body">
                  {s.kind === 'mockup'
                    ? <button onClick={() => setPreview(s.content)}>Open preview</button>
                    : <pre className="output">{s.content}</pre>}
                  <div className="row-actions">
                    <button className="link" onClick={() => navigator.clipboard.writeText(s.content)}>Copy</button>
                    {s.chat_id && <button className="link" onClick={() => onOpenChat(s.chat_id!)}>Open chat</button>}
                    <button className="link danger" onClick={() => removeItem(s.id)}>Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Chats</h2>
          {!data.chats.length && <p className="muted small">No chats yet. Start one above.</p>}
          {data.chats.map((c) => (
            <button key={c.id} className="saved-head" onClick={() => onOpenChat(c.id)}>
              <span className={`mode-chip mode-${c.mode}`}>{MODES[c.mode] ?? c.mode}</span>
              <span className="chat-title">{c.title}</span>
              <span className="muted tiny">{new Date(c.updated_at).toLocaleDateString()}</span>
            </button>
          ))}
        </section>
      </div>
      {comparing && picked.length === 2 && (() => {
        const [a, b] = picked.map((id) => data.saved.find((x) => x.id === id)!);
        return a && b ? <ComparePanel a={a} b={b} onClose={() => { setComparing(false); setPicked([]); }} onDecided={load} /> : null;
      })()}
    </div>
  );
}
