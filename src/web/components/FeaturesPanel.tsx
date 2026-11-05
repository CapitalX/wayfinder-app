import { useEffect, useState } from 'react';
import { api, type Feature, type FeatureStatus } from '../api.ts';
import { AutoTextarea } from './AutoTextarea.tsx';

const STATUS: Record<FeatureStatus, string> = {
  on: 'On', ready: 'Ready to turn on', store: 'In the Store', blocked: 'Blocked here', pdi_unavailable: 'Not on PDIs', unknown: "Couldn't check",
};

// The features engine: search what the instance offers out of the box, see what each feature needs, turn it on,
// or ask Pip for a step-by-step guide. Prefers OOB over building custom.
export function FeaturesPanel({ onClose, onAsk, projectName, initialQuery, canInstall = true }: { onClose: () => void; onAsk: (prompt: string) => void; projectName?: string; initialQuery?: string; canInstall?: boolean }) {
  const [q, setQ] = useState(initialQuery ?? '');
  const [items, setItems] = useState<Feature[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [started, setStarted] = useState<string[]>([]);

  const search = async (term = q) => {
    if (term.trim().length < 2) return;
    setBusy(true); setError('');
    try {
      const r = await api<{ features: Feature[]; problems: string[] }>(`/features?q=${encodeURIComponent(term.trim())}`);
      setItems(r.features); setProblems(r.problems ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  useEffect(() => { if (initialQuery) search(initialQuery); }, []);

  const turnOn = async (f: Feature) => {
    setError('');
    try {
      await api('/features/activate', { body: { kind: f.kind, id: f.id, version: f.version, name: f.name } });
      setStarted((s) => [...s, f.id]);
      setConfirm(null);
    } catch (e) { setError((e as Error).message); }
  };

  const guide = (f: Feature) => onAsk(
    `Walk me through turning on "${f.name}" (${f.kind === 'plugin' ? `plugin ${f.id}` : `Store app ${f.scope ?? f.id}`}) on my PDI, step by step. ` +
    `Right now it is: ${STATUS[f.status]}${f.why ? ` (${f.why})` : ''}. ` +
    `${f.requires.length ? `It needs: ${f.requires.map((r) => `${r.name}${r.on === true ? ' (on)' : r.on === false ? ' (off)' : ''}`).join(', ')}. ` : ''}` +
    `Check the docs for setup after activation (roles, properties, guided setup, demo data), tell me what a PDI can and can't do here, and what it gives me out of the box so I don't build it custom.`);

  return (
    <aside className="preview features">
      <div className="preview-head">
        <strong>Features</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close features">×</button>
      </div>
      <div className="features-body">
        <p className="panel-intro">What your instance already offers (plugins and Store apps), so you can turn something on instead of building it.</p>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <AutoTextarea value={q} onChange={setQ} onSubmit={() => search()} submitHint="to search" label="What do you need?" placeholder="What do you need? e.g. Performance Analytics, field service" autoFocus />
          <button className="primary" disabled={busy || q.trim().length < 2}>{busy ? 'Searching…' : 'Search'}</button>
        </form>
        <button className="link small" onClick={() => onAsk(`Recommend out-of-the-box plugins and Store apps on my PDI${projectName ? ` for the "${projectName}" project's goals` : ''} that would save me from building custom. Use check_features, say what each needs and whether it's available on a PDI, and rank them.`)}>
          Ask Pip what to turn on{projectName ? ` for ${projectName}` : ''}
        </button>
        {error && <p className="error small">{error}</p>}
        {!items && !busy && <p className="muted small">Describe what you need in plain words: "approvals for purchases", "dashboards for SLAs", "track assets in the field". Each result says whether it's on, ready to turn on, or not available on a PDI.</p>}
        {!!problems.length && <div className="notice warn small">Some checks couldn't run, so this list may be incomplete:<ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        {items && !items.length && !problems.length && <p className="muted small">Nothing on this instance matches. Try another word, or ask Pip: some products have to be requested on the developer site.</p>}
        {items?.map((f) => (
          <div key={`${f.kind}-${f.id}`} className={`feature st-f-${f.status}`}>
            <div className="feature-head">
              <strong>{f.name}</strong>
              <span className={`status-chip f-${f.status}`}>{started.includes(f.id) ? 'Starting…' : STATUS[f.status]}</span>
            </div>
            <div className="ver">{f.kind === 'plugin' ? f.id : `Store app · ${f.scope ?? ''}`}{f.version ? ` · ${f.version}` : ''}{f.paid ? ' · paid' : ''}</div>
            {f.plain && <p className="small feature-plain">{f.plain}</p>}
            {f.description && f.description !== f.plain && <p className="muted small">{f.description}</p>}
            {f.why && <p className="small warn-text">{f.why}</p>}
            {!!f.requires.length && (
              <div className="requires">
                <span className="label">Needs</span>
                {f.requires.map((r) => <span key={r.id} className={`req ${r.on === true ? 'on' : r.on === false ? 'off' : ''}`} title={r.id}>{r.name}</span>)}
              </div>
            )}
            <div className="row-actions">
              {(f.status === 'ready' || f.status === 'store') && !canInstall && <span className="muted tiny" title="Needs admin or sn_cicd.sys_ci_automation">Your account can't install this; Guide me shows the steps for an admin.</span>}
              {(f.status === 'ready' || f.status === 'store') && canInstall && !started.includes(f.id) && (confirm === f.id
                ? <><button className="primary" onClick={() => turnOn(f)}>Yes, {f.kind === 'plugin' ? 'turn it on' : 'install it'}</button><button onClick={() => setConfirm(null)}>Cancel</button></>
                : <button className="primary" onClick={() => setConfirm(f.id)}>{f.kind === 'plugin' ? 'Turn on' : 'Install'}</button>)}
              <button onClick={() => guide(f)}>Guide me</button>
              {f.help && <a className="link small" href={f.help} target="_blank" rel="noreferrer">Docs</a>}
            </div>
            {confirm === f.id && <p className="muted tiny">This runs in the background for a few minutes{f.requires.some((r) => r.on === false) ? ' and turns on what it needs first' : ''}. Progress shows at the top.</p>}
          </div>
        ))}
      </div>
    </aside>
  );
}
