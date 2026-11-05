import { useEffect, useState } from 'react';
import { api, type Memory } from '../api.ts';

// Memory suggestions float up from Pip like small clouds. ✓ is absorbed into Pip (kept); × drifts off to the
// Memory tab (dismissed, still there to review later).
export function MemoryClouds({ chatId, reloadKey, onAbsorb, onCount }: { chatId: string; reloadKey: unknown; onAbsorb: () => void; onCount?: () => void }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [leaving, setLeaving] = useState<Record<string, 'keep' | 'drop'>>({});
  useEffect(() => {
    api<Memory[]>(`/memories?chat_id=${chatId}`).then((all) => setItems(all.filter((m) => m.status === 'proposed'))).catch(() => {});
  }, [chatId, reloadKey]);

  const decide = async (m: Memory, how: 'keep' | 'drop') => {
    setLeaving((l) => ({ ...l, [m.id]: how }));
    await api(`/memories/${m.id}`, { method: 'PATCH', body: { status: how === 'keep' ? 'saved' : 'dismissed' } }).catch(() => {});
    if (how === 'keep') onAbsorb();
    window.setTimeout(() => { setItems((xs) => xs.filter((x) => x.id !== m.id)); onCount?.(); }, 900);
  };

  if (!items.length) return null;
  return (
    <div className="clouds" aria-live="polite">
      {items.slice(0, 3).map((m, i) => (
        <div key={m.id} className={`cloud ${leaving[m.id] ?? ''}`} style={{ animationDelay: `${i * 0.25}s` }}>
          <span className="cloud-glyph" aria-hidden>☁</span>
          <span className="cloud-text" title={m.why}>{m.text}</span>
          <span className="cloud-actions">
            <button className="cloud-yes" onClick={() => decide(m, 'keep')} aria-label="Remember this" title="Remember this">✓</button>
            <button className="cloud-no" onClick={() => decide(m, 'drop')} aria-label="Not now" title="Not now (kept under Memory › Dismissed)">×</button>
          </span>
        </div>
      ))}
    </div>
  );
}
