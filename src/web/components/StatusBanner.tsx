import { useEffect } from 'react';
import type { Status } from '../api.ts';

// While a PDI wakes up (a few minutes), check again every 30 s for up to 15 minutes, so the banner clears by itself.
export function useWakeRecheck(waking: boolean, recheck: () => void) {
  useEffect(() => {
    if (!waking) return;
    const started = Date.now();
    const t = setInterval(() => { if (Date.now() - started > 15 * 60_000) clearInterval(t); else recheck(); }, 30_000);
    return () => clearInterval(t);
  }, [waking]);
}

export function StatusBanner({ status, onRecheck, onSettings }: { status: Status | null; onRecheck: () => void; onSettings: () => void }) {
  useWakeRecheck(status?.state === 'hibernating', onRecheck);
  if (!status) {
    return (
      <div className="banner neutral">
        No PDI connected. <button className="link" onClick={onSettings}>Connect one</button>
      </div>
    );
  }
  // A failed automatic update is worth knowing about (it was rolled back, so the app still works).
  if (status.deploy && !status.deploy.ok) return (
    <div className="banner warn"><strong>Update didn't go through:</strong> {status.deploy.message}. Wayfinder is still on the previous version.</div>
  );
  const host = status.name || new URL(status.url).hostname.split('.')[0];
  const open = <a className="inst-link" href={status.url} target="_blank" rel="noreferrer" title={`Open ${status.url}`}>{host} ↗</a>;
  // A production or vendor instance is always labelled, whatever its state.
  const prod = status.kind === 'other' ? <span className="prod-chip" title="Not a personal developer instance: auto mode is off and Pip stays conservative">production / vendor</span> : null;
  if (status.state === 'hibernating') {
    return (
      <div className="banner warn waking">
        <strong>Your PDI is waking up</strong> (can take a few minutes). If you haven't woken it yet, do that from the developer site; this checks again by itself.
        <a href="https://developer.servicenow.com/" target="_blank" rel="noreferrer">Developer site</a>
        <button className="link" onClick={onRecheck}>Check now</button>
      </div>
    );
  }
  if (status.state !== 'awake') {
    return (
      <div className="banner error">
        {prod}<strong>Can't reach {host}:</strong> {status.message}
        <button className="link" onClick={onSettings}>Settings</button>
        <button className="link" onClick={onRecheck}>Check again</button>
      </div>
    );
  }
  if (status.remind) {
    return (
      <div className="banner warn">
        <strong>No login to {host} for {status.daysSinceLogin} days.</strong> ServiceNow reclaims a PDI after 10.
        <a href={`${status.url}/login.do`} target="_blank" rel="noreferrer">Log in now</a>
        <button className="link" onClick={onRecheck}>Check again</button>
      </div>
    );
  }
  return (
    <div className="banner ok">
      <span className="dot" /> {prod}{open} <span className="muted">{status.build ? `· ${status.build}` : ''}{status.kind === 'other' ? '' : status.daysSinceLogin != null ? ` · last login ${status.daysSinceLogin === 0 ? 'today' : `${status.daysSinceLogin}d ago`}` : status.loginNote ? ` · ${status.loginNote}` : ''}</span>
    </div>
  );
}
