import { useEffect, useRef, useState } from 'react';
import { api, type BoardItem, type BoardKind, type BoardStatus } from '../api.ts';
import { Pip } from './Pip.tsx';
import { useLive } from '../live.ts';
import { AutoTextarea } from './AutoTextarea.tsx';

const KIND: Record<BoardKind, string> = { error: 'Error', record: 'Record', log: 'Log', doc: 'Docs', hypothesis: 'Guess', note: 'Note' };
const STATUS: Record<BoardStatus, string> = { open: 'Open', tested: 'Testing', ruled_out: 'Ruled out', confirmed: 'Confirmed' };
const BOARD_WHAT = 'Clues you and Pip pin while chasing a problem. Pip reads the board in every chat of this project, so nobody re-explains where you got to.';

// Past this many ruled-out clues, the older ones fold into one line so the live ones stay in view.
const RULED_SHOWN = 5;

// The investigation board: clues pinned while chasing a problem, by you or by Pip, each with a status chip. Clues stay
// where they were pinned (ruled out ones struck through); a clue's controls only show when you open it, and new
// clues grow in. Pip reads it in every chat of the project, so you never re-explain where you got to.
export function BoardPanel({ projectId, chatId, title, onClose }: { projectId: string | null; chatId: string | null; title: string; onClose: () => void }) {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [kind, setKind] = useState<BoardKind>('hypothesis');
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [showRuled, setShowRuled] = useState(false);
  // Clues seen so far: anything newer grows in. The first load shows the board as it is, without motion.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const qs = projectId ? `project_id=${projectId}` : chatId ? `chat_id=${chatId}` : '';

  const load = () => (qs ? api<BoardItem[]>(`/board?${qs}`).then((list) => {
    if (seen.current) { const added = list.filter((i) => !seen.current!.has(i.id)).map((i) => i.id); if (added.length) setFresh(new Set(added)); }
    seen.current = new Set(list.map((i) => i.id));
    setItems(list);
  }).catch(() => {}) : Promise.resolve());
  // Pip pins clues while it works; they arrive live (with a slow fallback check).
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [qs]);
  useLive('board', () => load());

  const add = async () => {
    if (!draft.trim()) return;
    await api('/board', { body: { project_id: projectId, chat_id: chatId, kind, title: draft } });
    setDraft(''); load();
  };
  const patch = async (id: string, body: Partial<BoardItem>) => { await api(`/board/${id}`, { method: 'PATCH', body }); load(); };
  const remove = async (id: string) => { await api(`/board/${id}`, { method: 'DELETE' }); load(); };

  if (!qs) return (
    <aside className="preview features">
      <div className="preview-head"><strong>Board</strong><button className="icon-btn" onClick={onClose} aria-label="Close board">×</button></div>
      <p className="panel-intro pad">{BOARD_WHAT}</p>
      <p className="muted small pad">Open a chat or a project to see its board.</p>
    </aside>
  );

  // The newest few ruled-out clues stay in place; older ones fold away until asked for.
  const ruled = items.filter((i) => i.status === 'ruled_out').sort((x, y) => y.updated_at - x.updated_at);
  const folded = new Set(ruled.slice(RULED_SHOWN).map((i) => i.id));
  const shown = items.filter((i) => showRuled || !folded.has(i.id));

  const card = (i: BoardItem) => {
    const expanded = open === i.id;
    return (
      <div key={i.id} className={`clue st-c-${i.status}${fresh.has(i.id) ? ' clue-new' : ''}${expanded ? ' open' : ''}`}>
        <button type="button" className="clue-head" onClick={() => setOpen(expanded ? null : i.id)} aria-expanded={expanded}>
          <span className={`kind-chip kind-${i.kind}`}>{KIND[i.kind]}</span>
          <span className="clue-title">{i.title}</span>
          {i.status !== 'open' && <span className={`status-chip sc-${i.status}`}>{STATUS[i.status]}</span>}
          {i.author === 'pip' ? <span title="Pinned by Pip"><Pip size={14} still /></span> : <span className="ver">you</span>}
        </button>
        {!expanded && i.detail && i.status !== 'ruled_out' && <p className="clue-detail">{i.detail.length > 220 ? i.detail.slice(0, 220) + '…' : i.detail}</p>}
        {expanded && (
          <div className="clue-edit">
            <div className="clue-row">
              <select value={i.status} onChange={(e) => patch(i.id, { status: e.target.value as BoardStatus })} aria-label="Status">
                {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {i.link && <a className="link small" href={i.link} target="_blank" rel="noreferrer">Open ↗</a>}
              <button className="link small danger" onClick={() => remove(i.id)}>Remove</button>
            </div>
            <textarea rows={4} defaultValue={i.detail} placeholder="Evidence, what was tried, what it showed" aria-label="Detail" onBlur={(e) => e.target.value !== i.detail && patch(i.id, { detail: e.target.value })} />
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="preview features board">
      <div className="preview-head">
        <strong>Board</strong>
        <span className="ver">{title}{items.length ? ` · ${items.length} ${items.length === 1 ? 'clue' : 'clues'}` : ''}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close board">×</button>
      </div>
      <div className="features-body">
        <p className="panel-intro">{BOARD_WHAT}</p>
        <div className="inline-form">
          <select value={kind} onChange={(e) => setKind(e.target.value as BoardKind)} aria-label="Kind">
            {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <AutoTextarea value={draft} onChange={setDraft} onSubmit={add} submitHint="to pin" label="Pin a clue or a guess" placeholder="Pin a clue or a guess" maxRows={4} />
          <button className="primary" onClick={add} disabled={!draft.trim()}>Pin</button>
        </div>
        {!items.length && (
          <div className="board-empty">
            <p className="small"><b>Nothing pinned yet.</b> While you chase a problem, pin each clue or guess here: Pip pins its own as it works in a Debug chat, and you can type one above.</p>
            <div className="clue example" aria-hidden="true">
              <div className="clue-head"><span className="kind-chip kind-hypothesis">Guess</span><span className="clue-title">The approval rule doesn't fire for requests over 1,000</span><span className="ver">example</span></div>
            </div>
          </div>
        )}
        {!!items.length && (
          <p className="board-legend muted tiny"><b>Open</b> not checked yet · <b>Testing</b> being checked · <b>Confirmed</b> it's the cause, or true · <b>Ruled out</b> checked and not it. Open a clue to change it.</p>
        )}
        <div className="clues">{shown.map(card)}</div>
        {folded.size > 0 && (
          <button className="link small" onClick={() => setShowRuled(!showRuled)}>{showRuled ? 'Fold' : 'Show'} {folded.size} older ruled out</button>
        )}
      </div>
    </aside>
  );
}
