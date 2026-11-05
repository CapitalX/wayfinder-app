import { useState } from 'react';

const LINGER_S = 15;
import { api, type Job } from '../api.ts';

// Background work on the PDI (plugins, store apps, app installs and removals, test runs), plus recently finished ones.
export function JobsBar({ jobs }: { jobs: Job[] }) {
  const [hidden, setHidden] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('snw-hidden-jobs') ?? '[]'); } catch { return []; }
  });
  const hide = (id: string) => {
    const next = [...hidden, id].slice(-50);
    setHidden(next);
    try { localStorage.setItem('snw-hidden-jobs', JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const shown = jobs.filter((j) => !hidden.includes(j.id));
  if (!shown.length) return null;
  return (
    <div className="jobs">
      {shown.map((j) => (
        <span key={j.id} className={`job ${j.status}`} title={j.message ?? ''}>
          <span className="job-icon" />
          {j.kind === 'store_app' ? (/^[0-9a-f]{32}@/.test(j.target) ? `Store app ${j.target.split('@')[1] ?? ''}` : j.target.split('@')[0]) : j.kind === 'app_install' ? `installing ${j.target}` : j.kind === 'app_remove' ? `removing ${j.target}` : j.target}
          <span className="job-state">{j.status === 'running' ? `${j.percent}%` : j.status === 'successful' ? 'done' : j.status}</span>
          {j.status !== 'running' && <Countdown onDone={() => hide(j.id)} />}
          {j.status === 'running' && j.kind === 'app_install' && <button title="Cancel this install" aria-label="Cancel install" onClick={() => confirm(`Cancel installing ${j.target}?`) && api(`/jobs/${j.id}/cancel`, { method: 'POST' }).catch((e) => alert((e as Error).message))}>cancel</button>}
        </span>
      ))}
    </div>
  );
}

// A finished pill counts down on a small ring and then leaves by itself; hovering pauses it, a tap dismisses now.
function Countdown({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const go = () => { if (leaving) return; setLeaving(true); window.setTimeout(onDone, 380); };
  return (
    <button className={`job-timer ${leaving ? 'leaving' : ''}`} aria-label="Dismiss now" title={`Goes away by itself in ${LINGER_S} s · tap to dismiss now`} onClick={go}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" className="track" />
        <circle cx="10" cy="10" r="8" className="ring" style={{ animationDuration: `${LINGER_S}s` }} onAnimationEnd={go} />
      </svg>
    </button>
  );
}
