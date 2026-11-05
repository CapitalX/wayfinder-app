import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useLive } from '../live.ts';
import { api, type Access, type Instance, type Settings, type ScriptRunnerCard } from '../api.ts';
import { Pip, setPresence } from './Pip.tsx';
import { urlProblem } from '../urlCheck.ts';
import { money, OPEN_MEMORY, ScriptRunnerSummary } from './Blocks.tsx';
import { ToolServers } from './ToolServers.tsx';
import { Routines } from './Routines.tsx';
import { SkillsCard } from './Skills.tsx';
import { PlacementRulesCard } from './PlacementRules.tsx';
import { DocsDownload } from './DocsDownload.tsx';

const WAKING_NOTE = 'Your PDI is waking up (can take a few minutes). Press Test again once it\'s awake.';

interface SetupPlan { admin: string; extraRoles: string[]; plan_id: string; steps: { key: string; label: string; action: 'create' | 'update' | 'keep' | 'skip'; detail?: string }[] }
interface TestResult { state: string; message?: string; build?: string; daysSinceLogin?: number | null; loginNote?: string }
const lastLogin = (t: TestResult) => (t.daysSinceLogin === 0 ? 'last login today' : t.daysSinceLogin != null ? `last login ${t.daysSinceLogin} days ago` : t.loginNote ?? 'last login unknown');

// Settings, grouped by what you came to do. Desktop: a section list on the left (each with its current state) and the
// open section on the right. Phone: the list first; tapping a row opens that section, with a way back.
// The open section lives in the address (#settings/<section>), so a link can open it directly.
const GROUPS = [
  { id: 'instances', title: 'Instances', summary: 'Which ServiceNow instances Pip works on, and what each account can do.' },
  { id: 'pip', title: 'Pip', summary: 'How Pip looks, which model answers, and what it has learned about your instance.' },
  { id: 'safety', title: 'Safety', summary: 'What Pip may change, where it may look on the web, and who can sign in.' },
  { id: 'tools', title: 'Tool servers', summary: 'Connect your own MCP servers so Pip can use their tools.' },
  { id: 'routines', title: 'Routines', summary: 'Questions Pip answers on a schedule, each run a chat of its own.' },
  { id: 'advanced', title: 'Advanced', summary: 'Diagnostics: the Fluent build check and how fast answers are.' },
] as const;
type Group = typeof GROUPS[number]['id'];
const fromHash = (): Group | null => {
  const g = window.location.hash.match(/^#settings\/(\w+)/)?.[1];
  return GROUPS.some((x) => x.id === g) ? (g as Group) : null;
};

// Small screens drill in; wide ones show list and section side by side.
function useNarrow() {
  const q = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

type Toast = { text: string; bad?: boolean; n: number };
type Say = (text: string, bad?: boolean) => void;

export function SettingsView({ onInstanceChange, onOpenChat }: { onInstanceChange: () => void; onOpenChat: (id: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [list, setList] = useState<Instance[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [group, setGroup] = useState<Group | null>(fromHash);
  const [toast, setToast] = useState<Toast | null>(null);
  const narrow = useNarrow();
  const head = useRef<HTMLHeadingElement>(null);

  const load = () => {
    api<Settings>('/settings').then(setSettings);
    api<Instance[]>('/instances').then(setList);
    api<any[]>('/audit').then(setAudit);
  };
  useEffect(load, []);
  useLive('instance', load);
  // Leaving Settings drops its #settings/<section> from the address.
  useEffect(() => () => { if (window.location.hash.startsWith('#settings')) try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* sandboxed */ } }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.bad ? 7000 : 3500); return () => clearTimeout(t); }, [toast]);

  const say: Say = (text, bad) => setToast({ text, bad, n: Date.now() });
  const save = async (patch: Partial<Settings>) => {
    try { setSettings(await api<Settings>('/settings', { method: 'PUT', body: patch })); say('Saved'); } catch (e) { say((e as Error).message, true); }
  };
  const open = (g: Group | null) => {
    setGroup(g);
    try { history.replaceState(null, '', g ? `#settings/${g}` : window.location.pathname + window.location.search); } catch { /* sandboxed */ }
    setTimeout(() => head.current?.focus(), 0);
  };

  if (!settings) return <div className="settings"><p className="muted pad">Loading…</p></div>;
  const active = list.find((i) => i.status === 'active');
  const shown: Group | null = group ?? (narrow ? null : 'instances');
  const state: Record<Group, string> = {
    instances: active ? `${active.name} · ${active.kind === 'other' ? 'production / vendor' : 'PDI'}` : 'None connected',
    pip: `${settings.model === 'sonnet' ? 'Sonnet' : 'Opus'} · ${{ alive: 'Alive', still: 'Still', off: 'Off' }[settings.presence ?? 'alive']}`,
    safety: !settings.writeEnabled ? 'Read-only' : active?.full_permissions === 1 && active.kind === 'pdi' ? 'Full permissions' : settings.scriptingEnabled ? 'Changes and scripts ask first' : 'Changes ask first',
    tools: 'Your MCP connections',
    routines: 'Scheduled checks',
    advanced: 'Build check · speed',
  };
  const meta = GROUPS.find((g) => g.id === shown);

  return (
    <div className="settings settings2">
      {(!narrow || !shown) && <h1>Settings</h1>}
      <div className={`set-layout${shown ? ' has-section' : ''}`}>
        {(!narrow || !shown) && (
          <nav className="set-nav" aria-label="Settings sections">
            <ul>
              {GROUPS.map((g) => (
                <li key={g.id}>
                  <button className="set-nav-item" aria-current={shown === g.id ? 'page' : undefined} onClick={() => open(g.id)}>
                    <span className="set-nav-title">{g.title}</span>
                    <span className="set-nav-state">{state[g.id]}</span>
                    {narrow && <span className="set-nav-chev" aria-hidden>›</span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {shown && meta && (
          <section className="set-section" aria-labelledby="set-section-title">
            {narrow && <button className="set-back" onClick={() => open(null)}>‹ Settings</button>}
            <h2 id="set-section-title" ref={head} tabIndex={-1}>{meta.title}</h2>
            <p className="set-summary">{meta.summary}</p>
            {shown === 'instances' && <InstancesSection list={list} settings={settings} save={save} say={say} reload={load} onInstanceChange={onInstanceChange} openSafety={() => open('safety')} />}
            {shown === 'pip' && <PipSection settings={settings} save={save} say={say} />}
            {shown === 'safety' && <SafetySection settings={settings} save={save} say={say} audit={audit} active={active} onChanged={() => { load(); onInstanceChange(); }} />}
            {shown === 'tools' && <ToolServers />}
            {shown === 'routines' && <Routines onOpenChat={onOpenChat} />}
            {shown === 'advanced' && <><FluentCard /><SpeedCard /></>}
          </section>
        )}
      </div>
      <div className="toast-region" aria-live="polite" role="status">
        {toast && <div key={toast.n} className={`toast${toast.bad ? ' bad' : ''}`}>{toast.text}</div>}
      </div>
    </div>
  );
}

// A card: title, then its current state, then everything else.
export function Card({ title, state, children, className = '' }: { title: string; state?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`card set-card ${className}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {state && <p className="set-state">{state}</p>}
      {children}
    </section>
  );
}

// A button for something you can't undo: it asks right there, in a small box under the button.
// Anything extra (a checkbox, say) goes in children, between the question and the buttons.
export function ConfirmButton({ label, question, confirmLabel, onConfirm, className = '', disabled, children }: { label: string; question: string; confirmLabel: string; onConfirm: () => unknown; className?: string; disabled?: boolean; children?: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { if (asking) yes.current?.focus(); }, [asking]);
  return (
    <span className="confirm-wrap" onKeyDown={(e) => { if (e.key === 'Escape' && asking) { e.stopPropagation(); setAsking(false); } }}>
      <button className={`danger-btn ${className}`} disabled={disabled} aria-expanded={asking} aria-controls={id} onClick={() => setAsking((a) => !a)}>{label}</button>
      {asking && (
        <span className="confirm-pop" id={id} role="dialog" aria-label={question}>
          <span className="small">{question}</span>
          {children}
          <span className="row-actions">
            <button onClick={() => setAsking(false)}>Cancel</button>
            <button ref={yes} className="danger" onClick={async () => { setAsking(false); await onConfirm(); }}>{confirmLabel}</button>
          </span>
        </span>
      )}
    </span>
  );
}

// A password field with a Show/Hide switch.
function SecretInput({ label, value, onChange, required, autoComplete, hint }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; autoComplete: string; hint?: string }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="secret">
        <input id={id} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} required={required} autoComplete={autoComplete} spellCheck={false} />
        <button type="button" className="reveal" aria-pressed={show} aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
      </span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function Field({ label, children, hint, error }: { label: string; children: (id: string, describedBy?: string) => ReactNode; hint?: string; error?: string }) {
  const id = useId();
  const help = error || hint ? `${id}-help` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, help)}
      {error ? <span id={help} className="hint field-err" role="alert">{error}</span> : hint && <span id={help} className="hint">{hint}</span>}
    </div>
  );
}

// ── Instances ────────────────────────────────────────────────────────────────

const EMPTY_FORM = { url: '', auth: 'auto', client_id: '', client_secret: '', username: '', password: '', login_user: 'admin', name: '', allow_non_pdi: false };

function InstancesSection({ list, settings, save, say, reload, onInstanceChange, openSafety }: { list: Instance[]; settings: Settings; save: (p: Partial<Settings>) => void; say: Say; reload: () => void; onInstanceChange: () => void; openSafety: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const active = list.find((i) => i.status === 'active');
  const retired = list.filter((i) => i.status !== 'active');
  const changed = () => { reload(); onInstanceChange(); };
  return (
    <>
      {active ? <InstanceCard inst={active} settings={settings} say={say} onChanged={changed} openSafety={openSafety} />
        : !connecting && (
          <Card title="No instance yet" state="Connect a personal developer instance (PDI) to let Pip read it, explain it and build on it.">
            <div className="row-actions"><button className="primary" onClick={() => setConnecting(true)}>Connect an instance</button></div>
          </Card>
        )}
      {active && <Card title="Full permissions"><FullPermissions key={active.id} inst={active} say={say} onChanged={changed} /></Card>}

      {retired.length > 0 && (
        <Card title="Other instances" state={`${retired.length} not in use. Their chats stay readable.`}>
          <ul className="plain-list">
            {retired.map((i) => <RetiredRow key={i.id} inst={i} say={say} onChanged={changed} />)}
          </ul>
        </Card>
      )}

      {connecting ? <ConnectForm say={say} onDone={() => { setConnecting(false); changed(); }} onCancel={() => setConnecting(false)} />
        : (active || retired.length > 0) && <div className="row-actions set-add"><button onClick={() => setConnecting(true)}>+ Connect an instance</button></div>}

      <Card title="Login reminder" state={settings.reminderDays ? `On: a reminder after ${settings.reminderDays} days without a login.` : 'Off.'}>
        <Field label="Remind me to log in after" hint="ServiceNow reclaims a PDI after 10 days without an interactive login.">
          {(id, d) => (
            <select id={id} aria-describedby={d} value={settings.reminderDays} onChange={(e) => save({ reminderDays: Number(e.target.value) })}>
              {[0, 3, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n ? `${n} days` : 'Never (off)'}</option>)}
            </select>
          )}
        </Field>
      </Card>
    </>
  );
}

// A retired instance: make it active again, or remove it (the question opens under the button).
function RetiredRow({ inst: i, say, onChanged }: { inst: Instance; say: Say; onChanged: () => void }) {
  const [dropChats, setDropChats] = useState(false);
  const chats = i.chat_count ?? 0;
  const n = `${chats} chat${chats === 1 ? '' : 's'}`, stay = chats === 1 ? 'stays' : 'stay';
  const remove = async () => {
    try {
      await api(`/instances/${i.id}/remove`, { body: { delete_chats: dropChats } });
      say(`Removed ${i.name}${chats ? (dropChats ? ` and its ${n}` : `; its ${n} ${stay} readable`) : ''}`);
      onChanged();
    } catch (e) { say((e as Error).message, true); }
  };
  return (
    <li className="inst-row retired">
      <span className="grow"><b>{i.name}</b> <span className="muted small break">{i.url}</span>{chats > 0 && <span className="muted small"> · {n}</span>}</span>
      <span className="row-actions">
        <button onClick={async () => { try { await api(`/instances/${i.id}/activate`, { method: 'POST' }); say(`${i.name} is now active`); onChanged(); } catch (e) { say((e as Error).message, true); } }}>Make active</button>
        <ConfirmButton label="Remove" confirmLabel={dropChats ? 'Remove with chats' : 'Remove'} onConfirm={remove}
          question={`Remove ${i.name}? Its stored sign-in is deleted. ${chats ? `Its ${n} ${stay} readable, labelled with ${i.url}.` : 'It has no chats.'}`}>
          {chats > 0 && <label className="small check"><input type="checkbox" checked={dropChats} onChange={(e) => setDropChats(e.target.checked)} /> Also delete its {n}</label>}
        </ConfirmButton>
      </span>
    </li>
  );
}

function InstanceCard({ inst, settings, say, onChanged, openSafety }: { inst: Instance; settings: Settings; say: Say; onChanged: () => void; openSafety: () => void }) {
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState('');
  const a = inst.access;
  const method = inst.auth === 'oauth_user' ? 'Signed in as you' : inst.auth === 'basic' ? 'Username & password' : 'Integration user (OAuth)';
  const describe = (t: TestResult) => t.state === 'awake' ? ['Connected', t.build, lastLogin(t)].filter(Boolean).join(' · ') : t.state === 'hibernating' ? WAKING_NOTE : `${t.state}: ${t.message ?? ''}`;
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setResult('');
    try { const r = await fn(); setResult(r); say(r); } catch (e) { setResult((e as Error).message); say((e as Error).message, true); }
    setBusy('');
  };
  const nameId = useId();
  return (
    <section className="card set-card inst-card" aria-labelledby={nameId}>
      <h3 id={nameId} className="sr-only">{inst.name}</h3>
      <div className="inst-head">
        <input className="inst-name" defaultValue={inst.name} aria-label="Instance name (rename)" title="Rename how this instance shows in the app"
          onBlur={async (e) => { const name = e.target.value.trim(); if (name && name !== inst.name) { try { await api(`/instances/${inst.id}`, { method: 'PUT', body: { name } }); say('Renamed'); onChanged(); } catch (err) { say((err as Error).message, true); } } }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className={inst.kind === 'other' ? 'prod-chip' : 'kind-chip'}>{inst.kind === 'other' ? 'production / vendor' : 'PDI'}</span>
      </div>
      <a className="small break" href={inst.url} target="_blank" rel="noreferrer">{inst.url} ↗</a>
      <p className="set-state">
        {a ? <><b>{a.user}</b>{a.admin ? ' · admin' : a.admin === false ? ' · not admin' : ''} · {inst.can?.install ? 'can install plugins' : 'no plugin installs'} · {inst.can?.build ? 'can install apps' : 'can build apps, not install them'}</>
          : 'Access not checked yet.'}
      </p>
      <p className="muted small">
        {method}{inst.client_id ? ` · client ID ${inst.client_id.slice(0, 6)}…` : ''} · reminders watch <code>{inst.login_user}</code>
        {' · '}changes {!settings.writeEnabled ? 'off' : inst.kind === 'pdi' && inst.full_permissions === 1 ? 'auto-approved' : 'ask first'} <button className="link small" onClick={openSafety}>change</button>
      </p>
      <div className="row-actions wrap">
        <button className="primary" disabled={!!busy} onClick={() => run('test', async () => describe(await api<TestResult>(`/instances/${inst.id}/test`, { method: 'POST' })))}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
        <button disabled={!!busy} onClick={() => run('backup', async () => {
          const r = await api<{ dir: string; sets: { name: string; records: number }[] }>(`/instances/${inst.id}/backup`, { method: 'POST' });
          return `Saved ${r.sets.length} update sets (${r.sets.reduce((n, s) => n + s.records, 0)} changes) to ${r.dir}`;
        })}>{busy === 'backup' ? 'Backing up…' : 'Back up update sets'}</button>
      </div>
      <ScriptRunnerSettings key={inst.id} inst={inst} settings={settings} say={say} onChanged={onChanged} />
      {result && <p className="small result break">{result}</p>}
      <details className="access-details">
        <summary>What this account can do</summary>
        <AccessView inst={inst} onChanged={onChanged} say={say} />
      </details>
    </section>
  );
}

function ConnectForm({ say, onDone, onCancel }: { say: Say; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const set = (patch: Partial<typeof EMPTY_FORM>) => setForm((f) => ({ ...f, ...patch }));
  const bad = urlProblem(form.url);
  const describe = (t: TestResult) => t.state === 'awake' ? ['Connected', t.build, lastLogin(t)].filter(Boolean).join(' · ') : t.state === 'hibernating' ? `Saved. ${WAKING_NOTE}` : `${t.state}: ${t.message ?? ''}`;
  // Set up my PDI for me: first a read-only look (what it will create), then the user confirms.
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [keepRoles, setKeepRoles] = useState(true);
  const auto = form.auth === 'auto';
  const notPdi = /^https:\/\//.test(form.url.trim()) && !/^https:\/\/dev\d+\.service-now\.com\/?$/.test(form.url.trim());
  // Set it up carries the plan's id: the server only runs it for the address and admin the plan was made for.
  const autoBody = (confirm: boolean) => ({ url: form.url, username: form.username.trim() || 'admin', password: form.password, confirm, ...(confirm && plan ? { plan_id: plan.plan_id, keep_extra_roles: keepRoles } : {}) });
  const setUp = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ instance: Instance; status: TestResult }>('/instances/pdi-setup', { body: autoBody(true) });
      set({ password: '' }); setPlan(null);
      say(r.status.state === 'awake' ? 'Set up and connected with its own integration user' : describe(r.status), r.status.state !== 'awake' && r.status.state !== 'hibernating');
      onDone();
    } catch (err) { setError((err as Error).message); say((err as Error).message, true); }
    setBusy(false);
  };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (bad) return;
    setBusy(true); setError('');
    try {
      if (auto) {
        const r = await api<{ plan: Omit<SetupPlan, 'plan_id'>; plan_id: string }>('/instances/pdi-setup', { body: autoBody(false) });
        setPlan({ ...r.plan, plan_id: r.plan_id }); setKeepRoles(true);
        setBusy(false);
        return;
      }
      const r = await api<{ instance: Instance; status?: TestResult; needs_login?: boolean; reconnected?: boolean }>('/instances', { body: form });
      if (r.needs_login) {
        // Sign in as me: off to the instance's own login page (and your SSO), then back here.
        const start = await api<{ url: string }>(`/instances/${r.instance.id}/oauth/start`, { body: { origin: window.location.origin } });
        window.location.href = start.url;
        return;
      }
      const same = r.reconnected ? `${r.instance.name} was already here: it now uses this sign-in. ` : '';
      say(same + describe(r.status!), r.status?.state !== 'awake' && r.status?.state !== 'hibernating');
      onDone();
    } catch (err) { setError((err as Error).message); say((err as Error).message, true); }
    setBusy(false);
  };

  return (
    <Card title="Connect an instance" className="connect-card">
      <div className="seg-row" role="group" aria-label="How Wayfinder signs in">
        {([['auto', 'Set up my PDI for me'], ['client_credentials', 'Integration user (OAuth)'], ['oauth_user', 'Sign in as me'], ['basic', 'Username & password']] as const).map(([k, v], i) => (
          <button key={k} ref={i === 0 ? first : undefined} type="button" className={form.auth === k ? 'on' : ''} aria-pressed={form.auth === k} onClick={() => { set({ auth: k, password: '' }); setPlan(null); setError(''); }}>{v}</button>
        ))}
      </div>
      <p className="hint">
        {auto ? 'Easiest for a new PDI: give Wayfinder the admin login once. It creates its own integration user and sign-in, then discards the password.'
          : form.auth === 'client_credentials' ? 'Recommended for PDIs: an integration user with the roles you choose.'
          : form.auth === 'oauth_user' ? 'Best for company and vendor instances: Wayfinder acts as you, and every change shows your name.'
          : 'Only where OAuth isn\'t possible. The password is stored on this server, hidden from builds.'}
      </p>
      {!auto && <details className="howto">
        <summary>How to set this up</summary>
        <ol className="steps small">
          {form.auth === 'client_credentials' && <>
            <li>On the instance, open <b>All › Machine Identity Console › Inbound integrations › New integration</b> and pick <b>OAuth – Client credentials grant</b>.</li>
            <li>Set its user to an integration user. For everything (plugins, building apps) give it <code>admin</code> and <code>sn_cicd.sys_ci_automation</code>; with fewer roles Wayfinder still works and stays within them.</li>
            <li>Paste the instance URL, client ID and secret here.</li>
          </>}
          {form.auth === 'oauth_user' && <>
            <li>On the instance, create an inbound integration with <b>OAuth – Authorization code grant</b> and set its redirect URL to <code>{window.location.origin}/api/oauth/callback</code>.</li>
            <li>Paste the URL and client ID (and the secret, if the app has one). You'll sign in on the instance (and your company's SSO); Wayfinder then acts as you, with your roles, and only keeps a refresh token.</li>
          </>}
          {form.auth === 'basic' && <li>Prefer an integration user over your own account. The password is kept in a mode-600 file on this server.</li>}
        </ol>
      </details>}
      <form className="grid-form" onSubmit={connect}>
        <Field label="Instance URL" hint="For example https://dev12345.service-now.com" error={bad}>
          {(id, d) => <input id={id} aria-describedby={d} aria-invalid={!!bad} value={form.url} onChange={(e) => { set({ url: e.target.value }); setPlan(null); }} placeholder="https://dev12345.service-now.com" required inputMode="url" autoComplete="off" spellCheck={false} />}
        </Field>
        {auto && notPdi && !bad && <p className="small field-err full">Only for personal developer instances (https://devNNNNN.service-now.com). Pick another way to sign in for this one.</p>}
        {auto && <Field label="Admin username" hint="The PDI's admin, from developer.servicenow.com. Usually admin.">{(id, d) => <input id={id} aria-describedby={d} value={form.username} onChange={(e) => { set({ username: e.target.value }); setPlan(null); }} placeholder="admin" autoComplete="off" spellCheck={false} />}</Field>}
        {auto && <SecretInput label="Admin password" value={form.password} onChange={(v) => { set({ password: v }); setPlan(null); }} required autoComplete="off" hint="Used for this setup only. Not saved." />}
        {!auto && form.auth !== 'basic' && <Field label="Client ID">{(id) => <input id={id} value={form.client_id} onChange={(e) => set({ client_id: e.target.value })} required autoComplete="off" spellCheck={false} />}</Field>}
        {!auto && form.auth !== 'basic' && <SecretInput label={`Client secret${form.auth === 'oauth_user' ? ' (if any)' : ''}`} value={form.client_secret} onChange={(v) => set({ client_secret: v })} required={form.auth === 'client_credentials'} autoComplete="off" />}
        {form.auth === 'basic' && <Field label="Username">{(id) => <input id={id} value={form.username} onChange={(e) => set({ username: e.target.value })} required autoComplete="off" />}</Field>}
        {form.auth === 'basic' && <SecretInput label="Password" value={form.password} onChange={(v) => set({ password: v })} required autoComplete="new-password" />}
        {!auto && <Field label="Your login user" hint="The user you log in as; reminders watch its last login.">
          {(id, d) => <input id={id} aria-describedby={d} value={form.login_user} onChange={(e) => set({ login_user: e.target.value })} />}
        </Field>}
        {!auto && form.url && !bad && !/^(https:\/\/)?dev\d+\.service-now\.com\/?$/.test(form.url.trim()) && (
          <label className="toggle optin">
            <input type="checkbox" checked={form.allow_non_pdi} onChange={(e) => set({ allow_non_pdi: e.target.checked })} />
            <span>This is a production or vendor instance, and I want to connect it anyway <span className="muted small">(it stays labelled, auto mode is off, and every change still asks you)</span></span>
          </label>
        )}
        {error && <p className="small field-err full" role="alert">{error}</p>}
        {plan ? (
          <div className="setup-plan full" role="region" aria-label="What Wayfinder will do on the instance">
            <p className="small"><b>Here's what Wayfinder will do on the instance</b>, signed in as {plan.admin}:</p>
            <ul className="result-items">
              {plan.steps.map((st) => (
                <li key={st.key} className={`plan-${st.action}`}>
                  <span className="plan-tag">{st.action === 'create' ? (st.key === 'test' ? 'check' : 'add') : st.action === 'update' ? 'change' : st.action === 'keep' ? 'already there' : 'skip'}</span>
                  <span>{st.label}{st.detail ? <span className="muted">: {st.detail}</span> : null}</span>
                </li>
              ))}
            </ul>
            {plan.extraRoles.length > 0 && (
              <label className="toggle">
                <input type="checkbox" checked={keepRoles} onChange={(e) => setKeepRoles(e.target.checked)} />
                <span>Keep its other roles ({plan.extraRoles.join(', ')}) <span className="muted small">untick to remove them from {'wayfinder.integration'}</span></span>
              </label>
            )}
            <p className="muted small">Then it connects with the new sign-in and discards the admin password. Each change goes in the activity log as it happens.</p>
            <div className="row-actions">
              <button className="primary" type="button" disabled={busy} onClick={setUp} autoFocus>{busy ? 'Setting up…' : 'Set it up'}</button>
              <button type="button" disabled={busy} onClick={() => setPlan(null)}>Back</button>
            </div>
          </div>
        ) : (
          <div className="row-actions full">
            <button className="primary" type="submit" disabled={busy || !!bad || (auto && notPdi)}>{busy ? (auto ? 'Checking…' : 'Connecting…') : auto ? 'Check what it will do' : form.auth === 'oauth_user' ? 'Connect and sign in' : 'Connect and test'}</button>
            <button type="button" onClick={onCancel}>Cancel</button>
          </div>
        )}
      </form>
    </Card>
  );
}

const READ_LABEL: Record<string, string> = {
  incident: 'Incidents', sys_user: 'Users', sys_script: 'Business rules', syslog: 'System logs', sys_properties: 'System properties',
  v_plugin: 'Plugins', sys_update_set: 'Update sets', sys_app: 'Custom apps', sys_db_object: 'Table definitions',
};

// What the connected account can actually do, as the instance answered (refreshed every 6 hours and on Test).
function AccessView({ inst, onChanged, say }: { inst: Instance; onChanged: () => void; say: Say }) {
  const [busy, setBusy] = useState(false);
  const a: Access | null | undefined = inst.access;
  const recheck = async () => { setBusy(true); try { await api(`/instances/${inst.id}/access`, { method: 'POST' }); say('Access checked'); } catch (e) { say((e as Error).message, true); } setBusy(false); onChanged(); };
  const signIn = async () => { const r = await api<{ url: string }>(`/instances/${inst.id}/oauth/start`, { body: { origin: window.location.origin } }); window.location.href = r.url; };
  return (
    <div className="access">
      {!a ? <p className="muted small">Not checked yet. Check again once the instance is awake.</p> : (
        <>
          <p className="small">{a.roles ? `${a.roles.length} roles` : 'Roles are hidden from this account.'} Tables it can read:</p>
          <ul className="reads" aria-label="Tables this account can read">
            {Object.entries(a.reads).map(([t, ok]) => <li key={t} className={`read ${ok ? 'ok' : 'no'}`} title={t}><span aria-hidden>{ok ? '✓' : '✕'}</span> {READ_LABEL[t] ?? t}<span className="sr-only">{ok ? ': can read' : ': cannot read'}</span></li>)}
          </ul>
          {!!a.denied.length && <p className="muted small">Refused before (Pip won't retry): {a.denied.join(' · ')}</p>}
          {a.roles && <details><summary className="muted small">Roles</summary><p className="small break">{a.roles.join(', ')}</p></details>}
        </>
      )}
      <div className="row-actions wrap">
        <button disabled={busy} onClick={recheck}>{busy ? 'Checking…' : 'Check again'}</button>
        {inst.auth === 'oauth_user' && <button onClick={signIn}>Sign in again</button>}
      </div>
    </div>
  );
}

// ── Pip ──────────────────────────────────────────────────────────────────────

// Spending limit per day: estimated costs from the Agent SDK, warned at 80%, answers wait at 100% until the next day.
function BudgetCard({ settings, save }: { settings: Settings; save: (p: Partial<Settings>) => void }) {
  const [usage, setUsage] = useState<{ today: number; choices: number[] } | null>(null);
  useEffect(() => { api<{ today: number; choices: number[] }>('/usage').then(setUsage).catch(() => setUsage(null)); }, [settings.dailyBudgetUsd]);
  const limit = settings.dailyBudgetUsd ?? 0;
  const today = usage ? money(usage.today) : '…';
  return (
    <Card title="Spending limit" state={limit ? `$${limit} a day · ${today} today` : `Off · ${today} today`}>
      <p className="muted small budget-today">Each answer shows its estimated cost underneath. With a limit, Pip warns at 80%, and new answers wait once the day's limit is used up.</p>
      <Field label="Limit per day" hint="Estimates from the Claude Agent SDK, not a bill.">
        {(id, d) => (
          <select id={id} aria-describedby={d} value={limit} onChange={(e) => save({ dailyBudgetUsd: Number(e.target.value) })}>
            {(usage?.choices ?? [...new Set([0, limit])]).map((n) => <option key={n} value={n}>{n ? `$${n}` : 'No limit'}</option>)}
          </select>
        )}
      </Field>
    </Card>
  );
}

function PipSection({ settings, save, say }: { settings: Settings; save: (p: Partial<Settings>) => void; say: Say }) {
  const presence = settings.presence ?? 'alive';
  return (
    <>
      <p className="muted small">Pip's clock: {settings.timeZone || 'not set yet'}{settings.timeZone ? ', from this browser' : ' (set by your first message)'}. Times in answers, routine schedules and update set notes follow it.</p>
      <Card title="Look" state={{ alive: 'Alive: Pip watches, blinks and reacts.', still: 'Still: Pip stays put.', off: 'Off: no character; answers come from Wayfinder in a neutral tone.' }[presence]}>
        <div className="look-row">
          <div className="seg-row" role="group" aria-label="Pip's presence">
            {(['alive', 'still', 'off'] as const).map((p) => (
              <button key={p} className={presence === p ? 'on' : ''} aria-pressed={presence === p} onClick={() => { setPresence(p); save({ presence: p }); }}>
                {p === 'alive' ? 'Alive' : p === 'still' ? 'Still' : 'Off'}
              </button>
            ))}
          </div>
          <Pip size={40} track />
        </div>
      </Card>
      <Card title="Model" state={settings.model === 'sonnet' ? 'Sonnet: faster answers.' : 'Opus: the best answers.'}>
        <Field label="Model">
          {(id) => (
            <select id={id} value={settings.model} onChange={(e) => save({ model: e.target.value })}>
              <option value="opus">Opus (best answers)</option>
              <option value="sonnet">Sonnet (faster)</option>
            </select>
          )}
        </Field>
        <Field label="Small jobs" hint="Chat titles, a fresh chat's summary and naming-convention drafts. Haiku is quickest and cheapest.">
          {(id, d) => (
            <select id={id} aria-describedby={d} value={settings.smallModel ?? 'haiku'} onChange={(e) => save({ smallModel: e.target.value as 'haiku' | 'sonnet' })}>
              <option value="haiku">Haiku (cheapest)</option>
              <option value="sonnet">Sonnet</option>
            </select>
          )}
        </Field>
      </Card>
      <Card title="ServiceNow docs"><DocsDownload /></Card>
      <BudgetCard settings={settings} save={save} />
      <ConventionsCard say={say} />
      <LessonsCard say={say} />
      <SkillsCard say={say} />
      <PlacementRulesCard say={say} />
    </>
  );
}

// Rules Pip learned from its own failed calls (each from a failure followed by a call that worked); Remove drops one.
interface ToolLessonRow { id: string; tool: string; message: string; rule: string | null; seen: number; updated_at: number }
interface ConventionRule { id: string; area: string; rule: string; example: string; support?: string }
interface ConventionsInfo { instance: boolean; status: 'off' | 'proposed' | 'on'; proposed: ConventionRule[]; rules: ConventionRule[]; scanned_at: number | null }

// A filter box for lists that grow long.
const FILTER_FROM = 8;
function useFilter<T>(items: T[], text: (t: T) => string) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => text(i).toLowerCase().includes(needle)) : items;
  const box = (label: string) => items.length > FILTER_FROM
    ? <input className="list-filter" type="search" aria-label={label} placeholder={label} value={q} onChange={(e) => setQ(e.target.value)} /> : null;
  return { shown, box, filtering: !!needle };
}

// Your conventions (opt-in): Pip reads the instance's existing customizations (read-only), proposes naming rules,
// and follows only the ones you tick. Rules are shown as plain text.
function ConventionsCard({ say }: { say: Say }) {
  const [c, setC] = useState<ConventionsInfo | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<ConventionsInfo>('/conventions').then((d) => {
    setC(d);
    setPicked(new Set([...(d.proposed.length ? d.proposed : d.rules)].map((r) => r.id)));
  }).catch(() => {});
  useEffect(() => { load(); }, []);
  useLive('conventions', load);
  const reviewing = !!c && c.proposed.length > 0;
  const rules = c ? (reviewing ? c.proposed : c.rules) : [];
  const f = useFilter(rules, (r) => `${r.rule} ${r.area} ${r.example}`);
  if (!c) return null;
  const scan = async () => {
    setBusy('scan'); setNote('');
    try {
      const r = await api<{ proposed: ConventionRule[]; read: number; skipped: string[] }>('/conventions/scan', { method: 'POST' });
      setNote(r.read ? `Read ${r.read} names${r.skipped.length ? `; couldn't read ${r.skipped.join(', ')}` : ''}.` : 'Found no customizations to learn from yet.');
      await load();
    } catch (e) { setNote((e as Error).message); } finally { setBusy(''); }
  };
  const save = async () => { setBusy('save'); try { await api('/conventions/save', { method: 'POST', body: { ids: [...picked] } }); say('Saved'); } catch (e) { say((e as Error).message, true); } setBusy(''); setNote(''); load(); };
  const off = async () => { setBusy('off'); try { await api('/conventions/off', { method: 'POST' }); say('Conventions turned off'); } catch (e) { say((e as Error).message, true); } setBusy(''); setNote(''); load(); };
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const state = !c.instance ? 'Connect an instance first.'
    : reviewing ? `${c.proposed.length} proposed rule${c.proposed.length === 1 ? '' : 's'}: tick the ones Pip should follow, then save.`
    : c.status === 'on' ? <><span className="ok-text">On</span> · Pip follows {c.rules.length} rule{c.rules.length === 1 ? '' : 's'} from this instance.</>
    : 'Off. Pip can learn how your team names things from what is already on your instance.';
  return (
    <Card title="Your conventions" state={state} className="conventions">
      <details className="howto"><summary>How this works</summary>
        <p className="muted small">Pip reads the names of existing update sets, scopes, scripts, tables, fields and properties, and proposes rules. It only reads; nothing on the instance changes. You choose which rules Pip follows.</p>
      </details>
      {f.box('Filter rules')}
      {f.shown.map((r) => (
        <label key={r.id} className="lesson convention">
          <span className="convention-row">
            {reviewing && <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={r.rule} />}
            <span>{r.rule}</span>
          </span>
          <span className="muted tiny">{r.area} · e.g. <code>{r.example}</code>{r.support ? ` · ${r.support}` : ''}</span>
        </label>
      ))}
      {reviewing && !rules.length && <p className="muted small">No clear conventions yet.</p>}
      {f.filtering && !f.shown.length && <p className="muted small">No rule matches that.</p>}
      {note && <p className="muted small">{note}</p>}
      {c.instance && (
        <div className="row-actions wrap split">
          <span className="row-actions wrap">
            {reviewing && <button className="primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : picked.size ? `Follow ${picked.size} rule${picked.size === 1 ? '' : 's'}` : 'Follow none'}</button>}
            <button className={reviewing || c.status === 'on' ? '' : 'primary'} disabled={!!busy} onClick={scan}>{busy === 'scan' ? 'Reading your instance…' : c.status === 'on' || reviewing ? 'Learn again' : 'Learn from my instance'}</button>
          </span>
          {(c.status === 'on' || reviewing) && <ConfirmButton label="Turn off" question="Turn conventions off? Pip discards these rules." confirmLabel="Turn off" disabled={!!busy} onConfirm={off} />}
        </div>
      )}
    </Card>
  );
}

function LessonsCard({ say: _say }: { say: Say }) {
  const [d, setD] = useState<{ learned: ToolLessonRow[]; misses: ToolLessonRow[]; fixed: number } | null>(null);
  const load = () => api<typeof d>('/lessons').then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  useLive('lessons', load);
  const tool = (t: string) => t.replace(/^mcp__/, '').replace('__', ' · ');
  if (!d) return null;
  return (
    <Card title="What Pip learned" state={d.learned.length ? `${d.learned.length} rule${d.learned.length === 1 ? '' : 's'} from its own failed calls, in use.` : 'Nothing yet.'}>
      <p className="muted small">When a tool call fails and a changed call works, Pip writes the rule down and follows it from then on. Every rule Pip follows, these included, is read, paused or removed on the Memory page.</p>
      <div className="row-actions wrap"><button onClick={() => window.dispatchEvent(new CustomEvent(OPEN_MEMORY))}>Open Memory</button></div>
      {!!d.misses.length && (
        <details><summary className="small">{d.misses.length} failure{d.misses.length > 1 ? 's' : ''} with no fix yet</summary>
          <ul className="small">{d.misses.map((l) => <li key={l.id} className="break"><code>{tool(l.tool)}</code> {l.message.slice(0, 160)}{l.seen > 1 ? ` (${l.seen}×)` : ''}</li>)}</ul>
        </details>
      )}
    </Card>
  );
}

// ── Safety ───────────────────────────────────────────────────────────────────

const LOG_RECENT = 10;

function FullPermissions({ inst, say, onChanged }: { inst: Instance; say: Say; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = useRef<HTMLInputElement>(null);
  const on = inst.kind === 'pdi' && inst.full_permissions === 1;
  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api(`/instances/${inst.id}`, { method: 'PUT', body: { full_permissions: enabled } });
      setAsking(false); onChanged(); say(enabled ? 'Full permissions on' : 'Full permissions off');
      toggle.current?.focus();
    } catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };
  const cancel = () => { setAsking(false); toggle.current?.focus(); };
  return <div className="full-permissions-setting">
    <label className="toggle">
      <input ref={toggle} type="checkbox" checked={on} disabled={busy || inst.kind !== 'pdi'} onChange={(e) => e.target.checked ? setAsking(true) : void save(false)} />
      <span>Full permissions — Pip doesn't ask before changing this instance</span>
    </label>
    {inst.kind !== 'pdi' && <p className="hint">Personal developer instances only.</p>}
    {asking && <div className="confirm-pop" role="dialog" aria-label="Turn on Full permissions?" onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}>
      <p>Changes, scripts and installs run without asking. Each still shows in the chat and the approval log. Personal developer instances only.</p>
      <div className="row-actions">
        <button autoFocus disabled={busy} onClick={cancel}>Cancel</button>
        <button className="danger" disabled={busy} onClick={() => save(true)}>Turn on Full permissions</button>
      </div>
    </div>}
  </div>;
}

function SafetySection({ settings, save, say, audit, active, onChanged }: { settings: Settings; save: (p: Partial<Settings>) => void; say: Say; audit: any[]; active?: Instance; onChanged: () => void }) {
  const [newDomain, setNewDomain] = useState('');
  const [newToken, setNewToken] = useState('');
  const [all, setAll] = useState(false);
  const domains = useFilter(settings.allowlist, (d) => d);
  const log = useFilter(audit, (a) => `${a.tool} ${a.decision}`);
  const logShown = all || log.filtering ? log.shown : log.shown.slice(0, LOG_RECENT);
  const full = active?.kind === 'pdi' && active.full_permissions === 1;
  const writeState = !settings.writeEnabled ? 'Read-only: Pip can look, but not change anything.'
    : full ? 'Full permissions: allowed changes run without asking. Each is logged.' : settings.scriptingEnabled ? 'Pip may propose changes and server-side scripts. Each one asks you first.' : 'Pip may propose changes. Each one asks you first. Scripts are off.';
  return (
    <>
      <Card title="Changes to your instance" state={writeState}>
        <label className="toggle">
          <input type="checkbox" checked={settings.writeEnabled} onChange={(e) => save({ writeEnabled: e.target.checked, scriptingEnabled: e.target.checked && settings.scriptingEnabled })} />
          <span>Allow changes to the instance <span className="hint">{full ? 'Changes are auto-approved and logged.' : 'Each change still asks you first.'}</span></span>
        </label>
        <label className="toggle">
          <input type="checkbox" disabled={!settings.writeEnabled} checked={settings.scriptingEnabled} onChange={(e) => save({ scriptingEnabled: e.target.checked })} />
          <span>Allow server-side scripts <span className="hint">Background scripts, script includes, business rules.</span></span>
        </label>
        {active && <FullPermissions key={active.id} inst={active} say={say} onChanged={onChanged} />}
        <p className="muted small">Full permissions keeps these switches in force. Otherwise, plugin installs ask for approval and Auto mode is set per chat on the approval dial.</p>
      </Card>

      <Card title="Web allowlist" state={settings.allowlist.length ? `Web fetch and search reach ${settings.allowlist.length} domain${settings.allowlist.length === 1 ? '' : 's'} and their subdomains.` : 'Empty: web fetch and search are off.'}>
        {!settings.allowlist.length && <p className="muted small">Add a domain below to let Pip read pages there.</p>}
        {domains.box('Filter domains')}
        <ul className="chips" aria-label="Allowed domains">
          {domains.shown.map((d) => (
            <li key={d} className="chip">{d}<button aria-label={`Remove ${d}`} onClick={() => save({ allowlist: settings.allowlist.filter((x) => x !== d) })}>×</button></li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (newDomain.trim()) { save({ allowlist: [...settings.allowlist, newDomain] }); setNewDomain(''); } }}>
          <input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="docs.example.com" aria-label="Domain to allow" autoComplete="off" spellCheck={false} />
          <button className="primary" type="submit" disabled={!newDomain.trim()}>Add</button>
        </form>
      </Card>

      <Card title="App token" state="The app token is your login. This browser is signed in.">
        {newToken && <p className="small result break">New token (shown once): <code>{newToken}</code> <button className="link" onClick={() => { navigator.clipboard.writeText(newToken); say('Copied'); }}>Copy</button></p>}
        <details className="howto"><summary>How Wayfinder keeps you safe</summary>
          <ul className="muted small">
            <li>Web fetches only reach allowlisted domains, and never private or tailnet addresses.</li>
            <li>Generated apps build in a sandbox that can't see your keys or the network.</li>
            <li>Instance secrets live in a mode-600 file on this host, out of reach of builds.</li>
          </ul>
        </details>
        <div className="row-actions">
          <ConfirmButton label="Rotate app token" question="Rotate the app token? Every other browser is signed out and signs in again with the new token." confirmLabel="Rotate"
            onConfirm={async () => { try { const r = await api<{ token: string }>('/token/rotate', { method: 'POST' }); setNewToken(r.token); say('Token rotated. Copy the new one now.'); } catch (e) { say((e as Error).message, true); } }} />
        </div>
      </Card>

      <Card title="Approval log" state={audit.length ? `${audit.length} decision${audit.length === 1 ? '' : 's'} recorded. Newest first.` : 'Nothing yet.'}>
        {!audit.length && <p className="muted small">Every approval, refusal and security change shows up here.</p>}
        {log.box('Filter by tool or decision')}
        {!!logShown.length && (
          <ul className="log" aria-label="Approvals">
            {logShown.map((a) => (
              <li key={a.id}>
                <span className="log-when muted">{new Date(a.at).toLocaleString()}</span>
                <span className="log-tool" title={a.input}>{a.tool.replace(/^mcp__/, '')}</span>
                <span className="log-decision">{a.decision}</span>
              </li>
            ))}
          </ul>
        )}
        {log.filtering && !log.shown.length && <p className="muted small">Nothing matches that.</p>}
        {!log.filtering && log.shown.length > LOG_RECENT && (
          <button className="link small" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? `Show the latest ${LOG_RECENT}` : `Show all ${log.shown.length}`}</button>
        )}
      </Card>
    </>
  );
}

// ── Advanced ─────────────────────────────────────────────────────────────────

interface Perf { answers: number; first_word: { p50: number | null; p90: number | null }; start: { p50: number | null; p90: number | null }; tools: { name: string; calls: number; p50: number | null; p90: number | null }[]; modes?: { mode: string; answers: number; first_p50: number | null; turns: number | null; tool_calls: number | null; error_rate: number | null; cost: number | null }[] }
const secs = (ms: number | null) => (ms === null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

interface Lesson { id: string; code: string | null; message: string; rule: string | null; example: string | null; seen: number }
interface FluentInfo { health: { sdk: string; sheet: string | null; verified: string; errors: string[]; at: number | null }; misses: number; fixed: number; proposed: Lesson[]; approved: Lesson[] }

// How Build mode's Fluent cheat sheet stays current: CI compiles it on every change and weekly on the newest SDK;
// here, the installed SDK's check and rules Pip learned from real build errors, which you approve before Pip uses them.
function FluentCard() {
  const [f, setF] = useState<FluentInfo | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => api<FluentInfo>('/fluent').then(setF).catch(() => {});
  useEffect(() => { load(); }, []);
  useLive('lessons', load);
  if (!f) return null;
  const h = f.health;
  const act = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); await fn().catch(() => {}); setBusy(''); load(); };
  return (
    <Card title="Fluent cheat sheet" state={<>
      {h.verified === 'yes' ? <span className="ok-text">Every example builds</span> : h.verified === 'no' ? <span className="error">Some examples no longer build, so Pip checks the docs instead</span> : h.verified === 'checking' ? 'Checking' : 'Up to date'} on SDK {h.sdk}{h.sheet && h.sheet !== h.sdk ? ` (last verified on ${h.sheet})` : ''}.
    </>}>
      <p className="muted small">What Pip knows about writing Fluent apps, checked against the installed ServiceNow SDK. {h.verified === 'no' && h.errors[0] ? <span className="error">{h.errors[0]}</span> : ''}</p>
      <p className="muted small">
        {f.proposed.length ? `${f.proposed.length} rule${f.proposed.length === 1 ? '' : 's'} drafted from real build errors wait${f.proposed.length === 1 ? 's' : ''} for your review on the Memory page. ` : ''}
        {f.approved.length ? `${f.approved.length} learned rule${f.approved.length === 1 ? '' : 's'} in use. ` : ''}
        {f.misses ? `${f.misses} build error${f.misses === 1 ? '' : 's'} the sheet didn't predict, no fix yet. ` : ''}
        {f.fixed ? `${f.fixed} fixed and ready to be drafted into rules.` : ''}
      </p>
      <div className="row-actions wrap">
        <button disabled={!!busy} onClick={() => act('verify', () => api('/fluent/verify', { method: 'POST' }))}>{busy === 'verify' ? 'Building…' : 'Check now'}</button>
        {f.fixed > 0 && <button disabled={!!busy} onClick={() => act('review', () => api('/fluent/review', { method: 'POST' }))}>{busy === 'review' ? 'Reviewing…' : 'Draft rules now'}</button>}
        {(f.proposed.length > 0 || f.approved.length > 0) && <button onClick={() => window.dispatchEvent(new CustomEvent(OPEN_MEMORY))}>Open Memory</button>}
      </div>
    </Card>
  );
}

// How fast answers are, measured on every answer: time to the first word, and the slowest tools.
function SpeedCard() {
  const [p, setP] = useState<Perf | null>(null);
  useEffect(() => { api<Perf>('/perf').then(setP).catch(() => {}); }, []);
  if (!p) return null;
  const modes = (p.modes ?? []).filter((m) => !m.mode.startsWith('job:') && m.answers > 0);
  return (
    <Card title="Speed" state={!p.answers ? 'Numbers appear after a few answers.' : <>Pip's first sign of life comes after <b>{secs(p.first_word.p50)}</b> typically, {secs(p.first_word.p90)} on slow answers, over the last {p.answers}.</>}>
      {!!p.answers && <p className="muted small">The agent itself starts in {secs(p.start.p50)}.{modes.length ? ` By mode: ${modes.map((m) => `${m.mode} ${secs(m.first_p50)}${m.cost !== null ? ` and $${m.cost.toFixed(2)} an answer` : ''}`).join(' · ')}.` : ''}</p>}
      {!!p.answers && <details className="file-fold"><summary className="small muted">Details</summary>
        {!!modes.length && (
          <div className="table-scroll">
            <table className="audit">
              <thead><tr><th>Mode</th><th>Answers</th><th>First sign</th><th>Turns</th><th>Steps</th><th>Failed steps</th><th>Cost</th></tr></thead>
              <tbody>{modes.map((m) => <tr key={m.mode}><td>{m.mode}</td><td>{m.answers}</td><td>{secs(m.first_p50)}</td><td>{m.turns ?? '–'}</td><td>{m.tool_calls ?? '–'}</td><td>{m.error_rate === null ? '–' : `${m.error_rate}%`}</td><td>{m.cost === null ? '–' : `$${m.cost.toFixed(2)}`}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {!!p.tools.length && (
          <div className="table-scroll">
            <table className="audit">
              <thead><tr><th>Slowest tools</th><th>Calls</th><th>Typical</th><th>Slow</th></tr></thead>
              <tbody>{p.tools.map((t) => <tr key={t.name}><td>{t.name.replace(/^mcp__/, '').replace('__', ' · ')}</td><td>{t.calls}</td><td>{secs(t.p50)}</td><td>{secs(t.p90)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </details>}
    </Card>
  );
}

function ScriptRunnerSettings({ inst, settings, say, onChanged }: { inst: Instance; settings: Settings; say: Say; onChanged: () => void }) {
  const [preview, setPreview] = useState<{ plan_id: string; card: ScriptRunnerCard } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (action: 'setup' | 'remove', confirm = false) => {
    setBusy(true);
    try {
      const result = await api<{ plan_id: string; card: ScriptRunnerCard }>(`/instances/${inst.id}/script-runner`, { body: { action, ...(confirm ? { confirm: true, plan_id: preview?.plan_id } : {}) } });
      if (confirm) { setPreview(null); say(action === 'setup' ? 'Script runner ready' : 'Script runner removed'); onChanged(); }
      else setPreview(result);
    } catch (e) { setPreview(null); say((e as Error).message, true); onChanged(); }
    finally { setBusy(false); }
  };
  return <div className="script-runner-settings">
    <p className="small">Script runner: {inst.script_runner_path ? 'ready' : inst.script_runner_records ? 'setup incomplete; remove it before trying again' : 'not set up'}. Scripts also need “Allow server-side scripts” in Safety.</p>
    <div className="row-actions wrap">
      <button disabled={busy || !settings.writeEnabled} onClick={() => act('setup')}>Set up script runner</button>
      {inst.script_runner_records && <button disabled={busy || !settings.writeEnabled} onClick={() => act('remove')}>Remove script runner</button>}
    </div>
    {preview && <div className="approval pending">
      <div className="approval-head">{preview.card.action === 'setup' ? 'Set up script runner?' : 'Remove script runner?'}</div>
      <ScriptRunnerSummary card={preview.card} />
      <div className="approval-actions">
        <button className="primary" disabled={busy} onClick={() => act(preview.card.action, true)}>{busy ? 'Working…' : 'Approve'}</button>
        <button disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
      </div>
    </div>}
  </div>;
}
