import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Card, ConfirmButton } from './SettingsView.tsx';

// Settings → Pip → Placement rules: where Pip suggests new work should live, as cards you can reorder and edit.
// First match wins. Saving writes your copy of the placement skill; Reset goes back to the shipped rules. The file
// itself is still there to edit under "Edit as text" for anything the cards don't cover.
type Cond = { cond: string; not: boolean };
type Rule = { id: string; if: Cond[]; place: string; why: string; warn?: string; cite?: string };
type Data = { text: string; origin: 'shipped' | 'yours'; rules: number; list: Rule[]; warnings: string[] };
const CONDITIONS: Record<string, string> = {
  'new-tables': 'it creates new tables', 'adds-to-current-app': 'it adds to the app you are in', 'table-in-current-app': 'it touches a table of the app you are in',
  'table-in-other-app': 'it touches another app\'s table', 'table-in-global': 'it touches a platform (global) table', 'no-tables': 'it touches no tables',
  'current-is-app': 'you are in an app', 'current-is-global': 'you are in global', always: 'always',
};
const PLACES: Record<string, string> = { 'current-app': 'The app you are in', 'owning-app': 'The app that owns the table', 'new-app': 'A new app of its own', global: 'Global' };

export function PlacementRulesCard({ say }: { say: (text: string, bad?: boolean) => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const show = (r: Data) => { setD(r); setRules(r.list); setText(r.text); };
  useEffect(() => { api<Data>('/placement/rules').then(show).catch(() => {}); }, []);
  if (!d) return null;
  const dirty = JSON.stringify(rules) !== JSON.stringify(d.list);
  const run = async (fn: () => Promise<Data>, done: string) => {
    setBusy(true); setError('');
    try { show(await fn()); say(done); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const set = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) => { const next = [...rules]; const [r] = next.splice(i, 1); next.splice(i + by, 0, r); setRules(next); };
  const add = () => setRules([...rules, { id: `rule-${rules.length + 1}`, if: [{ cond: 'always', not: false }], place: 'current-app', why: '' }]);
  return (
    <Card title="Placement rules" state={`${d.origin === 'yours' ? 'Your rules' : 'Shipped rules'}: ${d.rules} rule${d.rules === 1 ? '' : 's'}.${d.warnings.length ? ` ${d.warnings.length} skipped.` : ''}`}>
      <p className="muted small">Before the first change in a chat, Pip reads these top to bottom and the first rule whose conditions all hold says where the work lives. Reorder with the arrows.</p>
      {d.warnings.map((w) => <div key={w} className="small warn-text">{w}</div>)}
      <ol className="rule-list" aria-label="Placement rules, first match wins">
        {rules.map((r, i) => (
          <li key={i} className="rule">
            <div className="rule-head">
              <span className="rule-n">{i + 1}</span>
              <input className="rule-id" aria-label="Rule name" value={r.id} pattern="[a-z0-9][a-z0-9-]*" maxLength={64} onChange={(e) => set(i, { id: e.target.value })} />
              <span className="row-actions">
                <button className="small" aria-label={`Move ${r.id} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="small" aria-label={`Move ${r.id} down`} disabled={busy || i === rules.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="small link danger" disabled={busy} onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
              </span>
            </div>
            <div className="rule-grid">
              <span className="rule-k">When</span>
              <div className="rule-conds">
                {r.if.map((c, k) => (
                  <span key={k} className="rule-cond">
                    <label className="toggle small"><input type="checkbox" checked={c.not} onChange={(e) => set(i, { if: r.if.map((x, m) => (m === k ? { ...x, not: e.target.checked } : x)) })} />not</label>
                    <select aria-label="Condition" value={c.cond} onChange={(e) => set(i, { if: r.if.map((x, m) => (m === k ? { ...x, cond: e.target.value } : x)) })}>
                      {Object.entries(CONDITIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {r.if.length > 1 && <button className="link small" aria-label="Remove condition" onClick={() => set(i, { if: r.if.filter((_, m) => m !== k) })}>×</button>}
                  </span>
                ))}
                <button className="link small" onClick={() => set(i, { if: [...r.if, { cond: 'current-is-app', not: false }] })}>+ and</button>
              </div>
              <span className="rule-k">Put it in</span>
              <select aria-label="Where the work lives" value={r.place} onChange={(e) => set(i, { place: e.target.value })}>{Object.entries(PLACES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <span className="rule-k">Because</span>
              <input aria-label="Why" value={r.why} maxLength={300} placeholder="One line for the card" onChange={(e) => set(i, { why: e.target.value })} />
              <span className="rule-k">Warn</span>
              <input aria-label="Warning" value={r.warn ?? ''} maxLength={300} placeholder="Optional: what to watch for" onChange={(e) => set(i, { warn: e.target.value })} />
              <span className="rule-k">Docs link</span>
              <input aria-label="Docs link" type="url" value={r.cite ?? ''} placeholder="Optional: https://…" onChange={(e) => set(i, { cite: e.target.value })} />
            </div>
          </li>
        ))}
      </ol>
      {error && <div className="small error" role="alert">{error}</div>}
      <div className="row-actions wrap">
        <button disabled={busy} onClick={add}>Add rule</button>
        <button className="primary" disabled={busy || !dirty} onClick={() => run(() => api('/placement/rules', { body: { rules } }), 'Placement rules saved')}>Save rules</button>
        {dirty && <button disabled={busy} onClick={() => { setRules(d.list); setError(''); }}>Undo changes</button>}
        {d.origin === 'yours' && <ConfirmButton label="Reset to shipped rules" question="Delete your rules and go back to the shipped ones?" confirmLabel="Reset" disabled={busy} onConfirm={() => run(() => api('/placement/rules/reset', { body: {} }), 'Back to the shipped rules')} />}
      </div>
      <details className="file-fold">
        <summary className="small muted">Edit as text</summary>
        <p className="muted small">The same rules as the file Pip reads: <code>## id</code>, then <code>if:</code>, <code>place:</code>, <code>why:</code> and optional <code>warn:</code> and <code>cite:</code>. The prose above the rules is for Pip.</p>
        <label className="sr-only" htmlFor="placement-rules">Placement rules file</label>
        <textarea id="placement-rules" className="rules-editor" rows={14} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row-actions">
          <button className="primary" disabled={busy || text === d.text} onClick={() => run(() => api('/placement/rules', { body: { text } }), 'Placement rules saved')}>Save file</button>
          {text !== d.text && <button disabled={busy} onClick={() => { setText(d.text); setError(''); }}>Undo</button>}
        </div>
      </details>
    </Card>
  );
}
