import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type Block, type Memory, type ShowSnapshot, type Spec } from '../api.ts';
import { SpecCard } from './AppCards.tsx';
import { ShowCard } from './ShowCard.tsx';
import { MdImage, RICH, RichBlock } from './RichBlocks.tsx';
import { parseScreen, renderScreen } from '../screen.ts';
import { useLive } from '../live.ts';
import { ScriptBlock } from './ScriptBlock.tsx';

// What the blocks of one message can do: save into the chat's project, and answer in the chat (last message only).
export const BlockCtx = createContext<{ chatId?: string; onReply?: (text: string, send: boolean) => void }>({});
// Which chat an approval card belongs to; set on the live answer too (BlockCtx's chatId turns on Save buttons there).
export const ApprovalChat = createContext<string | undefined>(undefined);

export async function saveItem(chatId: string | undefined, kind: 'mockup' | 'script' | 'decision' | 'note', title: string, content: string) {
  await api('/saved', { body: { chat_id: chatId, kind, title, content } });
}

const titleFor = (lang: string | undefined, body: string) =>
  /<title>([^<]{2,100})<\/title>/i.exec(body)?.[1]?.trim()
  ?? body.split('\n').map((l) => l.replace(/^[\s/*#<!-]+/, '').trim()).find((l) => l.length > 3)?.slice(0, 80)
  ?? `${lang ?? 'code'} snippet`;

// Plain words for each step, so the chat reads like someone working, not a log.
const STEP: Record<string, (i: any) => string> = {
  mcp__sndocs__search_docs: (i) => `Searching the docs · ${i?.query ?? ''}`,
  mcp__sndocs__ask: (i) => `Asking the docs · ${i?.question ?? i?.query ?? ''}`,
  mcp__sndocs__get_doc: () => 'Reading a docs page',
  mcp__build__fluent_docs: (i) => (i?.list ? 'Looking up SDK topics' : `Reading SDK docs · ${i?.topic ?? ''}`),
  mcp__build__propose_app: (i) => `Planning · ${i?.spec?.name ?? 'app'}`,
  mcp__build__write_app_file: (i) => `Writing · ${i?.path ?? ''}`,
  mcp__build__read_app_file: (i) => `Reading · ${i?.path ?? ''}`,
  mcp__build__delete_app_file: (i) => `Deleting · ${i?.path ?? ''}`,
  mcp__build__build_app: () => 'Building the app',
  mcp__build__install_app: () => 'Installing on the PDI',
  mcp__build__run_app_tests: () => 'Running the tests on the PDI',
  mcp__build__remove_app: () => 'Removing the app from the PDI',
  mcp__build__list_apps: () => 'Checking the apps',
  mcp__build__list_app_files: () => 'Listing the app files',
  mcp__project__list_saved: () => 'Checking what we saved',
  mcp__project__read_saved: () => 'Reading a saved item',
  mcp__project__read_memory: () => 'Reading a memory',
  mcp__project__save: (i) => `Saving · ${i?.title ?? ''}`,
  mcp__project__propose_memory: () => 'Suggesting a memory',
  mcp__project__board_list: () => 'Reading the board',
  mcp__project__board_pin: (i) => `Pinned · ${i?.title ?? ''}`,
  mcp__project__board_update: (i) => `Board · marked ${String(i?.status ?? 'updated').replace('_', ' ')}`,
  mcp__pdi__check_features: (i) => `Checking out-of-the-box features · ${i?.need ?? ''}`,
  mcp__pdi__show: (i) => `Showing · ${i?.table ?? ''}`,
  mcp__pdi__open_page: (i) => `Opening · ${i?.label ?? i?.page ?? ''}`,
  mcp__pdi__placement: (i) => `Checking where this should live · ${i?.work ?? ''}`,
  mcp__build__checkpoint: (i) => `Checkpoint · ${i?.label ?? ''}`,
  mcp__build__list_checkpoints: () => 'Checking the app history',
  mcp__build__restore_checkpoint: (i) => `Restoring · ${i?.checkpoint ?? ''}`,
  mcp__pdi__pdi_status: () => 'Checking the PDI',
  mcp__pdi__list_plugins: (i) => `Looking up plugins · ${i?.search ?? ''}`,
  mcp__pdi__activate_plugin: (i) => `Activating · ${i?.plugin_id ?? ''}`,
  mcp__pdi__find_store_app: (i) => `Finding Store apps · ${i?.search ?? ''}`,
  mcp__pdi__install_store_app: () => 'Installing a Store app',
  mcp__pdi__install_status: () => 'Checking installs',
};

export const prettyTool = (name: string, input: any) => {
  if (STEP[name]) return STEP[name](input);
  // Saved chats may still use the old server and wrapper names.
  if (name === 'mcp__nowaikit__run_tool' && input?.name) return `instance · ${input.name}`;
  const short = name.replace(/^mcp__nowaikit__/, 'mcp__instance__').replace(/^mcp__/, '').replace(/__/g, ' · ');
  if (name === 'Agent' || name === 'Task') return `Agent · ${input?.subagent_type ?? input?.description ?? 'helper'}`;
  if (name === 'WebFetch') return `Web · ${input?.url ?? ''}`;
  if (name === 'WebSearch') return `Web search · ${input?.query ?? ''}`;
  return short;
};

// The markdown renderer's components are defined once (not per render), and read onPreview/live from context:
// react-markdown treats new component functions as new components, which tore down and redrew every card on each
// streamed word (the "cards re-rendering" bug).
const MdCtx = createContext<{ onPreview: (html: string) => void; live?: boolean }>({ onPreview: () => {} });
function MdCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const { onPreview, live } = useContext(MdCtx);
  const lang = /language-(\w+)/.exec(className ?? '')?.[1];
  const body = String(children).replace(/\n$/, '');
  if (!lang && !body.includes('\n')) return <code>{children}</code>;
  // Structured blocks (live HTML, cards, stats, steps, callouts, columns, questions) render as content, not code.
  if (lang && RICH.has(lang)) return <RichBlock lang={lang} body={body} live={live} onPreview={onPreview} actions={lang === 'html' ? <SaveMockup body={body} /> : lang === 'screen' && !live ? <SaveScreen body={body} /> : undefined} />;
  if (!lang && /^\s*<!doctype html/i.test(body)) return <RichBlock lang="html" body={body} live={live} onPreview={onPreview} actions={<SaveMockup body={body} />} />;
  return <CodeBlock lang={lang} body={body} onPreview={onPreview} />;
}
const MD_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  code: MdCode as any,
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  img: MdImage as any,
};
const REMARK = [remarkGfm];

// Memoized: a text block whose text hasn't changed isn't parsed again when the message around it re-renders.
const Markdown = memo(function Markdown({ text, onPreview, live }: { text: string; onPreview: (html: string) => void; live?: boolean }) {
  const ctx = useMemo(() => ({ onPreview, live }), [onPreview, live]);
  return (
    <MdCtx.Provider value={ctx}>
      <div className="md"><ReactMarkdown remarkPlugins={REMARK} components={MD_COMPONENTS}>{text}</ReactMarkdown></div>
    </MdCtx.Provider>
  );
});

function SaveMockup({ body }: { body: string }) {
  const [saved, setSaved] = useState(false);
  const { chatId } = useContext(BlockCtx);
  if (!chatId) return null;
  return <button className="link" disabled={saved} onClick={async () => { await saveItem(chatId, 'mockup', titleFor('html', body), body); setSaved(true); }}>{saved ? 'Saved' : 'Save'}</button>;
}

// A screen is saved as the drawn page (so saved mockups, Compare and Download work as before), with its spec inside.
function SaveScreen({ body }: { body: string }) {
  const parsed = parseScreen(body);
  return 'spec' in parsed ? <SaveMockup body={renderScreen(parsed.spec)} /> : null;
}

function CodeBlock({ lang, body, onPreview }: { lang?: string; body: string; onPreview: (html: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const { chatId } = useContext(BlockCtx);
  const isHtml = lang === 'html' || /^\s*<!doctype html/i.test(body);
  const save = async () => { await saveItem(chatId, isHtml ? 'mockup' : 'script', titleFor(lang, body), body); setSaved(true); };
  return (
    <div className="code">
      <div className="code-head">
        <span>{lang ?? 'code'}</span>
        <span className="code-actions">
          {isHtml && <button className="link" onClick={() => onPreview(body)}>Preview</button>}
          {chatId && <button className="link" onClick={save} disabled={saved}>{saved ? 'Saved' : 'Save'}</button>}
          <button className="link" onClick={() => { navigator.clipboard.writeText(body); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? 'Copied' : 'Copy'}</button>
        </span>
      </div>
      <pre><code>{body}</code></pre>
    </div>
  );
}

function ToolCard({ block, children }: { block: Extract<Block, { type: 'tool' }>; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool ${block.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-icon ${block.status}`} />
        <span className="tool-name">{prettyTool(block.name, block.input)}</span>
        <span className="tool-state">{block.status === 'running' ? 'running…' : block.status === 'denied' ? 'blocked' : block.status === 'error' ? 'error' : block.ms !== undefined ? (block.ms < 1000 ? `${block.ms} ms` : `${(block.ms / 1000).toFixed(1)} s`) : ''}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {children}
      {open && (
        <div className="tool-body">
          <div className="label">Input</div>
          <pre>{JSON.stringify(block.input, null, 2)}</pre>
          {block.result !== undefined && (<><div className="label">Result</div><pre>{block.result}</pre></>)}
        </div>
      )}
    </div>
  );
}

const ASK: Record<string, string> = {
  mcp__instance__run_script: 'Run this script on the instance (like Scripts - Background)',
  mcp__instance__setup_script_runner: 'Set up script runner?',
  mcp__instance__remove_script_runner: 'Remove script runner?',
  mcp__build__install_app: 'Install this app on the PDI?',
  mcp__build__run_app_tests: "Run this app's tests on the PDI?",
  mcp__build__remove_app: 'Remove this app from the PDI?',
  mcp__pdi__use_update_set: 'Switch to this update set?',
  mcp__build__enable_atf: 'Turn on automated test runs (ATF) on the instance?',
};

// Build approvals read as a sentence and a few facts, not JSON.
function AppSummary({ input }: { input: { app: string; scope: string; summary?: string; tables?: string[]; build?: string; changes?: string; risks?: string[] } }) {
  return (
    <div className="approval-app">
      <div><strong>{input.app}</strong> <code>{input.scope}</code>{input.build && <span className="ver"> · build {input.build}</span>}</div>
      {input.summary && <p className="muted small">{input.summary}</p>}
      {input.changes && <p className="small">{input.changes}</p>}
      {!!input.risks?.length && <div className="risks"><div className="label">Worth a look before approving</div><ul>{input.risks.map((r) => <li key={r}>{r}</li>)}</ul></div>}
      {!!input.tables?.length && <div className="small">Tables: {input.tables.map((t) => <code key={t}>{t}</code>)}</div>}
    </div>
  );
}

function ApprovalCard({ block }: { block: Extract<Block, { type: 'approval' }> }) {
  if (block.auto) return (
    <div className="approval auto">
      <span className="auto-chip">{block.full_permissions ? '✓ Auto-approved (full permissions)' : 'auto-approved'}</span>
      <span className="tool-name">{prettyTool(block.tool, block.input)}</span>
      {(block.input as any)?.app && <span className="muted small">{(block.input as any).app}{(block.input as any).build ? ` · build ${(block.input as any).build}` : ''}{(block.input as any).why ? ` · ${(block.input as any).why}` : ''}</span>}
    </div>
  );
  return <AskApproval block={block} />;
}

type RecordChange = { kind: 'record'; action: string; tool: string; table: string; sys_id?: string; record?: string; lands_in?: { update_set: string; application: string }; changes?: Record<string, unknown> | null; also?: Record<string, unknown>; unused?: Record<string, unknown> };
const Rows = ({ of }: { of: Record<string, unknown> }) => (
  <table className="changes"><tbody>{Object.entries(of).map(([k, v]) => <tr key={k}><td>{k}</td><td>{typeof v === 'string' ? /script|condition|template|filter/i.test(k) || (v.includes('\n') && v.length > 80) ? <ScriptBlock script={v} /> : v : JSON.stringify(v)}</td></tr>)}</tbody></table>
);
const ACTION: Record<string, string> = { update: 'Update', create: 'Create', delete: 'Delete', script: 'Run a script on' };

// One record change, readable: what, where, which record, and every field value and option sent (none hidden).
function RecordSummary({ c }: { c: RecordChange }) {
  return (
    <div className="approval-record">
      <div><strong>{ACTION[c.action] ?? 'Change'} {c.action === 'create' ? 'a record in' : ''} <code>{c.table}</code></strong>{c.record && <span> · {c.record}</span>}</div>
      {c.sys_id && <div className="ver">sys_id {c.sys_id}</div>}
      {c.lands_in && <div className="ver">Lands in update set <strong>{c.lands_in.update_set}</strong> · app <strong>{c.lands_in.application}</strong></div>}
      {c.changes && Object.keys(c.changes).length > 0 && <Rows of={c.changes} />}
      {c.also && <><div className="label">Also sent</div><Rows of={c.also} /></>}
      {c.unused && <><div className="label">Sent but not used</div><Rows of={c.unused} /></>}
    </div>
  );
}

export function ScriptRunnerSummary({ card }: { card: import('../api.ts').ScriptRunnerCard }) {
  return <div className="approval-record">
    <p>{card.why}</p>
    <div className="small break">{card.instance} · {card.scope}</div>
    <ul>{card.records.map((r) => <li key={r.table}><code>{r.table}</code> · {r.name ?? r.sys_id}{r.script && <ScriptBlock script={r.script} />}</li>)}</ul>
    {card.script && <ScriptBlock script={card.script} />}
  </div>;
}

function ApprovalInput({ input }: { input: any }) {
  if (typeof input?.script !== 'string' && typeof input?.arguments?.script !== 'string') return <pre>{JSON.stringify(input, null, 2)}</pre>;
  const { script, ...rest } = input;
  const { script: nestedScript, ...args } = input.arguments ?? {};
  if (typeof nestedScript === 'string') rest.arguments = args;
  if (script !== undefined && typeof script !== 'string') rest.script = script;
  return <>
    {typeof script === 'string' && <ScriptBlock script={script} />}
    {typeof nestedScript === 'string' && <ScriptBlock script={nestedScript} />}
    <pre>{JSON.stringify(rest, null, 2)}</pre>
  </>;
}

function AskApproval({ block }: { block: Extract<Block, { type: 'approval' }> }) {
  const chatId = useContext(ApprovalChat);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const answer = async (allow: boolean) => {
    setSending(true);
    try { await api(`/chats/${chatId}/approvals/${block.id}`, { body: { allow } }); } catch (e) { setError((e as Error).message); setSending(false); }
  };
  const input = block.input as any;
  const body = input?.kind === 'tool-server' ? <div><strong>{input.server} · {input.tool}</strong><ApprovalInput input={input.arguments} /></div>
    : input?.kind === 'script-runner' ? <ScriptRunnerSummary card={input} />
    : block.tool === 'mcp__instance__run_script' ? <div className="approval-record"><p>{input.why}</p><ScriptBlock script={input.script} /></div>
    : input?.kind === 'record' ? <RecordSummary c={input} />
    : input?.kind === 'property' ? <div className="approval-record"><strong>Set <code>{input.property}</code></strong> <span className="muted">from {input.from} to {input.to}</span>{input.why && <div className="muted small">{input.why}</div>}</div>
    : input?.kind === 'update-set-note' ? <div className="approval-record"><strong>Add a note to <code>{input.update_set}</code></strong><div className="muted small">Appended to the update set's description; nothing there is replaced.</div><pre className="note-text">{input.note}</pre></div>
    : block.tool === 'mcp__pdi__use_update_set' ? <div className="approval-record"><strong>{input.name}</strong> <span className="muted">in {input.scope ?? 'global'}</span><div className="muted small">Uses it if it already exists, otherwise creates it, and makes it current for Wayfinder's account.</div></div>
    : input?.app ? <AppSummary input={input} /> : <ApprovalInput input={input} />;
  const label = input?.kind === 'tool-server' ? `${input.server} · ${input.tool}` : input?.kind === 'update-set-note' ? `Note in update set · ${input.update_set}` : input?.kind === 'property' ? `Set ${input.property} to ${input.to}` : block.tool === 'mcp__pdi__use_update_set' ? `Update set · ${input.name} (${input.scope ?? 'global'})` : input?.kind === 'record' ? `${ACTION[input.action] ?? 'Change'} ${input.table}${input.record ? ` · ${input.record}` : ''}` : input?.app ? `${prettyTool(block.tool, input)} · ${input.app}` : prettyTool(block.tool, input);
  // Once decided, the card folds to one line; click to see what was approved or denied.
  if (block.decision) return (
    <div className={`approval done ${block.decision}`}>
      <button className="approval-line" onClick={() => setOpen(!open)}>
        <span className={`decision ${block.decision}`}>{block.decision === 'allow' ? '✓ Approved' : '✕ Denied'}</span>
        <span className="tool-name">{label}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="approval-body">{body}</div>}
    </div>
  );
  return (
    <div className="approval pending">
      <div className="approval-head">{ASK[block.tool] ?? (input?.kind === 'tool-server' ? 'Approve this tool server call?' : input?.kind === 'record' ? 'Approve this change?' : 'Approve this change to the instance?')}</div>
      {body}
      <div className="approval-actions">
        <button className="primary" disabled={sending} onClick={() => answer(true)}>Approve</button>
        <button disabled={sending} onClick={() => answer(false)}>Deny</button>
        {error && <span className="error small">{error}</span>}
      </div>
    </div>
  );
}

// Install, test and removal results as a card: headline, numbers, items with status, links.
function NoticeCardView({ card }: { card: NonNullable<Extract<Block, { type: 'notice' }>['card']> }) {
  const [all, setAll] = useState(false);
  const items = card.items ?? [];
  return (
    <div className={`result-card ${card.ok ? 'ok' : 'bad'} kind-${card.kind}`}>
      <div className="result-head"><span className="result-dot" /><strong>{card.title}</strong></div>
      {!!card.stats?.length && <div className="rb-stats compact">{card.stats.map((x) => <div key={x.label} className={`rb-stat tone-${x.tone ?? 'plain'}`}><span className="label">{x.label}</span><b>{String(x.value)}</b></div>)}</div>}
      {!!items.length && (
        <ul className="result-items">
          {(all ? items : items.slice(0, 6)).map((it, i) => (
            <li key={i} className={`ri-${it.status}`}><span className="ri-mark">{it.status === 'pass' ? '✓' : it.status === 'skip' ? '–' : '✕'}</span>
              {it.href ? <a href={it.href} target="_blank" rel="noreferrer">{it.label}</a> : <span>{it.label}</span>}{it.detail && <span className="muted tiny"> {it.detail}</span>}</li>
          ))}
          {items.length > 6 && <li><button className="link small" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button></li>}
        </ul>
      )}
      {!!card.links?.length && <div className="result-links">{card.links.map((l) => <a key={l.href} className="pill" href={l.href} target="_blank" rel="noreferrer">{l.label} ↗</a>)}</div>}
    </div>
  );
}

// A memory suggestion leaves a one-line trace in the chat; the asking happens in the clouds above Pip.
function MemoryCard({ block }: { block: Extract<Block, { type: 'tool' }> }) {
  const id = (() => { try { return JSON.parse(block.result ?? '{}').memory_id as string; } catch { return /"memory_id":\s*"([^"]+)"/.exec(block.result ?? '')?.[1]; } })();
  const [m, setM] = useState<Memory | null>(null);
  useEffect(() => { if (id) api<Memory>(`/memories/${id}`).then(setM).catch(() => {}); }, [id]);
  const text = m?.text ?? (block.input as { text: string }).text;
  const state = m?.status === 'saved' ? 'remembered' : m?.status === 'dismissed' ? 'set aside' : 'suggested';
  return <p className={`memory-line ${m?.status ?? 'proposed'}`}><span aria-hidden>☁</span> Memory {state}: {text}</p>;
}

const parseSnap = (r?: string): ShowSnapshot | null => {
  try { const v = JSON.parse(r ?? ''); return v && v.kind && v.table ? v as ShowSnapshot : null; } catch { return null; }
};

// Where the work should live: Pip's card before the first change in a chat. The choice is kept on the chat, so the
// card reads it back (and follows it live); only the newest card can be answered.
interface Home { place: string; scope: string | null; name: string }
interface PlaceCard { id: string; work: string; update_set: string; home: Home; rule: string; why: string; warn?: string; cite?: string; alternatives: Home[]; mismatch?: string }
type ChatPlacement = { status: 'pending' | 'choosing'; id: string } | { status: 'settled'; id: string; home: Home; update_set?: string };
const parseCard = (r?: string): PlaceCard | null => {
  try { const v = JSON.parse(r ?? '')?.placement_card; return v && v.id && v.home ? v as PlaceCard : null; } catch { return null; }
};

function PlacementCard({ card }: { card: PlaceCard }) {
  const { chatId } = useContext(BlockCtx);
  const [now, setNow] = useState<ChatPlacement | null | undefined>(undefined);
  const [apps, setApps] = useState<{ scope: string; name: string }[] | null>(null);
  const [pick, setPick] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const load = () => { if (chatId) api<{ placement: ChatPlacement | null }>(`/chats/${chatId}/placement`).then((r) => setNow(r.placement)).catch(() => {}); };
  useEffect(load, [chatId]);
  useLive('chats', (d) => { if (!d.id || d.id === chatId) load(); });
  const answer = async (by: 'accept' | 'other' | 'new-app', scope?: string) => {
    setSending(true); setError('');
    try { const r = await api<{ placement: ChatPlacement }>(`/chats/${chatId}/placement`, { body: { id: card.id, by, scope } }); setNow(r.placement); }
    catch (e) { setError((e as Error).message); }
    setSending(false);
  };
  const other = async () => { setApps([]); try { setApps((await api<{ apps: { scope: string; name: string }[] }>('/placement/apps')).apps); } catch (e) { setError((e as Error).message); } };
  const where = (h: Home) => (h.scope ? `${h.name} (${h.scope})` : h.name);
  if (now?.id === card.id && now.status === 'settled') return (
    <div className="approval done allow placement">
      <div className="approval-line"><span className="decision allow">✓ Lives in</span><span className="tool-name">{where(now.home)}{now.update_set ? ` · update set ${now.update_set}` : ''}</span></div>
    </div>
  );
  const open = now?.id === card.id && now.status === 'pending';
  return (
    <div className={`approval placement ${open ? 'pending' : 'done'}`}>
      <div className="approval-head">Where should this live?</div>
      <div className="approval-record">
        <div className="muted small">{card.work}</div>
        <div><strong>{where(card.home)}</strong></div>
        <div className="small">{card.why} <span className="muted tiny">(rule {card.rule})</span></div>
        {card.mismatch && <div className="small warn-text">{card.mismatch}</div>}
        {card.warn && <div className="small warn-text">{card.warn}</div>}
        {card.cite && <a className="small" href={card.cite} target="_blank" rel="noreferrer">Why (docs)</a>}
        {card.home.scope && <div className="muted small">Update set: {card.update_set}, in {card.home.name}</div>}
        {!!card.alternatives.length && <div className="muted small">Also possible: {card.alternatives.map(where).join(' · ')}</div>}
      </div>
      {open ? (
        <div className="approval-actions">
          <button className="primary" disabled={sending} onClick={() => answer('accept')}>{card.home.place === 'new-app' ? 'Start a new app' : `Use ${card.home.name}`}</button>
          {apps === null && <button disabled={sending} onClick={other}>Another app</button>}
          {card.home.place !== 'new-app' && <button disabled={sending} onClick={() => answer('new-app')}>New custom app</button>}
          {apps !== null && (
            <span className="place-pick">
              <select aria-label="Application" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{apps.length ? 'Pick an app…' : 'Loading…'}</option>
                {apps.map((a) => <option key={a.scope} value={a.scope}>{a.name} ({a.scope})</option>)}
              </select>
              <button disabled={sending || !pick} onClick={() => answer('other', pick)}>Use this app</button>
            </span>
          )}
          {error && <span className="error small">{error}</span>}
        </div>
      ) : now !== undefined && <div className="muted small">{now?.id === card.id && now.status === 'choosing' ? 'Switching…' : now ? 'A newer card replaced this one.' : 'This card is no longer open.'}</div>}
    </div>
  );
}

// Under an answer: how many saved rules shaped it (linking to the Memory page where they can be read, paused or
// deleted), the steps it took out of the mode's limit, and its estimated cost.
export const OPEN_MEMORY = 'wayfinder:open-memory';
export const money = (n: number) => `~$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
function AnswerFooter({ b }: { b: Extract<Block, { type: 'guided' }> }) {
  const facts = [b.steps && b.limit ? `${b.steps} of ${b.limit} steps` : '', typeof b.cost === 'number' ? money(b.cost) : ''].filter(Boolean);
  return (
    <div className="answer-foot tiny">
      {b.count > 0 && <button className="guided link tiny" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_MEMORY))}>Guided by {b.count} rule{b.count === 1 ? '' : 's'}</button>}
      {facts.length > 0 && <span className="answer-facts" title="Steps this answer took, out of the most one answer may take in this mode, and its estimated cost">{facts.join(' · ')}</span>}
    </div>
  );
}

export const OPEN_CHAT = 'wayfinder:open-chat';

// What Continue sends after an answer a restart cut off.
export const CONTINUE = 'Wayfinder restarted while you were answering. Continue where you left off.';

// A plain note under an answer. A long-chat note offers to carry on in a fresh chat; a continued chat's first note
// shows the summary it started from.
function Notice({ b }: { b: Extract<Block, { type: 'notice' }> }) {
  const { chatId, onReply } = useContext(BlockCtx);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fresh = async () => {
    setBusy(true); setErr('');
    try { const c = await api<{ id: string }>(`/chats/${chatId}/continue`, { method: 'POST' }); window.dispatchEvent(new CustomEvent(OPEN_CHAT, { detail: c.id })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={`notice ${b.level}`}>
      <p>{b.text}</p>
      {b.action === 'continue' && onReply && <p className="notice-actions"><button className="small" onClick={() => onReply(CONTINUE, true)}>Continue</button></p>}
      {b.action === 'fresh-chat' && chatId && <p className="notice-actions"><button className="small" disabled={busy} onClick={fresh}>{busy ? 'Starting…' : 'Continue in a fresh chat'}</button>{err && <span className="warn-text"> {err}</span>}</p>}
      {!!b.detail?.length && (
        <details className="carried"><summary>What Pip carried over</summary><ul>{b.detail.map((l, i) => <li key={i}>{l}</li>)}</ul></details>
      )}
    </div>
  );
}

function ProposedPlan({ spec, done, appId }: { spec: Spec; done: boolean; appId?: string }) {
  const { onReply } = useContext(BlockCtx);
  return <SpecCard spec={spec} appId={appId} onReply={done ? onReply : undefined} />;
}
const proposedAppId = (raw?: string): string | undefined => { try { const id = JSON.parse(raw ?? '')?.app_id; return typeof id === 'string' ? id : undefined; } catch { return undefined; } };

export function MessageBlocks({ blocks, onPreview, live }: { blocks: Block[]; onPreview: (html: string) => void; live?: boolean }) {
  // Sub-agent tool calls are folded under the Agent call that started them.
  const children = new Map<string, Block[]>();
  for (const b of blocks) if (b.type === 'tool' && b.parent) children.set(b.parent, [...(children.get(b.parent) ?? []), b]);
  const card = (b: Extract<Block, { type: 'tool' }>) => {
    const kids = children.get(b.id);
    return (
      <ToolCard key={b.id} block={b}>
        {kids && <div className="subtools">{kids.map((k) => k.type === 'tool' && <ToolCard key={k.id} block={k} />)}</div>}
      </ToolCard>
    );
  };
  // Runs of three or more finished steps fold into one row, so a long build reads as a few lines.
  const out: React.ReactNode[] = [];
  let run: Extract<Block, { type: 'tool' }>[] = [];
  // Every run of steps is one row keyed by its first step, so it never switches between layouts as steps finish.
  const flush = () => {
    if (run.length) out.push(<StepGroup key={`g-${run[0].id}`} steps={run} render={card} />);
    run = [];
  };
  blocks.forEach((b, i) => {
    const special = (b.type === 'tool' && b.name === 'mcp__build__propose_app' && (b.input as any)?.spec && b.status !== 'error')
      || (b.type === 'tool' && b.name === 'mcp__project__propose_memory' && b.status === 'done')
      || (b.type === 'tool' && b.name === 'mcp__pdi__show' && b.status === 'done' && !!parseSnap(b.result))
      || (b.type === 'tool' && b.name === 'mcp__pdi__placement' && b.status === 'done' && !!parseCard(b.result))
      || (b.type === 'tool' && b.name === 'mcp__pdi__open_page' && b.status === 'done' && !!parseOpen(b.result));
    if (b.type === 'tool' && !b.parent && !special) { run.push(b); return; }
    if (b.type === 'tool' && b.parent) return;
    flush();
    if (b.type === 'text') out.push(<Markdown key={i} text={b.text} onPreview={onPreview} live={live} />);
    else if (b.type === 'notice') out.push(b.card ? <NoticeCardView key={i} card={b.card} /> : b.action || b.detail?.length ? <Notice key={i} b={b} /> : <p key={i} className={`notice ${b.level}`}>{b.text}</p>);
    else if (b.type === 'approval') out.push(<ApprovalCard key={b.id} block={b} />);
    else if (b.type === 'guided') out.push(<AnswerFooter key={`guided-${i}`} b={b} />);
    else if (b.type === 'tool' && b.name === 'mcp__project__propose_memory') out.push(<MemoryCard key={b.id} block={b} />);
    else if (b.type === 'tool' && b.name === 'mcp__pdi__placement') out.push(<PlacementCard key={b.id} card={parseCard(b.result)!} />);
    else if (b.type === 'tool' && b.name === 'mcp__pdi__open_page') out.push(<OpenPageCard key={b.id} id={b.id} page={parseOpen(b.result)!} live={!!live} />);
    else if (b.type === 'tool' && b.name === 'mcp__pdi__show') out.push(<ShowCard key={b.id} snap={parseSnap(b.result)!} onPreview={onPreview} />);
    else if (b.type === 'tool') out.push(<ProposedPlan key={b.id} spec={(b.input as any).spec as Spec} done={b.status === 'done'} appId={proposedAppId(b.result)} />);
  });
  flush();
  return <>{out}{live && null}</>;
}

// What Pip is doing, as one calm row: the current step's label (it eases in when it changes), how many steps so far,
// and a spinner while anything runs. Collapsed by default; click to see each step.
function StepGroup({ steps, render }: { steps: Extract<Block, { type: 'tool' }>[]; render: (b: Extract<Block, { type: 'tool' }>) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const running = steps.find((t) => t.status === 'running');
  const failed = steps.filter((t) => t.status === 'error' || t.status === 'denied').length;
  const current = running ?? steps[steps.length - 1];
  const label = prettyTool(current.name, current.input);
  const ms = steps.reduce((n, t) => n + (t.ms ?? 0), 0);
  return (
    <div className={`tool step-group ${running ? 'running' : 'done'}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool-icon ${running ? 'running' : failed ? 'error' : 'done'}`} />
        <span className="tool-name"><span key={label} className="step-label">{label}</span></span>
        <span className="tool-state">{steps.length > 1 ? `${steps.length} steps` : ''}{!running && ms ? ` · ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}` : ''}{failed ? ` · ${failed} failed` : ''}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      <div className={`step-list ${open ? 'open' : ''}`}>{open && <div className="subtools">{steps.map(render)}</div>}</div>
    </div>
  );
}

// Pip's open_page: a page on the connected instance. It opens in a new tab once, as the answer arrives (browsers may
// block that), and the card keeps a link either way. The link carries no referrer, and Wayfinder never reads the page.
const parseOpen = (raw?: string): { open: string; label: string | null } | null => {
  try { const j = JSON.parse(raw ?? ''); return typeof j?.open === 'string' && /^https:\/\//.test(j.open) ? j : null; } catch { return null; }
};
const openedPages = new Set<string>();
function OpenPageCard({ id, page, live }: { id: string; page: { open: string; label: string | null }; live: boolean }) {
  useEffect(() => {
    if (!live || openedPages.has(id)) return;
    openedPages.add(id);
    window.open(page.open, '_blank', 'noopener,noreferrer');
  }, [id, live, page.open]);
  const host = new URL(page.open).host;
  return (
    <div className="open-page">
      <span className="spec-kicker">ServiceNow</span>
      <a href={page.open} target="_blank" rel="noopener noreferrer">{page.label ?? new URL(page.open).pathname} ↗</a>
      <span className="muted tiny">Opens in a new tab on {host}, signed in as you.</span>
    </div>
  );
}
