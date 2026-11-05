import { useState } from 'react';
import { AutoTextarea } from './AutoTextarea.tsx';
import { api, type Saved } from '../api.ts';
import { PreviewFrame } from './PreviewFrame.tsx';

// Two mockups side by side. Keeping one saves the choice (and why) as a decision in the project.
export function ComparePanel({ a, b, chatId, onClose, onDecided }: { a: Saved; b: Saved; chatId?: string | null; onClose: () => void; onDecided: () => void }) {
  const [why, setWhy] = useState('');
  const [saved, setSaved] = useState('');

  const keep = async (win: Saved, lose: Saved) => {
    const content = `Chose "${win.title}" over "${lose.title}".${why.trim() ? `\n\nWhy: ${why.trim()}` : ''}\n\nThe chosen mockup is saved in this project as "${win.title}".`;
    await api('/saved', { body: { chat_id: chatId ?? win.chat_id, kind: 'decision', title: `Mockup: ${win.title}`, content } });
    setSaved(win.title);
    onDecided();
  };

  return (
    <div className="compare-back">
      <div className="compare">
        <div className="preview-head">
          <strong>Compare</strong>
          <AutoTextarea className="compare-why" value={why} onChange={setWhy} maxRows={3} label="Why one wins" placeholder="Why one wins (optional, saved with the decision)" />
          <button className="icon-btn" onClick={onClose} aria-label="Close compare">×</button>
        </div>
        <div className="compare-panes">
          {[a, b].map((m, i) => (
            <div key={m.id} className="compare-pane">
              <div className="compare-title">
                <span className="chat-title">{m.title}</span>
                {saved === m.title ? <span className="status-chip st-installed">Kept</span> : <button className="primary" onClick={() => keep(m, i === 0 ? b : a)} disabled={!!saved}>Keep this one</button>}
              </div>
              <PreviewFrame html={m.content} device="desktop" zoom="fit" title={m.title} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
