import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Card, ConfirmButton } from './SettingsView.tsx';

// Settings → Pip → Skills: Pip's know-how, one card each, edited right here. Saving keeps your copy in the config
// folder (it wins over the shipped one on the next answer); Reset brings the shipped skill back.
interface SkillRow { name: string; description: string; mode: string | null; modes: string[] | null; origin: 'shipped' | 'yours' }
interface SkillFile { text: string; origin: 'shipped' | 'yours'; shipped: boolean }
const title = (name: string) => name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function SkillsCard({ say }: { say: (text: string, bad?: boolean) => void }) {
  const [d, setD] = useState<{ folder: string; warnings: string[]; skills: SkillRow[] } | null>(null);
  const [open, setOpen] = useState<{ name: string; file: SkillFile; text: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<NonNullable<typeof d>>('/skills').then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const yours = d.skills.filter((s) => s.origin === 'yours').length;
  const when = (s: SkillRow) => (s.mode ? `Pip follows it in every ${s.mode} chat` : s.modes ? `Pip reads it when the work needs it, in ${s.modes.join(', ')} mode` : 'Pip reads it when the work needs it');
  const edit = async (name: string) => {
    setError('');
    try { const file = await api<SkillFile>(`/skills/${name}`); setOpen({ name, file, text: file.text }); } catch (e) { setError((e as Error).message); }
  };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setError('');
    try { await fn(); say(done); setOpen(null); await load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <Card title="Skills" state={`${d.skills.length} skill${d.skills.length === 1 ? '' : 's'}${yours ? `, ${yours} of them yours` : ''}.${d.warnings.length ? ` ${d.warnings.length} need${d.warnings.length === 1 ? 's' : ''} a look.` : ''}`}>
      <p className="muted small">How Pip works in each mode, and know-how it reads only when the work needs it. Edit one here; your copy applies from the next answer. Skills guide Pip; they never grant permission.</p>
      {d.warnings.map((w) => <div key={w} className="small warn-text" role="status">{w}</div>)}
      {error && <div className="small error" role="alert">{error}</div>}
      <ul className="skill-list plain-list">
        {d.skills.map((s) => (
          <li key={s.name} className="skill-row">
            <div className="grow">
              <div><b>{title(s.name)}</b> <code className="muted tiny">{s.name}</code>{s.origin === 'yours' && <span className="kind-chip">yours</span>}</div>
              <div className="small">{s.description}</div>
              <div className="muted tiny">{when(s)}</div>
            </div>
            <button className="small" disabled={busy} onClick={() => edit(s.name)}>Edit {title(s.name)}</button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="skill-editor">
          <h4>{title(open.name)}{open.file.origin === 'yours' ? ' · your copy' : ' · shipped'}</h4>
          <label className="sr-only" htmlFor="skill-text">Skill text</label>
          <textarea id="skill-text" className="rules-editor" rows={18} spellCheck={false} value={open.text} onChange={(e) => setOpen({ ...open, text: e.target.value })} />
          <div className="row-actions wrap">
            <button className="primary" disabled={busy || open.text === open.file.text} onClick={() => run(() => api(`/skills/${open.name}`, { method: 'PUT', body: { text: open.text } }), `${title(open.name)} saved`)}>Save skill</button>
            <button disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
            {open.file.origin === 'yours' && <ConfirmButton label={open.file.shipped ? 'Reset to shipped' : 'Delete this skill'} question={open.file.shipped ? 'Delete your copy and go back to the shipped skill?' : 'Delete this skill of yours?'} confirmLabel={open.file.shipped ? 'Reset' : 'Delete'} disabled={busy} onConfirm={() => run(() => api(`/skills/${open.name}`, { method: 'DELETE' }), open.file.shipped ? 'Back to the shipped skill' : 'Skill deleted')} />}
          </div>
        </div>
      )}
      <p className="muted tiny">New skill: a folder with a <code>SKILL.md</code> under <code className="break">{d.folder}</code>; it shows up here with its own Edit.</p>
    </Card>
  );
}
