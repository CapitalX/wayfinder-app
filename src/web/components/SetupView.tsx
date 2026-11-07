import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Pip } from './Pip.tsx';
import { DocsDownload } from './DocsDownload.tsx';
import { ClaudeAccessOptions } from './ClaudeAccessOptions.tsx';

interface Setup {
  done: boolean;
  claude: { keySaved: boolean; envKey: boolean; test: { ok: boolean; source?: string; error?: string } | null };
  instance: boolean;
  extras: { docs: boolean; docsSource: 'server' | 'local' | null; sandbox: boolean };
}

// First run: three steps, each with a clear state and one obvious action. Nothing here is required twice.
export function SetupView({ onConnect, onDone }: { onConnect: () => void; onDone: () => void }) {
  const [s, setS] = useState<Setup | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api<Setup>('/setup').then(setS).catch(() => {});
  useEffect(() => { load(); }, []);

  const test = async (withKey?: string) => {
    setBusy(true); setErr('');
    try { await api('/setup/claude', { body: withKey ? { api_key: withKey } : {} }); setKey(''); } catch (e) { setErr((e as Error).message); }
    setBusy(false); load();
  };
  const finish = async () => { await api('/setup/done', { method: 'POST' }); onDone(); };
  if (!s) return null;
  const claudeOk = !!s.claude.test?.ok;

  return (
    <div className="settings setup">
      <div className="home-pip"><Pip size={64} track /><div><div className="ver">Welcome to Wayfinder</div><h1 style={{ margin: '4px 0 0' }}>Three quick steps</h1></div></div>

      <section className={`card step-card ${claudeOk ? 'ok' : ''}`}>
        <h2><span className="step-num">1</span> Connect Claude {claudeOk && <span className="status-chip st-installed">Working</span>}</h2>
        <ClaudeAccessOptions />
        {s.claude.test && !claudeOk && <p className="error small">{s.claude.test.error ?? 'Claude did not answer.'}</p>}
        {claudeOk && <p className="small">Using: {s.claude.test?.source ?? 'Claude'}.</p>}
        <div className="inline-form">
          <button className={claudeOk ? '' : 'primary'} disabled={busy} onClick={() => test()}>{busy ? 'Testing…' : claudeOk ? 'Test again' : 'Test Claude'}</button>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim() && !busy) test(key); }} placeholder="Paste an API key (sk-ant-…)" autoComplete="off" />
          <button disabled={busy || !key.trim()} onClick={() => test(key)}>Save key and test</button>
        </div>
        {err && <p className="error small">{err}</p>}
      </section>

      <section className={`card step-card ${s.instance ? 'ok' : ''}`}>
        <h2><span className="step-num">2</span> Connect your ServiceNow instance {s.instance && <span className="status-chip st-installed">Connected</span>}</h2>
        <p className="muted small">A free personal developer instance (PDI) from developer.servicenow.com is the easiest start. With a new PDI, <b>Set up my PDI for me</b> needs only its admin login, once: Wayfinder creates its own integration user and sign-in. Or pick another way: an integration user you made, your own sign-in, or a username and password. A PDI that was asleep takes a few minutes to wake; Wayfinder says so and checks again by itself.</p>
        <button className={s.instance ? '' : 'primary'} onClick={onConnect}>{s.instance ? 'Review the connection' : 'Connect an instance'}</button>
      </section>

      <section className="card step-card">
        <h2><span className="step-num">3</span> Optional extras</h2>
        <ul className="extras">
          <li className={s.extras.sandbox ? 'on' : ''}>{s.extras.sandbox ? '✓' : '○'} <b>Build sandbox</b>: generated apps build in isolation. {s.extras.sandbox ? 'On.' : 'Linux only: install bubblewrap.'}</li>
          <li className={s.extras.docs ? 'on' : ''}>{s.extras.docs ? '✓' : '○'} <b>Cited docs</b>: ServiceNow's official docs, so answers link their sources. {s.extras.docsSource === 'server' ? 'Using your docs server.' : s.extras.docsSource === 'local' ? 'On this machine.' : 'Not set up yet.'}
            {s.extras.docsSource !== 'server' && <DocsDownload />}</li>
        </ul>
      </section>

      <div className="row-actions">
        <button className="primary" autoFocus={claudeOk && !!s.instance} disabled={!claudeOk && !s.claude.keySaved && !s.claude.envKey && !s.instance} onClick={finish}>Start using Wayfinder</button>
        <button className="link" onClick={finish}>Skip for now</button>
      </div>
    </div>
  );
}
