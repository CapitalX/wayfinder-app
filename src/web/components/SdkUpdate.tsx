import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../live.ts';
import { Popover } from './HeaderTools.tsx';

interface SdkState {
  version: string; source: string; admin: boolean; previous: string | null; warning?: string; checkedAt: number | null;
  offer: { version: string; bytes: number | null } | null;
  health: { verified: string; errors: string[] };
  job: { version: string; state: string; step: string; errors: string[] } | null;
}
function useSdk() {
  const [state, setState] = useState<SdkState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void api<SdkState>('/sdk').then(setState).catch(() => {}); }, []);
  useEffect(() => { load(); const timer = setInterval(load, 30_000); return () => clearInterval(timer); }, [load]);
  useLive('sdk', load);
  useLive('instance', load);
  const act = async (action: string, version?: string) => {
    setBusy(true); setError('');
    try { setState(await api<SdkState>('/sdk', { body: { action, version } })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return { state, error, busy, act };
}
type Sdk = ReturnType<typeof useSdk>;
export function SdkControls({ state: s, busy, error, act }: Sdk) {
  if (!s) return null;
  const running = s.job?.state === 'running', decision = s.job?.state === 'needs decision';
  return <div className="sdk-update">
    <p className="small">ServiceNow SDK {s.version} · {s.source}.</p>
    <p className="muted small">Cheat sheet: {s.health.verified === 'yes' ? 'every example builds' : s.health.verified === 'no' ? "some examples didn't pass; Pip is warned" : s.health.verified === 'checking' ? 'checking' : 'matches the bundled reference'}.</p>
    {s.warning && <p className="error small">{s.warning}</p>}
    {s.admin && <>
      {s.offer && !running && !decision && <p className="small">Downloads {s.offer.bytes ? `about ${Math.max(1, Math.ceil(s.offer.bytes / 1024 ** 2))} MB for the SDK package, plus its dependencies` : 'the SDK and its dependencies'} beside the current SDK, checks the cheat sheet, then switches if it passes.</p>}
      {s.job && <p role="status" aria-live="polite" className="small">{running && <span className="dot-pulse" aria-hidden="true" />} {s.job.step}{s.job.state === 'done' ? ` · SDK ${s.job.version} is now in use.` : ''}</p>}
      {!!s.job?.errors.length && <ul className="error small">{s.job.errors.map((e, i) => <li key={i}>{e.slice(0, 500)}</li>)}</ul>}
      {decision ? <>
        <p className="small">SDK {s.version} is still in use. Use anyway switches to {s.job!.version} and warns Pip about these examples.</p>
        <div className="inline-form">
          <button className="primary" disabled={busy} onClick={() => act('keep', s.job!.version)}>Keep current</button>
          <button disabled={busy} onClick={() => act('use', s.job!.version)}>Use anyway</button>
        </div>
      </> : <div className="inline-form">
        {s.offer && <button className="primary" disabled={busy || running} onClick={() => act('install', s.offer!.version)}>Update to {s.offer.version}</button>}
        <button disabled={busy || running} onClick={() => act('check')}>{busy ? 'Working…' : 'Check now'}</button>
        {s.previous && <button disabled={busy || running} onClick={() => act('back', s.previous!)}>Go back to {s.previous}</button>}
      </div>}
      {s.checkedAt && <p className="muted tiny">Last checked {new Date(s.checkedAt).toLocaleString()}. New releases wait seven days; a new major waits for a Wayfinder release.</p>}
    </>}
    {error && <p role="alert" className="error small">{error}</p>}
  </div>;
}
export function SdkUpdate() { return <SdkControls {...useSdk()} />; }
export function SdkUpdatePill() {
  const sdk = useSdk(), s = sdk.state;
  if (!s?.admin || (!s.offer && !s.job)) return null;
  const label = s.offer ? `New ServiceNow SDK ${s.offer.version}` : s.job?.state === 'done' ? `ServiceNow SDK ${s.version} in use` : 'ServiceNow SDK update';
  return <Popover label={label} title="ServiceNow SDK update">{() => <SdkControls {...sdk} />}</Popover>;
}
