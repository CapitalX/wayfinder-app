import { useEffect, useState } from 'react';
import { api, type AppInfo, type Checkpoint, type Spec } from '../api.ts';

const STATUS: Record<string, string> = {
  draft: 'Draft', built: 'Built', build_failed: 'Build failed', installing: 'Installing…', installed: 'Installed',
  install_failed: 'Install failed', removing: 'Removing…', removed: 'Removed',
};

// The plan for an app, readable at a glance: what it's for, then tables, access, logic, UI and tests.
export function SpecDetails({ spec }: { spec: Spec }) {
  const list = (title: string, items?: string[]) => !!items?.length && (
    <div className="spec-sec"><div className="label">{title}</div><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
  );
  return (
    <div className="spec">
      <p>{spec.summary}</p>
      <div className="spec-sec">
        <div className="label">Tables</div>
        {spec.tables.map((t) => (
          <div key={t.name} className="spec-table">
            <strong>{t.label}</strong> <code>{t.name}</code>{t.extends && <span className="muted"> extends {t.extends}</span>}
            <div className="spec-fields">{t.fields.map((f) => <span key={f.name} title={f.notes}>{f.label} <em>{f.type}</em></span>)}</div>
          </div>
        ))}
      </div>
      {list('Roles', spec.roles?.map((r) => `${r.name}: ${r.description}`))}
      {list('Access', spec.access)}
      {list('Logic', spec.logic?.map((l) => `${l.name} (${l.kind.replace(/_/g, ' ')}): ${l.does}`))}
      {list('Screens', spec.ui)}
      {list('Sample data', spec.sample_data)}
      {list('Tests', spec.tests)}
    </div>
  );
}

// Approving a plan is recorded on the server first (writing, building and installing wait for it), then said in the chat.
export async function approvePlan(appId: string | undefined, onReply: (text: string, send: boolean) => void) {
  if (appId) await api(`/apps/${appId}/approve-plan`, { method: 'POST' }).catch(() => {});
  onReply('Plan approved. Build it.', true);
}

// Shown in the chat when Claude proposes a plan; the buttons answer in the chat.
export function SpecCard({ spec, appId, onReply }: { spec: Spec; appId?: string; onReply?: (text: string, send: boolean) => void }) {
  return (
    <div className="spec-card">
      <div className="spec-head">
        <span className="spec-kicker">App plan</span>
        <strong>{spec.name}</strong>
        <code>{spec.scope}</code>
      </div>
      <SpecDetails spec={spec} />
      {onReply && (
        <div className="approval-actions">
          <button className="primary" onClick={() => approvePlan(appId, onReply)}>Approve plan</button>
          <button onClick={() => onReply('Change the plan: ', false)}>Change…</button>
        </div>
      )}
    </div>
  );
}

export function AppCard({ app, onChanged }: { app: AppInfo; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  // Edits made on the PDI since the install, which the source here doesn't have yet.
  const [drift, setDrift] = useState<{ count: number; items: { name: string; by: string; at: string }[] } | null>(null);
  useEffect(() => { if (app.status === 'installed') api<typeof drift>(`/apps/${app.id}/drift`).then(setDrift).catch(() => {}); }, [app.id, app.status, app.updated_at]);
  return (
    <div className="card app-card">
      <div className="app-head">
        <strong>{app.name}</strong>
        <code>{app.scope}</code>
        <span className={`status-chip st-${app.status}`}>{STATUS[app.status] ?? app.status}</span>
        {!!drift?.count && <span className="status-chip st-installing" title={drift.items.map((i) => `${i.name} · ${i.by} · ${i.at}`).join('\n')}>Changed on PDI ({drift.count})</span>}
      </div>
      {!!drift?.count && <p className="small warn-text">Someone edited this app on the PDI after the install ({drift.items[0].by}, {drift.items[0].at}). Installing again from here would overwrite it; ask Pip to look at the change first.</p>}
      {app.spec && <p className="muted small">{app.spec.summary}</p>}
      <div className="row-actions">
        {app.link && app.status === 'installed' && <a className="button" href={app.link} target="_blank" rel="noreferrer">Open on PDI</a>}
        <button onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>
      </div>
      {open && (
        <>
          {app.spec && <SpecDetails spec={app.spec} />}
          <History app={app} onChanged={onChanged} />
          <p className="muted tiny">Source: <code>{app.folder}</code> (a git repo with one commit per good build)</p>
          {app.last_output && <><div className="label">Last output</div><pre className="output">{app.last_output}</pre></>}
        </>
      )}
    </div>
  );
}

// The app's history: good builds, named checkpoints and restores. Restore rolls back the source only.
function History({ app, onChanged }: { app: AppInfo; onChanged?: () => void }) {
  const [items, setItems] = useState<Checkpoint[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  // Compare a past build with the newest: what changed in the source since then.
  const showDiff = async (ref: string) => {
    if (diffFor === ref) { setDiffFor(null); return; }
    setDiffFor(ref); setDiff('Loading…');
    try { setDiff((await api<{ diff: string }>(`/apps/${app.id}/diff?from=${ref}&to=${items![0].ref}`)).diff); } catch (e) { setDiff((e as Error).message); }
  };
  const load = () => api<AppInfo>(`/apps/${app.id}`).then((a) => setItems(a.timeline ?? [])).catch(() => setItems([]));
  useEffect(() => { load(); }, [app.id, app.updated_at]);
  const restore = async (ref: string) => {
    try {
      const r = await api<{ restored: string }>(`/apps/${app.id}/restore`, { body: { ref } });
      setMsg(`Source restored to ${r.restored}. Ask Pip to build and install it to put this version on the PDI.`);
      setConfirm(null); load(); onChanged?.();
    } catch (e) { setMsg((e as Error).message); }
  };
  if (!items?.length) return null;
  return (
    <div className="history">
      <div className="label">History</div>
      {items.slice(0, 12).map((c) => (
        <div key={c.ref} className={`cp ${c.named ? 'named' : ''}`}>
          <span className="cp-dot" />
          <span className="cp-label">{c.label}</span>
          {c.installed && <span className="status-chip st-installed">on PDI</span>}
          <span className="ver">{c.short} · {new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          {c.ref !== items[0].ref && <button className="link" onClick={() => showDiff(c.ref)}>{diffFor === c.ref ? 'Hide changes' : 'Changes since'}</button>}
          {confirm === c.ref
            ? <><button className="primary" onClick={() => restore(c.ref)}>Restore source</button><button onClick={() => setConfirm(null)}>Cancel</button></>
            : <button className="link" onClick={() => setConfirm(c.ref)}>Restore</button>}
        </div>
      ))}
      {diffFor && <pre className="output diff">{diff.split('\n').map((l, n) => <span key={n} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l}{'\n'}</span>)}</pre>}
      {confirm && <p className="muted tiny">Restore rolls back the app's source only. Records created on the PDI stay, and the PDI keeps the installed version until you build and install again.</p>}
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
