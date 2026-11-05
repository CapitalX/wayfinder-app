import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../live.ts';

interface Job { state: 'running' | 'done' | 'failed'; release: string; step: string; detail?: string }
interface Local {
  source: 'server' | 'local' | null;
  releases: { release: string; docs?: number; indexed_at?: string; bytes: number }[];
  job: Job | null; auto: { at: number; actions: { release: string; action: 'update' | 'download' | 'remove' }[]; error?: string } | null; free: number | null; need: number;
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The ServiceNow docs Pip cites: download and index them on this machine (once, a few minutes), or update them.
// Used in Settings → Pip and on the first-run screen. Progress comes live from the server.
export function DocsDownload() {
  const [d, setD] = useState<Local | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Local>('/docs/local').then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  useLive('docs', (x) => { const job = x.job as Job | undefined; if (job) setD((p) => p ? { ...p, job } : p); if (job?.state !== 'running') load(); });
  if (!d) return null;

  const start = async (update: boolean) => {
    setErr('');
    try { const r = await api<{ job: Job }>('/docs/local', { body: { update } }); setD({ ...d, job: r.job }); }
    catch (e) { setErr((e as Error).message); }
  };
  const running = d.job?.state === 'running';
  const have = d.releases[0];
  const lowDisk = d.free !== null && d.free < d.need && !have;

  return (
    <div className="docs-dl">
      {d.source === 'server' && <p className="small">Pip uses the docs server set up on this machine.{have ? ' The docs below are a fallback.' : ''}</p>}
      {have
        ? <p className="small">{cap(have.release)} docs on this machine: {Number(have.docs ?? 0).toLocaleString()} pages, {gb(have.bytes)}{have.indexed_at ? `, updated ${have.indexed_at.slice(0, 10)}` : ''}.</p>
        : <p className="small">Download ServiceNow's official docs (about 1.5 GB) so Pip's answers cite them with links. It runs on this machine; nothing is sent anywhere.</p>}
      {running && (
        <div className="docs-progress" role="status" aria-live="polite">
          <span className="dot-pulse" aria-hidden="true" /> {d.job!.step}{d.job!.detail ? `: ${d.job!.detail}` : ''}
        </div>
      )}
      {d.job?.state === 'failed' && <p className="error small">{d.job.detail}</p>}
      {d.job?.state === 'done' && !running && <p className="small">Ready. Pip cites the {cap(d.job.release)} docs from the next answer on.</p>}
      {lowDisk && <p className="error small">Not enough disk space: the docs need about {gb(d.need)} free and there is {gb(d.free!)}.</p>}
      {err && <p className="error small">{err}</p>}
      <div className="inline-form">
        {have
          ? <button disabled={running} onClick={() => start(true)}>{running ? 'Working…' : 'Check for updates'}</button>
          : <button className="primary" disabled={running || lowDisk} onClick={() => start(false)}>{running ? 'Downloading…' : 'Download ServiceNow docs (~1.5 GB)'}</button>}
      </div>
      {have && <p className="muted tiny">Kept current by itself: every day Wayfinder fetches changed pages, downloads the newest release when ServiceNow publishes it, and removes older ones. The newest and the release you selected stay.{d.auto ? ` Last check ${new Date(d.auto.at).toLocaleString()}: ${d.auto.error ? `failed (${d.auto.error})` : d.auto.actions.length ? d.auto.actions.map((a) => `${a.action}d ${a.release}`).join(', ') : 'nothing new'}.` : ''}</p>}
      <p className="muted tiny">From github.com/ServiceNow/ServiceNowDocs (Apache-2.0), for your instance's release. Needs git. Same as <code>wayfinder docs setup</code>.</p>
    </div>
  );
}
