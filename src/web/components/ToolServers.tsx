import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Server = { key: string; label: string; enabled: boolean; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env: Record<string, string>; headers: Record<string, string> };
const EMPTY = { key: '', label: '', enabled: false, transport: 'stdio' as const, command: '', args: [], env: {}, headers: {} };

export function ToolServers() {
  const [servers, setServers] = useState<Server[]>([]);
  const [draft, setDraft] = useState<Server | null>(null);
  const [editing, setEditing] = useState(false);
  const [args, setArgs] = useState('[]');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ key: string; tools: string[] } | null>(null);
  useEffect(() => { api<Server[]>('/tool-servers').then(setServers).catch((e) => setError(e.message)); }, []);
  const edit = (server: Server, existing: boolean) => {
    setDraft(server); setEditing(existing); setArgs(JSON.stringify(server.args ?? [])); setSecret(''); setError('');
  };
  const mutate = async (path: string, method: string, body: unknown = {}) => {
    setBusy(true); setError(''); setResult(null);
    try { setServers(await api<Server[]>(path, { method, body })); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft) return;
    let values: Record<string, string> | undefined, argv: string[] = [];
    try {
      if (secret.trim()) {
        values = JSON.parse(secret);
        if (!values || Array.isArray(values) || typeof values !== 'object' || Object.values(values).some((v) => typeof v !== 'string')) throw new Error();
      }
      if (draft.transport === 'stdio') { argv = JSON.parse(args); if (!Array.isArray(argv) || argv.some((v) => typeof v !== 'string')) throw new Error(); }
    } catch { setError('Arguments must be a JSON array of strings. Secrets must be a JSON object with string values.'); return; }
    const body = { key: draft.key, label: draft.label, enabled: draft.enabled, transport: draft.transport,
      ...(draft.transport === 'stdio' ? { command: draft.command, args: argv, ...(values ? { env: values } : {}) } : { url: draft.url, ...(values ? { headers: values } : {}) }) };
    if (await mutate(`/tool-servers${editing ? `/${draft.key}` : ''}`, editing ? 'PUT' : 'POST', body)) { setDraft(null); setSecret(''); }
  };
  const test = async (server: Server) => {
    setBusy(true); setError(''); setResult(null);
    try { const out = await api<{ tools: string[] }>(`/tool-servers/${server.key}/test`, { body: {} }); setResult({ key: server.key, tools: out.tools }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <p className="muted">Wayfinder’s built-in instance server stays the default. Added tools ask before every call and are unavailable in read-only modes or when changes are off in Safety. Changes apply to the next answer.</p>
    <p className="muted">Only add servers you trust. Test connects to the server even when disabled. Local programs run with Wayfinder’s permissions; HTTP servers receive the headers you supply. Instance credentials are never supplied automatically.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {servers.map((server) => <section className="card set-card" key={server.key} aria-label={server.label}>
      <h3>{server.label}</h3>
      <p className="small muted"><code>{server.key}</code> · {server.transport}</p>
      <label className="toggle"><input type="checkbox" checked={server.enabled} disabled={busy} onChange={(e) => void mutate(`/tool-servers/${server.key}`, 'PATCH', { enabled: e.target.checked })} />Enable {server.label}</label>
      <p className="small">{Object.entries(server.transport === 'stdio' ? server.env : server.headers).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Secrets: not set'}</p>
      <div className="row-actions wrap">
        <button disabled={busy} onClick={() => edit(server, true)}>Edit {server.label}</button>
        <button disabled={busy} onClick={() => void test(server)}>Test {server.label}</button>
        <button disabled={busy} onClick={() => void mutate(`/tool-servers/${server.key}`, 'DELETE')}>Remove {server.label}</button>
      </div>
      {result?.key === server.key && <div role="status"><p>{result.tools.length} tools available</p><ul>{result.tools.map((t, i) => <li key={`${t}-${i}`}><code>{t}</code></li>)}</ul></div>}
    </section>)}
    {!draft ? <button onClick={() => edit(EMPTY, false)}>Add tool server</button> : <form className="card set-card tool-server-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3>{editing ? 'Edit tool server' : 'Add tool server'}</h3>
      <label className="field">Server key<input required disabled={editing || busy} value={draft.key} pattern="[a-z0-9]+(_[a-z0-9]+)*" maxLength={40} onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></label>
      <p className="small muted">A unique lowercase key with letters, digits and single underscores. Built-in names are reserved.</p>
      <label className="field">Label<input required value={draft.label} maxLength={100} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
      <label className="field">Transport<select value={draft.transport} onChange={(e) => { setDraft({ ...draft, transport: e.target.value as Server['transport'] }); setSecret(''); }}><option value="stdio">Local program (stdio)</option><option value="http">HTTP</option></select></label>
      {draft.transport === 'stdio' ? <>
        <p className="warn" role="note">This runs a local program with Wayfinder’s permissions, including access to its files. Adding and enabling it lets Wayfinder start it for answers. Test starts it immediately.</p>
        <label className="field">Command<input required value={draft.command ?? ''} onChange={(e) => setDraft({ ...draft, command: e.target.value })} /></label>
        <label className="field">Arguments (JSON array)<textarea value={args} onChange={(e) => setArgs(e.target.value)} /></label>
      </> : <label className="field">Server URL<input required type="url" value={draft.url ?? ''} placeholder="https://example.com/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></label>}
      <label className="field">{draft.transport === 'stdio' ? 'Environment' : 'Headers'} (secret JSON object)<input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      <p className="small muted">Use string keys and values, for example {draft.transport === 'stdio' ? '{"API_KEY":"value"}' : '{"Authorization":"Bearer value"}'}. Leave blank to keep saved values; use {'{}'} to clear them. Put credentials here, never in arguments or the URL. Saved values are never shown.</p>
      <label className="toggle"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Enable this server</label>
      <div className="row-actions wrap"><button className="primary" disabled={busy} type="submit">Save tool server</button><button disabled={busy} type="button" onClick={() => { setDraft(null); setSecret(''); }}>Cancel</button></div>
    </form>}
  </>;
}
