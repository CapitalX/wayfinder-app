import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, applyEvent, follow, send, type Block, type Chat, type Instance, type Message, type Project } from '../api.ts';
import { MODES } from '../App.tsx';
import { ApprovalChat, BlockCtx, MessageBlocks, prettyTool, saveItem } from './Blocks.tsx';
import { Pip, PIP_LABEL, setPresence, useAssistantName, usePresence, type PipState } from './Pip.tsx';
import { MemoryClouds } from './MemoryClouds.tsx';
import { BuildChip, BuildSteps } from './BuildSteps.tsx';
import { buildProgress } from '../buildProgress.ts';
import { useWork } from '../work.ts';
import { GhostLayer, acceptGhost, ghostFor } from './Ghost.tsx';
import { useLive } from '../live.ts';
import { ICON } from './icons.tsx';
import { soundsUnfinished, useVoice } from '../useVoice.ts';

// What Pip is thinking, in a few words: the step it's on, or how it feels.
function thoughtFor(state: PipState, draft: Block[] | null): string {
  if (state === 'waiting') return 'Waiting on you · approve or decline below';
  const running = draft && [...draft].reverse().find((b) => b.type === 'tool' && b.status === 'running') as Extract<Block, { type: 'tool' }> | undefined;
  if (running) return prettyTool(running.name, running.input).replace(/ · $/, '') + '…';
  return PIP_LABEL[state];
}

// The work area covers the whole screen at this width, so the build timeline never opens by itself there.
const NARROW = '(max-width: 860px)';
const wide = () => typeof matchMedia === 'undefined' || !matchMedia(NARROW).matches;
// Chats whose build timeline already opened by itself once: closing it keeps it closed.
const timelineOpened = new Set<string>();
// Debug chats where the board already came to you, or where you closed it: it doesn't open by itself again.
const boardSettled = new Set<string>();

const BUILDING = /^mcp__build__(write_app_file|delete_app_file|build_app|propose_app|install_app)$|^mcp__pdi__(activate_plugin|install_store_app)$/;

// What Pip looks like right now, from the answer in progress (or the last one).
function pipFor(draft: Block[] | null, messages: Message[], typing: boolean, justFinished: boolean, quietFor: number): PipState {
  if (draft) {
    if (draft.some((b) => b.type === 'approval' && !b.decision)) return 'waiting';
    const running = draft.filter((b) => b.type === 'tool' && b.status === 'running') as Extract<Block, { type: 'tool' }>[];
    if (running.some((b) => BUILDING.test(b.name))) return 'building';
    if (running.length) return 'thinking';
    const last = draft[draft.length - 1];
    // Words are arriving: Pip talks. A long silence with nothing running means a hard call: Pip ponders.
    if (last?.type === 'text' && quietFor < 1500) return draft.some((b) => b.type === 'tool') && quietFor < 400 && last.text.length < 80 ? 'discovery' : 'talking';
    if (quietFor > 5000) return 'pondering';
    return 'thinking';
  }
  if (typing) return 'listening';
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant' && lastMsg.blocks.some((b) => b.type === 'notice' && b.level === 'error')) return 'failure';
  if (justFinished) return 'success';
  return 'idle';
}

interface ChatData { chat: Chat; instance: Instance | null; running: boolean; messages: Message[]; apps: { id: string; name: string; status: string }[] }

export function ChatView({ chatId, projects, onChanged, reloadKey, autoSend, onAutoSent, voice }: {
  chatId: string; projects: Project[]; onChanged: () => void; reloadKey: string; autoSend?: string; onAutoSent?: () => void; voice?: boolean;
}) {
  const [data, setData] = useState<ChatData | null>(null);
  const [draft, setDraft] = useState<Block[] | null>(null);
  const draftRef = useRef<Block[] | null>(null);
  draftRef.current = draft;
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // Ghost-text candidates: instance-aware starters for this mode, and what you've already asked in this chat.
  const [starters, setStarters] = useState<string[]>([]);
  const mode = data?.chat.mode;
  useEffect(() => { if (mode) api<{ text: string }[]>(`/suggestions?chat_id=${chatId}&mode=${mode}`).then((r) => setStarters(r.map((x) => x.text))).catch(() => {}); }, [chatId, mode]);
  const asked = (data?.messages ?? []).filter((m) => m.role === 'user').flatMap((m) => m.blocks.flatMap((b) => b.type === 'text' ? [b.text] : [])).reverse();
  const [error, setError] = useState('');
  const work = useWork();
  const setPreview = useStable((html: string) => work.preview(html));
  const isBuild = data?.chat.mode === 'build';
  const progress = useMemo(() => (isBuild && data ? buildProgress(data.messages, draft) : null), [isBuild, data, draft]);
  const handBuild = useStable(work.build);
  const showTab = useStable(work.show);
  // Only real changes go up: the draft changes on every streamed word, the steps far less often.
  const sentBuild = useRef('');
  useEffect(() => { const k = JSON.stringify(progress); if (k !== sentBuild.current) { sentBuild.current = k; handBuild(progress); } }, [progress, handBuild]);
  useEffect(() => () => { sentBuild.current = ''; handBuild(null); }, [chatId, handBuild]);
  // The first build step Pip takes in this chat, the plan included, opens the timeline beside the conversation, once.
  // propose_app returns at once, so a step that has already finished in this answer counts too.
  const buildingNow = !!draft?.some((b) => b.type === 'tool' && b.name.startsWith('mcp__build__'));
  useEffect(() => {
    if (!buildingNow || timelineOpened.has(chatId) || !wide()) return;
    timelineOpened.add(chatId);
    showTab('build');
  }, [buildingNow, chatId, showTab]);
  // In Debug, Pip's first pinned clue brings the board out, unless you closed it in this chat or another panel is open.
  const pinned = mode === 'debug' && !!draft?.some((b) => b.type === 'tool' && b.name === 'mcp__project__board_pin' && b.status === 'done');
  useEffect(() => {
    if (!pinned || work.tab || boardSettled.has(chatId) || !wide()) return;
    boardSettled.add(chatId);
    showTab('board');
  }, [pinned, work.tab, chatId, showTab]);
  const lastTab = useRef(work.tab);
  useEffect(() => { if (lastTab.current === 'board' && work.tab !== 'board') boardSettled.add(chatId); lastTab.current = work.tab; }, [work.tab, chatId]);
  const [justFinished, setJustFinished] = useState(false);
  const [pipOpen, setPipOpen] = useState(false);
  const presence = usePresence();
  const name = useAssistantName();
  // When the last streamed event arrived, so Pip can tell talking from pondering.
  const lastEvent = useRef(Date.now());
  const [tick, setTick] = useState(0);
  const [focused, setFocused] = useState(false);
  const ghost = focused ? ghostFor(input, [...starters, ...asked]) : '';
  const [cloudKey, setCloudKey] = useState(0);
  const [absorbed, setAbsorbed] = useState(false);
  // One message can wait while Pip answers; it goes when the answer ends, or now with Send now (interrupt).
  const [queued, setQueuedState] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  const setQueued = (t: string | null) => { queuedRef.current = t; setQueuedState(t); };
  const [keepGoing, setKeepGoing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const load = () => api<ChatData>(`/chats/${chatId}`).then(setData).catch((e) => setError(e.message));
  // A question started from elsewhere (e.g. the Features panel's Guide me) sends once the chat has loaded.
  const sentAuto = useRef(false);
  useEffect(() => {
    if (!autoSend || !data || sentAuto.current) return;
    sentAuto.current = true;
    onAutoSent?.();
    submit(autoSend);
  }, [autoSend, data]);
  useEffect(() => { load(); }, [chatId]);
  // A note from a background job (or another tab) landed in this chat: show it now, unless an answer is streaming.
  useLive('chats', (d) => { if (d.chat_id === chatId && !draftRef.current) load(); });
  useLive('instance', () => load());
  useLive('memories', () => setCloudKey((k) => k + 1));
  // A background install finished; its note may belong to this chat. Skip while an answer is streaming.
  useEffect(() => { if (!draft) load(); }, [reloadKey]);
  // An answer already running when the chat opens (you left and came back, reloaded, or it started on another device,
  // or the app started it after an install): join it from its first event and follow it live, as if you never left.
  const following = useRef<AbortController | null>(null);
  const [followFailed, setFollowFailed] = useState(false);
  useEffect(() => () => following.current?.abort(), []);
  useEffect(() => {
    if (!data?.running || draft || following.current || followFailed) return;
    const ctl = new AbortController();
    following.current = ctl;
    let events = 0;
    // A join that fails, or ends without a single step while the chat still says it's answering, falls back to polling.
    void streamAnswer((on) => follow(chatId, (e) => { events++; on(e); }, ctl.signal))
      .then((ok) => { following.current = null; if ((!ok || events <= 1) && !ctl.signal.aborted) setFollowFailed(true); });
  }, [data, draft, followFailed]);
  // If joining didn't work, poll until the answer is saved.
  useEffect(() => {
    if (!data?.running || draft || !followFailed) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [data, draft, followFailed]);
  useEffect(() => { if (stick.current) bottom.current?.scrollIntoView({ block: 'end' }); }, [data, draft, pendingUser]);

  const busy = !!draft || !!data?.running;
  useEffect(() => { if (!draft) return; const t = setInterval(() => setTick((n) => n + 1), 700); return () => clearInterval(t); }, [!!draft]);
  const quietFor = Date.now() - lastEvent.current + tick * 0;
  const pipState: PipState = absorbed ? 'success' : pipFor(draft, data?.messages ?? [], focused && !!input.trim() && !draft, justFinished, quietFor);
  // While you type, Pip reads along: its eyes move along the line and down as the text grows.
  const lines = input.split('\n');
  const gaze = focused && input && !draft ? { x: 0.35 + 0.65 * Math.min(1, (lines[lines.length - 1].length % 70) / 70), y: 0.25 + 0.2 * Math.min(1, (lines.length - 1) / 4) } : undefined;
  // The box is one line, as tall as the send button, and grows with what you write (up to 40% of the screen).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [input, data !== null]);

  const submit = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text) return;
    if (override === undefined) setInput('');
    setKeepGoing(false);
    if (busy) { setQueued(text); return; }
    setError('');
    setPendingUser(text);
    await streamAnswer((on) => send(chatId, text, on));
  };

  // Shows an answer as it streams (one you sent, or one you joined), then the saved version. False if the stream failed.
  async function streamAnswer(run: (onEvent: (e: any) => void) => Promise<void>): Promise<boolean> {
    setDraft([]);
    stick.current = true;
    // Chunks are applied in batches, at most about 60 times a second, instead of one render per word.
    let batch: unknown[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ok = true;
    const flush = () => { timer = undefined; const es = batch; batch = []; if (es.length) setDraft((d) => es.reduce<Block[]>((b, e) => applyEvent(b, e), d ?? [])); };
    try {
      await run((e) => {
        if (e.t === 'done') return;
        lastEvent.current = Date.now();
        batch.push(e);
        timer ??= setTimeout(flush, 16);
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;   // the chat closed; it picks up again when reopened
      ok = false;
      setError((e as Error).message);
    }
    clearTimeout(timer);
    flush();
    await load();
    setDraft(null);
    setPendingUser(null);
    setJustFinished(true);
    setTimeout(() => setJustFinished(false), 2500);
    setCloudKey((k) => k + 1);
    onChanged();
    const next = queuedRef.current;
    if (next) { setQueued(null); submit(next); }
    return ok;
  }

  const mic = useVoice(
    (text) => {
      // A trailing "and…" waits for the rest: it goes into the box and the next recording adds to it.
      const combined = `${input.trim() ? input.trim() + ' ' : ''}${text}`;
      if (soundsUnfinished(text)) { setInput(combined); setKeepGoing(true); return; }
      setInput('');
      submit(combined);
    },
    (msg) => setError(msg),
  );

  const patch = async (body: { mode?: string; project_id?: string | null; auto_mode?: string; auto_app_id?: string }) => {
    await api(`/chats/${chatId}`, { method: 'PATCH', body });
    load();
    onChanged();
  };

  // Auto mode: installs and test runs for the chosen app (or project) go through without a card, for two hours.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const autoOn = !!data && data.chat.auto_mode !== undefined && data.chat.auto_mode !== 'ask' && (data.chat.auto_until ?? 0) > now;
  const setAuto = async (v: string) => {
    setError('');
    try {
      if (v === 'ask') await patch({ auto_mode: 'ask' });
      else if (v === 'project') await patch({ auto_mode: 'project' });
      else await patch({ auto_mode: 'app', auto_app_id: v.slice(4) });
    } catch (e) { setError((e as Error).message); }
  };
  const autoLeft = autoOn ? Math.max(1, Math.round(((data!.chat.auto_until ?? 0) - now) / 60_000)) : 0;
  const autoWhat = autoOn ? (data!.chat.auto_mode === 'app' ? data!.apps.find((a) => a.id === data!.chat.auto_app_id)?.name ?? 'this app' : 'apps in this project') : '';

  // Buttons inside a message (e.g. Approve plan) either send an answer or start one in the composer.
  const reply = useStable((text: string, now: boolean) => {
    if (now) return submit(text);
    setInput(text);
    setTimeout(() => { box.current?.focus(); box.current?.setSelectionRange(text.length, text.length); }, 0);
  });

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!data) return <div className="chat"><p className="muted pad">{error || 'Loading…'}</p></div>;

  const apps = data.apps;
  const fullPermissions = data.instance?.kind === 'pdi' && data.instance.status === 'active' && data.instance.full_permissions === 1;
  const dial = fullPermissions ? <span className="auto-chip" title="Changes, scripts and installs run without asking. Change this in Settings.">Full permissions</span> : (
    <div className="dial" role="radiogroup" aria-label="Approvals">
      <button role="radio" aria-checked={!autoOn} className={!autoOn ? 'on' : ''} onClick={() => setAuto('ask')} title="Every change to the instance asks first">Ask</button>
      {apps.slice(0, 2).map((a) => (
        <button key={a.id} role="radio" aria-checked={autoOn && data.chat.auto_mode === 'app' && data.chat.auto_app_id === a.id}
          className={autoOn && data.chat.auto_mode === 'app' && data.chat.auto_app_id === a.id ? 'on auto' : ''}
          onClick={() => setAuto(`app:${a.id}`)} title={`Installs and test runs for ${a.name} go through for 2 hours`}>Auto · {a.name}</button>
      ))}
      {data.chat.project_id && (
        <button role="radio" aria-checked={autoOn && data.chat.auto_mode === 'project'} className={autoOn && data.chat.auto_mode === 'project' ? 'on auto' : ''}
          onClick={() => setAuto('project')} title="Installs and test runs for apps in this project go through for 2 hours">Auto · project</button>
      )}
    </div>
  );

  return (
    <div className="chat-layout">
      <div className="chat">
        <header className="chat-head">
          <h2 title={data.chat.title}>{data.chat.title}</h2>
          <select className="chip-select" value={data.chat.project_id ?? ''} onChange={(e) => patch({ project_id: e.target.value || null })} aria-label="Project">
            <option value="">Project: none</option>
            {projects.map((p) => <option key={p.id} value={p.id}>Project: {p.name}</option>)}
          </select>
          <select className="chip-select" title="Mode: what Pip focuses on in this chat" value={data.chat.mode} onChange={(e) => patch({ mode: e.target.value })} disabled={busy} aria-label="Mode">
            {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>Mode: {v}</option>)}
          </select>
          {progress && wide() && work.tab !== 'build' && <BuildChip progress={progress} onOpen={() => work.show('build')} />}
        </header>
        {progress && !wide() && <BuildSteps progress={progress} />}
        {autoOn && !fullPermissions && (
          <div className="auto-banner">
            <span className="auto-chip">auto</span>
            <span>Installs and test runs for <b>{autoWhat}</b> go through without asking · {autoLeft >= 60 ? `${Math.floor(autoLeft / 60)}h ${autoLeft % 60}m` : `${autoLeft}m`} left. Removals, plugins and anything the scan flags still ask.</span>
            <button className="link" onClick={() => setAuto('ask')}>Stop auto</button>
          </div>
        )}
        <div className="messages" onScroll={onScroll}>
          <div className="messages-inner">
            {data.instance && data.instance.status !== 'active' && (
              <p className="notice inst-gone">This chat was on {data.instance.url}, which was {data.instance.status === 'removed' ? 'removed' : 'switched off for another instance'}. You can read it; instance tools are off.</p>
            )}
            {!data.messages.length && !pendingUser && <ModeStart mode={data.chat.mode} chatId={chatId} onSend={(t) => submit(t)} onFill={(t) => reply(t, false)} />}
            {data.messages.map((m, i) => (
              <PastMessage key={m.id} m={m} chatId={chatId} name={name} onPreview={setPreview}
                mark={m.role === 'assistant' && (i === 0 || data.messages[i - 1].role !== 'assistant')}
                onReply={!busy && i === data.messages.length - 1 ? reply : undefined} />
            ))}
            {pendingUser && <div className="msg user"><MessageBlocks blocks={[{ type: 'text', text: pendingUser }]} onPreview={setPreview} /></div>}
            {draft && (
              <div className="msg assistant">
                <div className="msg-mark"><Pip size={16} still />{name}</div>
                <ApprovalChat.Provider value={chatId}><MessageBlocks blocks={draft} onPreview={setPreview} live /></ApprovalChat.Provider>
                {!draft.some((b) => b.type === 'text') && !draft.some((b) => b.type === 'approval' && !b.decision) && <div className="thinking"><span /><span /><span /></div>}
              </div>
            )}
            {data.running && !draft && followFailed && <p className="muted small">Still answering in the background…</p>}
            <div ref={bottom} />
          </div>
        </div>
        <div className={`composer ${presence === 'off' ? 'no-pip' : ''}`}>
          {error && <p className="error small">{error}</p>}
          {!busy && !data.chat.project_id && data.messages.some((m) => m.role === 'assistant') && <KeepBar chat={data.chat} first={data.messages.find((m) => m.role === 'user')} projects={projects} onSet={(id) => patch({ project_id: id })} />}
          {!busy && <Pills mode={data.chat.mode} messages={data.messages} onSend={(t) => submit(t)} onFill={(t) => reply(t, false)} />}
          {presence !== 'off' && (
              <div className={`pip-seat st-${pipState}`}>
                <MemoryClouds chatId={chatId} reloadKey={cloudKey}
                  onAbsorb={() => { setAbsorbed(true); window.setTimeout(() => setAbsorbed(false), 1400); }}
                  onCount={onChanged} />
                <button className="pip-btn" onClick={() => setPipOpen(!pipOpen)} aria-label={`${name}: ${PIP_LABEL[pipState]}`} aria-expanded={pipOpen}>
                  <Pip state={pipState} size={30} track gaze={gaze} />
                  <span className="pip-state" aria-live="polite">{thoughtFor(pipState, draft)}</span>
                </button>
                {pipOpen && (
                  <div className="pip-pop" role="dialog" aria-label="Pip">
                    <div className="ver">Pip · {PIP_LABEL[pipState]}</div>
                    <p>{pipLine(pipState, data.chat.mode, projects.find((p) => p.id === data.chat.project_id)?.name)}</p>
                    <div className="seg-row">
                      {(['alive', 'still', 'off'] as const).map((p) => (
                        <button key={p} className={presence === p ? 'on' : ''} onClick={() => { setPresence(p); api('/settings', { method: 'PUT', body: { presence: p } }).catch(() => {}); }}>
                          {p === 'alive' ? 'Alive' : p === 'still' ? 'Still' : 'Off'}
                        </button>
                      ))}
                    </div>
                    <p className="muted tiny">Off removes Pip entirely; answers come from Wayfinder in a neutral tone.</p>
                    <div className="row-actions"><button onClick={() => setPipOpen(false)}>Close</button></div>
                  </div>
                )}
              </div>
          )}
          <div className={`composer-box ${focused ? 'focus' : ''}`}>
            <div className="ghost-wrap">
              <GhostLayer input={input} ghost={ghost} />
              <textarea
                ref={box}
                value={input}
                placeholder={PLACEHOLDER[data.chat.mode] ?? 'Ask about ServiceNow or your instance…'}
                aria-label="Message"
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  if (acceptGhost(e, ghost, setInput)) return;
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
                }}
                rows={1}
              />
            </div>
            {voice && mic.state !== 'idle'
              ? (mic.state === 'recording'
                  ? <button className="mic-btn rec" onClick={mic.stop} title="Stop and send" aria-label="Stop recording"><span className="mic-level" style={{ transform: `scale(${1 + Math.min(mic.level * 3, 0.8)})` }} />{mic.seconds}s · done</button>
                  : <button className="mic-btn" disabled>Hearing…</button>)
              : busy && queued
                ? <button className="send-now" onClick={() => api(`/chats/${chatId}/stop`, { method: 'POST' })} title="Stop this answer and send the waiting message now">Send now {ICON.send}</button>
                : busy && !input.trim()
                  ? <button className="round stop" onClick={() => api(`/chats/${chatId}/stop`, { method: 'POST' })} title="Stop this answer" aria-label="Stop">{ICON.stop}</button>
                  : input.trim()
                    ? <button className={`round primary ${busy ? 'queue' : ''}`} onClick={() => submit()} title={busy ? 'Sends when this answer ends' : 'Send'} aria-label={busy ? 'Queue' : 'Send'}>{ICON.send}</button>
                    : voice
                      ? <button className="round mic" onClick={mic.start} title="Talk" aria-label="Start voice message">{ICON.mic}</button>
                      : <button className="round primary" disabled aria-label="Send">{ICON.send}</button>}
          </div>
          {queued && (
            <p className="queued small"><span className="auto-chip">waiting</span> {queued.length > 90 ? queued.slice(0, 90) + '…' : queued}
              <button className="link" onClick={() => { setInput(queued); setQueued(null); }}>Edit</button>
              <button className="link" onClick={() => setQueued(null)}>Drop</button></p>
          )}
          {keepGoing && <p className="muted small">Keep going… tap the mic to add the rest, or press Send.</p>}
          <div className="composer-foot">
            {(fullPermissions || apps.length > 0 || data.chat.project_id) ? dial : <span />}
            <span className="muted tiny">Enter to send{busy ? ' (waits its turn)' : ''} · Shift+Enter new line{voice ? ' · mic for voice' : ''}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// After the first answer, offer to keep the chat in a project (projects are never asked for up front).
function KeepBar({ chat, first, projects, onSet }: { chat: Chat; first?: Message; projects: Project[]; onSet: (projectId: string) => void }) {
  const key = `snw-keep-${chat.id}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const [busy, setBusy] = useState(false);
  if (hidden) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem(key, '1'); } catch { /* storage unavailable */ } };
  const brief = first?.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').slice(0, 400) ?? '';
  const create = async () => {
    setBusy(true);
    try { const p = await api<Project>('/projects', { body: { name: chat.title.slice(0, 80), brief } }); onSet(p.id); } finally { setBusy(false); }
  };
  return (
    <div className="keep-bar">
      <span>Worth keeping?<span className="keep-why"> Projects hold the brief, saved work and apps together.</span></span>
      <button className="link small" disabled={busy} onClick={create}>New project from this chat</button>
      {!!projects.length && (
        <select className="chip-select" value="" onChange={(e) => e.target.value && onSet(e.target.value)} aria-label="Add to project">
          <option value="">Add to…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <button className="icon-btn small" aria-label="Not now" onClick={dismiss}>×</button>
    </div>
  );
}

const PLACEHOLDER: Record<string, string> = {
  explore: 'Ask how something works, or name a table or record to look at…',
  mockup: 'Describe the screen: who uses it, what they need to see and do…',
  decide: 'What are you deciding? Add the options if you have them…',
  debug: 'What’s going wrong? A record number, a table or an error helps…',
  build: 'Describe the app: who uses it, what it tracks, the rules…',
};

// The start screen of an empty chat: what this mode does, how to begin, and starters from the instance.
const INTRO: Record<string, { title: string; line: string; tips: string[] }> = {
  explore: { title: 'Learn how something works', line: 'Pip explains from the official docs, with links, then shows you where it lives on your instance.', tips: ['Ask about a feature, table or behaviour', 'Name a record or table to see it live', 'Ask "what should I try next?" at any point'] },
  mockup: { title: 'Sketch a screen', line: 'Pip draws a ServiceNow-style screen right here. Tweak it in plain words, save it, compare versions.', tips: ['Pick a screen type below, or start from one of your tables', 'Say who uses it and what they need to see and do', 'Then ask for changes: "add a related list", "make it a workspace"'] },
  decide: { title: 'Make a design decision', line: 'Options, trade-offs and one recommendation, backed by the docs and your instance.', tips: ['State the decision in a sentence', 'Add the options you’re weighing, if any', 'Save the answer as a decision when you settle it'] },
  debug: { title: 'Fix a problem', line: 'Pip checks with read-only queries first and pins every clue to the Board, marked as it tests.', tips: ['Describe the symptom', 'Give a record number, table or error if you have one', 'Open the Board (rail) to watch the investigation'] },
  build: { title: 'Build an app', line: 'Pip checks what ServiceNow already offers, then plans, builds and installs a scoped app, asking before it changes anything.', tips: ['Describe who uses it, what it tracks and the rules', 'Approve the plan card, or ask for changes', 'Approve the install; it runs in the background'] },
};
const SCREENS = [
  ['Form', 'Mock up a classic form for '], ['List', 'Mock up a list view of '], ['Workspace page', 'Mock up a Next Experience workspace page for '],
  ['Portal page', 'Mock up a Service Portal page where '], ['Dashboard', 'Mock up a dashboard showing '],
] as const;

function ModeStart({ mode, chatId, onSend, onFill }: { mode: string; chatId: string; onSend: (t: string) => void; onFill: (t: string) => void }) {
  const [items, setItems] = useState<{ label: string; text: string; why?: string }[] | null>(null);
  useEffect(() => { api<{ label: string; text: string; why?: string }[]>(`/suggestions?chat_id=${chatId}&mode=${mode}`).then(setItems).catch(() => setItems([])); }, [chatId, mode]);
  const intro = INTRO[mode] ?? INTRO.explore;
  return (
    <div className="mode-start">
      <div className="spec-kicker">{MODES[mode]}</div>
      <h3>{intro.title}</h3>
      <p className="muted">{intro.line}</p>
      <ol className="mode-tips">{intro.tips.map((t) => <li key={t}>{t}</li>)}</ol>
      {mode === 'mockup' && (
        <div className="seg-row screen-types">
          {SCREENS.map(([label, text]) => <button key={label} onClick={() => onFill(text)}>{label}</button>)}
        </div>
      )}
      <div className="label">{items?.some((i) => i.why) ? 'From your instance' : 'Try one'}</div>
      <div className="starters">
        {items === null && <p className="muted small">Looking at your instance…</p>}
        {items?.map((s) => (
          <button key={s.label} className="starter" onClick={() => (s.text.endsWith(' ') ? onFill(s.text) : onSend(s.text))}>
            <strong>{s.label}</strong>{s.why && <span className="muted tiny">{s.why}</span>}<span className="goal-arrow">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const HINTS: Record<string, string[]> = {
  explore: ['How does the VR background job framework decide when to run a job?', 'Which plugins are active on my PDI for Performance Analytics?'],
  mockup: ['Mock up a VIT form with an exception deadline and compliance class section', 'Mock up a workspace landing page for remediation owners'],
  decide: ['Should my monthly violated-VIT snapshot be a custom table or a PA indicator?', 'Business rule or flow for rolling the earliest VIT deadline up to the vulnerability?'],
  debug: ['Why did my scheduled job not run last night? Check the logs.', 'Which business rules fire on sn_vul_vulnerable_item updates, in order?'],
  build: ['An equipment loaner app: assets, loans with due dates, and a reminder the day before a loan is due', 'A simple change freeze calendar: freeze windows, who approved them, and a check that warns on changes inside a window'],
};

// Keeps a whole answer, as a decision or a note, in the chat's project.
// A callback that keeps one identity across renders but always runs the latest version, so memoized children that
// receive it don't re-render just because the parent did.
function useStable<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...a: A) => ref.current(...a), []);
}

// One message already in the chat. Memoized: while an answer streams the chat re-renders many times a second, and the
// earlier messages (which don't change) must not re-render or re-parse their markdown each time.
type PastProps = { m: Message; chatId: string; name: string; mark: boolean; onReply?: (text: string, now: boolean) => void; onPreview: (html: string) => void };
const PastMessage = memo(function PastMessage({ m, chatId, name, mark, onReply, onPreview }: PastProps) {
  const ctx = useMemo(() => ({ chatId, onReply }), [chatId, onReply]);
  return (
    <div className={`msg ${m.role}`}>
      {mark && <div className="msg-mark"><Pip size={16} still />{name}</div>}
      <BlockCtx.Provider value={ctx}>
        <ApprovalChat.Provider value={chatId}><MessageBlocks blocks={m.blocks} onPreview={onPreview} /></ApprovalChat.Provider>
      </BlockCtx.Provider>
      {m.role === 'assistant' && m.blocks.some((b) => b.type === 'text' && b.text.trim()) && <SaveAnswer chatId={chatId} blocks={m.blocks} />}
    </div>
  );
});

function SaveAnswer({ chatId, blocks }: { chatId: string; blocks: Block[] }) {
  const [saved, setSaved] = useState('');
  const textOf = () => blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n').trim();
  const save = async (kind: 'decision' | 'note') => {
    const body = textOf();
    const title = body.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim()).find((l) => l.length > 3)?.slice(0, 100) ?? 'Answer';
    await saveItem(chatId, kind, title, body);
    setSaved(kind);
  };
  return (
    <div className="msg-actions">
      {saved
        ? <span className="muted tiny">Saved as a {saved}</span>
        : <><button className="link" onClick={() => save('decision')}>Save as decision</button><button className="link" onClick={() => save('note')}>Save as note</button></>}
    </div>
  );
}

// Smart suggestions as pills above the message box: starters for an empty chat, then next steps that fit where the
// conversation is (a plan waiting for approval, an app just installed, a board with open clues).
function Pills({ mode, messages, onSend, onFill }: { mode: string; messages: Message[]; onSend: (t: string) => void; onFill: (t: string) => void }) {
  const blocks = messages.flatMap((m) => m.blocks);
  const tools = blocks.filter((b) => b.type === 'tool') as Extract<Block, { type: 'tool' }>[];
  const has = (n: string) => tools.some((t) => t.name === n && t.status === 'done');
  const notices = blocks.filter((b) => b.type === 'notice').map((b) => (b as { text: string }).text).join('\n');
  const pills: { label: string; text: string; send: boolean; before?: () => Promise<unknown> }[] = [];
  if (!messages.length) return null; // the mode's start screen offers the starters
  // Pip just offered out-of-the-box options: make both paths one tap.
  const lastText = [...(messages[messages.length - 1]?.role === 'assistant' ? messages[messages.length - 1].blocks : [])].filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
  if (messages.length && /```cards/.test(lastText) && /out[- ]of[- ]the[- ]box|already (have|has|on)|ships (with|its)|turn (it|one|on)|instead of (building|drawing)/i.test(lastText) && (mode === 'build' || mode === 'mockup')) {
    pills.push({ label: 'Use the out-of-the-box one', text: 'Use your recommended out-of-the-box option: walk me through turning it on, then cover only the gap.', send: true },
      { label: mode === 'build' ? 'Build custom anyway' : 'Mock up custom anyway', text: mode === 'build' ? 'Build it custom anyway; propose the plan.' : 'Mock it up custom anyway.', send: true });
  }
  else if (mode === 'build') {
    // Approve plan is recorded on the server (for the latest plan in this chat) before it's said.
    const planApp = (() => { const t = [...tools].reverse().find((x) => x.name === 'mcp__build__propose_app' && x.status === 'done'); try { return JSON.parse(t?.result ?? '')?.app_id as string | undefined; } catch { return undefined; } })();
    if (has('mcp__build__propose_app') && !has('mcp__build__write_app_file')) pills.push({ label: 'Approve plan', text: 'Plan approved. Build it.', send: true, before: planApp ? () => api(`/apps/${planApp}/approve-plan`, { method: 'POST' }).catch(() => {}) : undefined }, { label: 'Change the plan…', text: 'Change the plan: ', send: false });
    else if (/is installed on the PDI/.test(notices)) {
      if (!tools.some((t) => t.name === 'mcp__pdi__show')) pills.push({ label: 'Show me the app', text: 'Show me the app on the PDI: a list of its main table.', send: true });
      if (!has('mcp__build__run_app_tests')) pills.push({ label: 'Run the tests', text: 'Run the app tests.', send: true });
      pills.push({ label: 'Review it', text: 'Have the reviewer check the app against the plan and the docs.', send: true });
    } else if (has('mcp__build__build_app') && !tools.some((t) => t.name === 'mcp__build__install_app')) pills.push({ label: 'Install it', text: 'Install it on the PDI.', send: true });
  } else if (mode === 'debug' && tools.some((t) => t.name.startsWith('mcp__project__board_'))) {
    pills.push({ label: 'What’s still open?', text: 'What is still open on the board, and what should we test next?', send: true });
  } else if (mode === 'mockup' && blocks.some((b) => b.type === 'text' && /```html/.test(b.text))) {
    pills.push({ label: 'Try another layout', text: 'Show me a different layout for the same screen.', send: true }, { label: 'Make it a workspace', text: 'Redo it as a Next Experience workspace page.', send: true });
  }
  if (!pills.length) return null;
  return (
    <div className="pills" aria-label="Suggestions">
      {pills.map((p) => <button key={p.label} className="pill" onClick={async () => { await p.before?.(); if (p.send) onSend(p.text); else onFill(p.text); }}>{p.label}</button>)}
    </div>
  );
}

function pipLine(state: PipState, mode: string, project?: string): string {
  const where = project ? ` in ${project}` : '';
  switch (state) {
    case 'waiting': return 'Waiting on your answer to the card below. Nothing changes on the instance until you approve.';
    case 'building': return `Building${where}. Progress is in the chat and in the chip at the top.`;
    case 'thinking': return 'Checking the docs and the instance before answering.';
    case 'discovery': return 'Found what I was looking for; writing it up.';
    case 'failure': return 'Something failed in the last answer. The note says what; ask me to look into it.';
    case 'success': return 'Done.';
    case 'listening': return 'Listening.';
    default: return `Ready${where}. This chat is in ${MODES[mode] ?? mode} mode.`;
  }
}
