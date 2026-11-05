import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import { useLive } from '../live.ts';

// Small popover menus in the header: the update set your changes go into, and the docs release answers cite.
// On a phone (640px and under, like the rest of the phone layout) a menu under its button would run off the screen, so
// it opens as a sheet across the bottom instead, drawn on the page itself (not inside the drawer), with its own ×.
const PHONE = '(max-width: 640px)';
function usePhone() {
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const m = matchMedia(PHONE);
    const change = () => setPhone(m.matches);
    m.addEventListener('change', change);
    return () => m.removeEventListener('change', change);
  }, []);
  return phone;
}

function Popover({ label, title, children, className = '' }: { label: ReactNode; title: string; children: (close: () => void) => ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);
  const close = () => setOpen(false);
  const body = children(close);
  return (
    <div className={`pop ${className}`} ref={ref}>
      <button className={`head-chip ${open ? 'on' : ''}`} title={title} aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open && !phone && <div className="pop-panel" role="menu" ref={panel}>{body}</div>}
      {open && phone && createPortal(
        <div className="pop-back">
          <div className="pop-panel sheet-mode" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
            <button className="icon-btn pop-close" onClick={close} aria-label="Close">×</button>
            {body}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface CurrentSet { sys_id: string; name: string; state: string; app: string; scope: string; changes: number | null; link: string }
interface LastSwitch { at: number; why: string | null; chat_id: string | null; by: 'pip' | 'you' }

const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

// The update set your changes go into, read-only: Pip picks and switches sets as it works, so the header only shows
// it (and lights up briefly when Pip switches). Clicking it says what's in it, and when and why Pip last switched.
export function UpdateSetPill({ instanceKey, onOpenChat }: { instanceKey?: string; onOpenChat?: (id: string) => void }) {
  const [data, setData] = useState<{ current: CurrentSet | null; last_switch: LastSwitch | null; error?: string } | null>(null);
  const load = () => api<{ current: CurrentSet | null; last_switch: LastSwitch | null }>('/updatesets/current').then(setData).catch((e) => setData({ current: null, last_switch: null, error: (e as Error).message }));
  useEffect(() => { if (instanceKey) load(); }, [instanceKey]);
  const [flash, setFlash] = useState(false);
  useLive('instance', () => { if (instanceKey) load().then(() => { setFlash(true); setTimeout(() => setFlash(false), 1600); }); });
  if (!instanceKey) return null;
  const cur = data?.current;
  const last = data?.last_switch;
  return (
    <Popover className={`set-pill ${flash ? 'flash' : ''}`} title="The update set your changes go into (Pip switches it)" label={<><span className="head-k">Update set</span> {cur?.name ?? (data ? 'Default' : '…')}{cur && cur.app !== 'Global' ? <span className="muted"> · {cur.app}</span> : null}</>}>
      {() => (
        <div className="set-info">
          <div className="pop-head">Changes go into</div>
          {data?.error && <p className="error small">{data.error}</p>}
          {cur ? (
            <dl className="set-facts">
              <dt>Update set</dt><dd>{cur.name}</dd>
              <dt>Application</dt><dd>{cur.app}{cur.scope !== 'global' ? <span className="muted"> · {cur.scope}</span> : null}</dd>
              <dt>State</dt><dd>{cur.state}</dd>
              <dt>Changes</dt><dd>{cur.changes ?? '?'}</dd>
            </dl>
          ) : !data?.error && <p className="small">Default: no named update set yet. Pip picks or creates one before its first change.</p>}
          {last && (
            <p className="small set-last">
              {last.by === 'pip' ? 'Pip switched to it' : 'Switched'} {ago(last.at)}{last.why ? <>: {last.why}</> : '.'}
              {last.chat_id && onOpenChat && <> <button className="link small" onClick={() => onOpenChat(last.chat_id!)}>Open the chat</button></>}
            </p>
          )}
          {cur && <a className="link small" href={cur.link} target="_blank" rel="noreferrer">Open in ServiceNow ↗</a>}
          <p className="muted tiny pop-foot">Pip chooses and switches update sets as it works (each switch asks you first and is in the activity log), so it isn't changed here.</p>
        </div>
      )}
    </Popover>
  );
}

export function DocsPicker({ instanceKey }: { instanceKey?: string }) {
  const [d, setD] = useState<{ available: string[]; setting: string; effective: string; instanceRelease: string | null } | null>(null);
  const load = () => api<typeof d>('/docs/releases').then(setD).catch(() => {});
  useEffect(() => { load(); }, [instanceKey]);
  useLive('docs', (x) => { if ((x.job as { state?: string } | undefined)?.state === 'done') load(); });
  if (!d?.available.length) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const choose = async (v: string, close: () => void) => { await api('/settings', { method: 'PUT', body: { docsRelease: v } }).catch(() => {}); await load(); close(); };
  return (
    <Popover title="Which docs release answers cite" label={<><span className="head-k">Docs</span> {cap(d.effective)}</>}>
      {(close) => (
        <>
          <div className="pop-head">Docs release</div>
          <button className={`pop-item ${d.setting === 'auto' ? 'on' : ''}`} onClick={() => choose('auto', close)}>
            <span>Match my instance</span><span className="muted tiny">{d.instanceRelease ? `${cap(d.instanceRelease)}${d.available.includes(d.instanceRelease) ? '' : ' isn’t indexed, using ' + cap(d.available[0])}` : 'release unknown'}</span>
          </button>
          {d.available.map((r) => <button key={r} className={`pop-item ${d.setting === r ? 'on' : ''}`} onClick={() => choose(r, close)}><span>{cap(r)}</span></button>)}
        </>
      )}
    </Popover>
  );
}

export interface Insight {
  id: string; label: string; prompt: string; mode: 'debug' | 'explore' | 'decide'; value?: string; detail?: string; tone?: 'warn' | 'info';
  group: 'logs' | 'changes' | 'health'; impact?: { prompt: string; target: unknown };
}
export interface Pulse { items: Insight[]; skipped: string[]; filter: { days: number; by?: string; set?: string }; people: string[]; sets: { sys_id: string; name: string }[] }
const GROUPS: [Insight['group'], string][] = [['logs', 'Log findings'], ['changes', 'Development changes'], ['health', 'Checks']];
const MODE = { debug: 'Debug', decide: 'Decide', explore: 'Explore' };

// The home screen's "Insights →": what developers changed and which log errors are new, each one click to a chat,
// with Impact on a change to map what it touches. Filters: the window, a person, an update set.
export function InsightsButton({ pulse, where, onPick }: { pulse: Pulse; where: string; onPick: (mode: Insight['mode'], prompt: string, title: string) => void }) {
  const [p, setP] = useState(pulse);
  const [busy, setBusy] = useState(false);
  // "What does it touch?": searched for one row when asked, not on every load.
  const [touch, setTouch] = useState<Record<string, string>>({});
  useEffect(() => setP(pulse), [pulse]);
  const lookUp = async (i: Insight) => {
    setTouch((t) => ({ ...t, [i.id]: 'Looking…' }));
    try { const r = await api<{ line: string }>(`/pulse/impact?target=${encodeURIComponent(JSON.stringify(i.impact!.target))}`); setTouch((t) => ({ ...t, [i.id]: r.line })); }
    catch (e) { setTouch((t) => ({ ...t, [i.id]: (e as Error).message })); }
  };
  const warn = p.items.filter((i) => i.tone === 'warn').length;
  const filter = async (patch: Partial<Pulse['filter']>) => {
    const f = { ...p.filter, ...patch };
    const q = new URLSearchParams({ days: String(f.days) });
    if (f.by) q.set('by', f.by);
    if (f.set) q.set('set', f.set);
    setBusy(true);
    try { setP(await api<Pulse>(`/pulse?${q}`)); } catch { /* keep what's shown */ }
    setBusy(false);
  };
  const connected = p.people.length > 0 || p.sets.length > 0 || p.items.some((i) => i.group === 'changes');
  return (
    <Popover className="insights" title={`What's happening on ${where}`} label={<>Insights{warn ? <span className="ins-badge">{warn}</span> : null} →</>}>
      {(close) => (
        <>
          <div className="pop-head">Happening on {where}</div>
          {connected && (
            <div className="ins-filters" aria-busy={busy}>
              <select aria-label="Window" value={p.filter.days} disabled={busy} onChange={(e) => filter({ days: Number(e.target.value) })}>
                {[1, 7, 30].map((d) => <option key={d} value={d}>{d === 1 ? 'Last day' : `Last ${d} days`}</option>)}
              </select>
              <select aria-label="Person" value={p.filter.by ?? ''} disabled={busy} onChange={(e) => filter({ by: e.target.value || undefined })}>
                <option value="">Everyone</option>
                {p.people.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <select aria-label="Update set" value={p.filter.set ?? ''} disabled={busy} onChange={(e) => filter({ set: e.target.value || undefined })}>
                <option value="">All update sets</option>
                {p.sets.map((s) => <option key={s.sys_id} value={s.sys_id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {GROUPS.map(([g, title]) => {
            const list = p.items.filter((i) => i.group === g);
            if (!list.length) return null;
            return (
              <div key={g} className="ins-group">
                <div className="label">{title}</div>
                {list.map((i) => (
                  <div key={i.id} className="ins-row">
                    <button className={`pop-item ins tone-${i.tone ?? 'plain'}`} onClick={() => { close(); onPick(i.mode, i.prompt, `${i.value ? `${i.value} ` : ''}${i.label}`); }}>
                      <span>{i.value && <b className="ins-val">{i.value}</b>} {i.label}{i.detail && <span className="ins-detail">{i.detail}</span>}{touch[i.id] && <span className="ins-detail ins-touches">{touch[i.id]}</span>}</span>
                      <span className="muted tiny">{MODE[i.mode]} →</span>
                    </button>
                    {i.impact && (
                      <span className="ins-acts">
                        {!touch[i.id] && <button className="ins-touch link tiny" onClick={() => lookUp(i)}>What does it touch?</button>}
                        <button className="ins-impact" title="Map what this touches, in a chat" onClick={() => { close(); onPick('explore', i.impact!.prompt, `Impact: ${i.label}`); }}>Impact</button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {p.skipped.length > 0 && <p className="muted tiny pop-foot">Skipped: {p.skipped.join('; ')}.</p>}
        </>
      )}
    </Popover>
  );
}
