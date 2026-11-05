import { useEffect, useRef } from 'react';

// One live stream per tab (/api/events). Each event names what changed (jobs, board, memories, apps, chats) and
// the parts of the page that show it refetch right away. A slow fallback timer stays in each place in case the
// stream drops (the browser reconnects it on its own).
let source: EventSource | null = null;
function ensure() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events', { withCredentials: true });
  source.onmessage = (m) => {
    try { window.dispatchEvent(new CustomEvent('wf-live', { detail: JSON.parse(m.data) })); } catch { /* ignore */ }
  };
}

export function useLive(topic: string, fn: (detail: Record<string, unknown>) => void) {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    ensure();
    const on = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.topic === topic) cb.current(d); };
    window.addEventListener('wf-live', on);
    return () => window.removeEventListener('wf-live', on);
  }, [topic]);
}
