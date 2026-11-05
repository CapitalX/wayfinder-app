import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chat, Project } from '../api.ts';
import { MODES } from '../App.tsx';

export interface Command { id: string; label: string; hint?: string; run: () => void }

// ⌘K: jump to any chat or project, start a chat in any mode, open a panel, or check a feature on the PDI.
export function CommandPalette({ chats, projects, actions, onClose, onChat, onProject, onNewChat, onFeature }: {
  chats: Chat[]; projects: Project[]; actions: Command[]; onClose: () => void;
  onChat: (id: string) => void; onProject: (id: string) => void; onNewChat: (mode: string) => void; onFeature: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const items = useMemo<Command[]>(() => {
    const t = q.trim().toLowerCase();
    const hit = (s: string) => !t || s.toLowerCase().includes(t);
    const list: Command[] = [
      ...Object.entries(MODES).filter(([, v]) => hit(`new ${v} chat`)).map(([k, v]) => ({ id: `new-${k}`, label: `New ${v.toLowerCase()} chat`, hint: 'start', run: () => onNewChat(k) })),
      ...actions.filter((a) => hit(a.label)),
      ...projects.filter((p) => hit(p.name)).slice(0, 6).map((p) => ({ id: `p-${p.id}`, label: p.name, hint: 'project', run: () => onProject(p.id) })),
      ...chats.filter((c) => hit(c.title)).slice(0, 8).map((c) => ({ id: `c-${c.id}`, label: c.title, hint: MODES[c.mode] ?? c.mode, run: () => onChat(c.id) })),
    ];
    if (t.length > 2) list.push({ id: 'feat', label: `Check "${q.trim()}" on the PDI`, hint: 'features', run: () => onFeature(q.trim()) });
    return list.slice(0, 14);
  }, [q, chats, projects, actions]);
  useEffect(() => setAt(0), [q]);

  const go = (c?: Command) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="palette-back" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Command bar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Jump to a chat or project, start a chat, check a feature…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter') go(items[at]);
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="palette-list">
          {items.map((c, i) => (
            <button key={c.id} className={`palette-item ${i === at ? 'on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => go(c)}>
              <span className="chat-title">{c.label}</span>{c.hint && <span className="ver">{c.hint}</span>}
            </button>
          ))}
          {!items.length && <p className="muted small pad">Nothing matches.</p>}
        </div>
      </div>
    </div>
  );
}
