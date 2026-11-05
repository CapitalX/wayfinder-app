import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Chat, type Job, type Memory, type Project, type Settings, type Status } from './api.ts';
import { ChatView } from './components/ChatView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { ProjectView } from './components/ProjectView.tsx';
import { Login } from './components/Login.tsx';
import { StatusBanner } from './components/StatusBanner.tsx';
import { DocsPicker, InsightsButton, UpdateSetPill, type Pulse } from './components/HeaderTools.tsx';
import { JobsBar } from './components/JobsBar.tsx';
import { Pip, setPresence } from './components/Pip.tsx';
import { WhatsNew } from './components/WhatsNew.tsx';
import { FeaturesPanel } from './components/FeaturesPanel.tsx';
import { BoardPanel } from './components/BoardPanel.tsx';
import { MemoryView } from './components/MemoryView.tsx';
import { OPEN_CHAT, OPEN_MEMORY } from './components/Blocks.tsx';
import { PreviewPanel } from './components/PreviewPanel.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { HomeStart } from './components/HomeStart.tsx';
import { SetupView } from './components/SetupView.tsx';
import { WorkCtx, type WorkTab } from './work.ts';
import type { BuildProgress } from './buildProgress.ts';
import { BuildTimeline } from './components/BuildSteps.tsx';
import { useLive } from './live.ts';

export const MODES: Record<string, string> = { explore: 'Explore', mockup: 'Mockup', decide: 'Decide', debug: 'Debug', build: 'Build' };

type View = { kind: 'chat'; id: string } | { kind: 'project'; id: string } | { kind: 'settings' } | { kind: 'memory' } | { kind: 'setup' } | { kind: 'home' };

// Line icons for the rail (inline SVG, so no icon font or CDN).
const I = {
  chats: 'M4 5h16v10H8l-4 4z', board: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z', features: 'M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z',
  memory: 'M7 18a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6-1.2A4.5 4.5 0 0 1 17 18z', settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
};
const Icon = ({ d }: { d: string }) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;

// Phones get the same features in a slimmer frame: a title bar, a drawer and one thing on screen at a time.
const PHONE = '(max-width: 640px)';
function usePhone() {
  const [phone, setPhone] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(PHONE).matches);
  useEffect(() => {
    const m = matchMedia(PHONE);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

export function App() {
  const phone = usePhone();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [voice, setVoice] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // A link to a Settings section (#settings/<section>) opens Settings.
  const [view, setView] = useState<View>(() => (window.location.hash.startsWith('#settings/') ? { kind: 'settings' } : { kind: 'home' }));
  const [status, setStatus] = useState<Status | null>(null);
  const [listOpen, setListOpen] = useState(() => { try { return localStorage.getItem('snw-list') !== '0'; } catch { return true; } });
  const [mobileNav, setMobileNav] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<string[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [greeting, setGreeting] = useState<{ hello: string; line: string; action?: { label: string; chatId?: string; projectId?: string } | null } | null>(null);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [work, setWork] = useState<{ tab: WorkTab; html?: string; query?: string } | null>(null);
  const [palette, setPalette] = useState(false);
  const [pending, setPending] = useState(0);
  const [autoSend, setAutoSend] = useState<{ chatId: string; text: string } | null>(null);

  const refreshChats = useCallback(() => api<Chat[]>('/chats').then(setChats).catch(() => {}), []);
  const refreshProjects = useCallback(() => api<Project[]>('/projects').then(setProjects).catch(() => {}), []);
  const refreshStatus = useCallback(() => api<Status | null>('/status').then(setStatus).catch(() => {}), []);
  const refreshPending = useCallback(() => api<Memory[]>('/memories').then((m) => setPending(m.filter((x) => x.status === 'proposed').length)).catch(() => {}), []);
  const refreshAll = useCallback(() => { refreshChats(); refreshProjects(); refreshPending(); }, [refreshChats, refreshProjects, refreshPending]);

  useEffect(() => {
    api<{ voice?: boolean }>('/session').then((r) => { setAuthed(true); setVoice(!!r.voice && !!navigator.mediaDevices); }).catch((e) => setAuthed(e instanceof ApiError && e.status === 401 ? false : true));
  }, []);
  useEffect(() => {
    if (!authed || view.kind !== 'home') return;
    api<NonNullable<typeof greeting>>(`/greeting?hour=${new Date().getHours()}`).then(setGreeting).catch(() => {});
    api<Pulse>('/pulse').then(setPulse).catch(() => {});
  }, [authed, view.kind]);
  useEffect(() => {
    if (!authed) return;
    // Pip's presence is saved on the server so every device agrees.
    api<Settings>('/settings').then((st) => st.presence && setPresence(st.presence)).catch(() => {});
    // First run: show the setup steps until they're done or skipped.
    api<{ done: boolean }>('/setup').then((st) => { if (!st.done) setView({ kind: 'setup' }); }).catch(() => {});
    refreshAll();
    refreshStatus();
    const t = setInterval(refreshStatus, 5 * 60_000);
    return () => clearInterval(t);
  }, [authed, refreshAll, refreshStatus]);
  useEffect(() => { try { localStorage.setItem('snw-list', listOpen ? '1' : '0'); } catch { /* storage unavailable */ } }, [listOpen]);

  // ⌘K / Ctrl+K opens the command bar from anywhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // Background work: check often while something is running, rarely otherwise.
  const running = jobs.some((j) => j.status === 'running');
  const loadJobs = useCallback(() => api<Job[]>('/jobs').then(setJobs).catch(() => {}), []);
  useEffect(() => {
    if (!authed) return;
    loadJobs();
    const t = setInterval(loadJobs, 120_000); // fallback; changes arrive live
    return () => clearInterval(t);
  }, [authed, loadJobs]);
  useLive('jobs', () => authed && loadJobs());
  useLive('memories', () => authed && refreshPending());
  // A chat got its real title (chatTitle.ts): refresh the list.
  useLive('chats', (d) => { if (authed && d.renamed) refreshChats(); });
  const finishedKey = jobs.filter((j) => j.finished_at).map((j) => j.id).join(',');

  const currentProject = view.kind === 'project' ? view.id : view.kind === 'chat' ? chats.find((c) => c.id === view.id)?.project_id ?? null : null;
  useEffect(() => { if (currentProject && !open.includes(currentProject)) setOpen((o) => [...o, currentProject]); }, [currentProject]);

  const go = (v: View) => { setView(v); setMobileNav(false); };
  // "Guided by N rules" under an answer opens the Memory page.
  useEffect(() => { const open = () => go({ kind: 'memory' }); window.addEventListener(OPEN_MEMORY, open); return () => window.removeEventListener(OPEN_MEMORY, open); }, []);
  useEffect(() => { const open = (e: Event) => { const id = (e as CustomEvent<string>).detail; refreshChats().then(() => go({ kind: 'chat', id })); }; window.addEventListener(OPEN_CHAT, open); return () => window.removeEventListener(OPEN_CHAT, open); }, []);
  const [build, setBuild] = useState<BuildProgress | null>(null);
  const workApi = useMemo(() => ({
    tab: work?.tab ?? null,
    open: (tab: WorkTab) => setWork((w) => (w?.tab === tab ? null : { tab })),
    show: (tab: WorkTab) => setWork((w) => (w?.tab === tab ? w : { ...w, tab })),
    preview: (html: string) => setWork({ tab: 'preview', html }),
    featuresQuery: (query: string) => setWork({ tab: 'features', query }),
    build: setBuild,
    close: () => setWork(null),
  }), [work?.tab]);
  // Leaving a Build chat takes its timeline with it.
  useEffect(() => { if (!build && work?.tab === 'build') setWork(null); }, [build, work?.tab]);

  const newChat = async (mode = 'explore', projectId: string | null = currentProject, text?: string, title?: string) => {
    const chat = await api<Chat>('/chats', { body: { mode, project_id: projectId } });
    // Chats started from a card get a human title (the idea), not the instructions Pip receives.
    if (title?.trim()) await api(`/chats/${chat.id}`, { method: 'PATCH', body: { title: title.trim().replace(/\s+/g, ' ').slice(0, 60) } }).catch(() => {});
    await refreshChats();
    if (text) setAutoSend({ chatId: chat.id, text });
    go({ kind: 'chat', id: chat.id });
  };
  const askPip = (text: string) => { setWork(null); newChat('explore', currentProject, text); };

  const removeChat = async (id: string) => {
    await api(`/chats/${id}`, { method: 'DELETE' });
    if (view.kind === 'chat' && view.id === id) setView({ kind: 'home' });
    refreshChats();
  };

  const createProject = async (name: string) => {
    setNaming(null);
    if (!name.trim()) return;
    const p = await api<Project>('/projects', { body: { name } });
    await refreshProjects();
    go({ kind: 'project', id: p.id });
  };

  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const chatRow = (c: Chat) => (
    <div key={c.id} className={`chat-item ${view.kind === 'chat' && view.id === c.id ? 'active' : ''}`}>
      <button className="chat-link" onClick={() => go({ kind: 'chat', id: c.id })}>
        <span className={`mode-dot mode-${c.mode}`} title={MODES[c.mode]} />
        <span className="chat-title">{c.title}</span>
      </button>
      <button className="icon-btn" title="Delete chat" onClick={() => confirm('Delete this chat?') && removeChat(c.id)}>×</button>
    </div>
  );
  const unfiled = chats.filter((c) => !c.project_id || !projects.some((p) => p.id === c.project_id));
  // Rail buttons carry a short visible label, so nothing is a guess.
  const railBtn = (label: string, d: string, active: boolean, onClick: () => void, badge?: number, short?: string) => (
    <button className={`rail-btn ${active ? 'on' : ''}`} onClick={onClick} title={label} aria-label={label}>
      <Icon d={d} />{!!badge && <span className="rail-badge">{badge}</span>}<span className="rail-label">{short ?? label}</span>
    </button>
  );

  const topTitle = view.kind === 'chat' ? chats.find((c) => c.id === view.id)?.title ?? 'Chat'
    : view.kind === 'project' ? projects.find((p) => p.id === view.id)?.name ?? 'Project'
    : view.kind === 'settings' ? 'Settings' : view.kind === 'memory' ? 'Memory' : 'Wayfinder';

  return (
    <WorkCtx.Provider value={workApi}>
      <div className={`shell2 ${listOpen ? 'list-open' : ''} ${work ? 'work-open' : ''} ${mobileNav ? 'mobile-nav' : ''}`}>
        <nav className="rail" aria-label="Main">
          <button className="rail-home" onClick={() => go({ kind: 'home' })} title="Home" aria-label="Home"><Pip size={30} still /></button>
          {railBtn('Chats and projects', I.chats, listOpen, () => setListOpen(!listOpen), undefined, 'Chats')}
          {railBtn('Investigation board: clues pinned while chasing a problem', I.board, work?.tab === 'board', () => { setMobileNav(false); workApi.open('board'); }, undefined, 'Board')}
          {railBtn('Out-of-the-box features on your instance', I.features, work?.tab === 'features', () => { setMobileNav(false); workApi.open('features'); }, undefined, 'Features')}
          {railBtn('Memory: what Pip has learned with you', I.memory, view.kind === 'memory', () => go({ kind: 'memory' }), pending, 'Memory')}
          <span className="rail-gap" />
          {railBtn('Search and jump (⌘K)', I.search, palette, () => { setMobileNav(false); setPalette(true); }, undefined, 'Search')}
          <WhatsNew onOpen={() => setMobileNav(false)} />
          {railBtn('Settings', I.settings, view.kind === 'settings', () => go({ kind: 'settings' }), undefined, 'Settings')}
        </nav>

        <aside className="list" aria-label="Chats and projects">
          <div className="list-head">
            <span className="brand-name">Wayfinder</span>
          </div>
          <button className="primary new-btn" onClick={() => go({ kind: 'home' })}>+ Start something new</button>
          {phone && status?.state === 'awake' && (
            <div className="drawer-tools">
              <DocsPicker instanceKey={status?.instanceId} />
              <UpdateSetPill instanceKey={status?.name ?? status?.instanceId} onOpenChat={(id) => go({ kind: 'chat', id })} />
            </div>
          )}
          <div className="chat-list">
            <div className="side-head">
              <span>Projects</span>
              <button className="icon-btn" title="New project" onClick={() => setNaming('')}>+</button>
            </div>
            {naming !== null && (
              <input className="side-input" autoFocus placeholder="Project name, then Enter" value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createProject(naming); if (e.key === 'Escape') setNaming(null); }}
                onBlur={() => (naming.trim() ? createProject(naming) : setNaming(null))} />
            )}
            {projects.map((p) => {
              const isOpen = open.includes(p.id);
              const mine = chats.filter((c) => c.project_id === p.id);
              return (
                <div key={p.id} className="project">
                  <div className={`chat-item project-row ${view.kind === 'project' && view.id === p.id ? 'active' : ''}`}>
                    <button className="icon-btn chev-btn" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => setOpen(isOpen ? open.filter((x) => x !== p.id) : [...open, p.id])}>{isOpen ? '▾' : '▸'}</button>
                    <button className="chat-link" onClick={() => go({ kind: 'project', id: p.id })}>
                      <span className="chat-title">{p.name}</span>
                      {!!mine.length && <span className="count">{mine.length}</span>}
                    </button>
                  </div>
                  {isOpen && <div className="project-chats">{mine.map(chatRow)}{!mine.length && <p className="muted tiny pad-l">No chats yet.</p>}</div>}
                </div>
              );
            })}
            {!projects.length && naming === null && <p className="muted small pad-l">Group chats, saved work and apps by goal.</p>}
            <div className="side-head"><span>Chats</span></div>
            {unfiled.map(chatRow)}
            {!unfiled.length && <p className="muted small pad-l">No chats yet.</p>}
          </div>
        </aside>

        <main className="main">
          <div className="topbar">
            <button className="icon-btn menu-btn" onClick={() => setMobileNav(!mobileNav)} aria-label="Menu" aria-expanded={mobileNav}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h10" /></svg>
            </button>
            {phone && <span className="top-title">{topTitle}</span>}
            {phone && view.kind !== 'home' && <button className="icon-btn top-new" onClick={() => go({ kind: 'home' })} aria-label="Start something new" title="Start something new">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </button>}
            <StatusBanner status={status} onRecheck={() => api<Status>('/status/check', { method: 'POST' }).then(setStatus)} onSettings={() => setView({ kind: 'settings' })} />
            <JobsBar jobs={jobs} />
            {!phone && <div className="head-tools">
              <DocsPicker instanceKey={status?.instanceId} />
              <UpdateSetPill instanceKey={status?.state === 'awake' ? (status?.name ?? status?.instanceId) : undefined} onOpenChat={(id) => go({ kind: 'chat', id })} />
              <button className="kbd-hint" onClick={() => setPalette(true)}>⌘K</button>
            </div>}
          </div>
          <div className="main-view">
            {view.kind === 'chat' && (
              <ChatView key={view.id} chatId={view.id} projects={projects} onChanged={refreshAll} reloadKey={finishedKey}
                autoSend={autoSend?.chatId === view.id ? autoSend.text : undefined} onAutoSent={() => setAutoSend(null)} voice={voice} />
            )}
            {view.kind === 'memory' && <MemoryView projects={projects} onChanged={refreshPending} />}
            {view.kind === 'project' && (
              <ProjectView key={view.id} projectId={view.id} reloadKey={finishedKey}
                onOpenChat={(id) => go({ kind: 'chat', id })} onNewChat={(mode) => newChat(mode, view.id)}
                onChanged={refreshAll} onDeleted={() => { refreshAll(); setView({ kind: 'home' }); }} />
            )}
            {view.kind === 'settings' && <SettingsView onInstanceChange={refreshStatus} onOpenChat={(id) => go({ kind: 'chat', id })} />}
            {view.kind === 'setup' && <SetupView onConnect={() => go({ kind: 'settings' })} onDone={() => go({ kind: 'home' })} />}
            {view.kind === 'home' && (
              <div className="home">
                <div className="home-pip">
                  <Pip size={84} state={running ? 'building' : 'idle'} track />
                  <div className="greet">
                    <div className="ver">Pip</div>
                    <p>{greeting ? <>{greeting.hello} {greeting.line}</> : '…'}</p>
                    {greeting?.action && (greeting.action.chatId || greeting.action.projectId) && (
                      <button className="link small" onClick={() => go(greeting.action!.chatId ? { kind: 'chat', id: greeting.action!.chatId } : { kind: 'project', id: greeting.action!.projectId! })}>{greeting.action.label} →</button>
                    )}
                  </div>
                </div>
                <div className="home-title">
                  <h1>What are we doing today?</h1>
                  {!!pulse?.items.length && <InsightsButton pulse={pulse} where={status?.name ?? 'your instance'} onPick={(mode, prompt, title) => newChat(mode, currentProject, prompt, title)} />}
                </div>
                <HomeStart onStart={(mode, text) => newChat(mode, currentProject, text, text)} canBuild={status?.can?.build ?? true} />
              </div>
            )}
          </div>
        </main>

        {mobileNav && <div className="scrim" onClick={() => setMobileNav(false)} aria-hidden />}
        {work && (
          <section className="work" aria-label="Work area">
            <div className="work-tabs">
              {(['build', 'preview', 'board', 'features'] as const).filter((t) => (t !== 'preview' || work.html) && (t !== 'build' || build)).map((t) => (
                <button key={t} className={work.tab === t ? 'on' : ''} onClick={() => setWork({ ...work, tab: t })}>{t === 'build' ? 'Build' : t === 'preview' ? 'Preview' : t === 'board' ? 'Board' : 'Features'}</button>
              ))}
            </div>
            {work.tab === 'build' && build && <BuildTimeline progress={build} onClose={() => setWork(null)} />}
            {work.tab === 'preview' && work.html && <PreviewPanel html={work.html} onClose={() => setWork(null)} />}
            {work.tab === 'board' && (
              <BoardPanel key={`${currentProject ?? ''}-${view.kind === 'chat' ? view.id : ''}`} projectId={currentProject}
                chatId={view.kind === 'chat' ? view.id : null}
                title={currentProject ? projects.find((p) => p.id === currentProject)?.name ?? 'project' : 'this chat'}
                onClose={() => setWork(null)} />
            )}
            {work.tab === 'features' && (
              <FeaturesPanel key={work.query ?? ''} initialQuery={work.query} canInstall={status?.can?.install ?? true} onClose={() => setWork(null)} onAsk={askPip}
                projectName={projects.find((p) => p.id === currentProject)?.name} />
            )}
          </section>
        )}

        {palette && (
          <CommandPalette chats={chats} projects={projects} onClose={() => setPalette(false)}
            onChat={(id) => go({ kind: 'chat', id })} onProject={(id) => go({ kind: 'project', id })}
            onNewChat={(mode) => newChat(mode)} onFeature={(q) => workApi.featuresQuery(q)}
            actions={[
              { id: 'home', label: 'Home: guided start', run: () => go({ kind: 'home' }) },
              { id: 'board', label: 'Open the board', run: () => setWork({ tab: 'board' }) },
              { id: 'features', label: 'Open features', run: () => setWork({ tab: 'features' }) },
              { id: 'memory', label: 'Memory', run: () => go({ kind: 'memory' }) },
              { id: 'settings', label: 'Settings', run: () => go({ kind: 'settings' }) },
              ...(view.kind === 'chat' ? [{ id: 'fresh', label: 'Continue this chat in a fresh one', run: () => api<{ id: string }>(`/chats/${view.id}/continue`, { method: 'POST' }).then((c) => window.dispatchEvent(new CustomEvent(OPEN_CHAT, { detail: c.id }))).catch(() => {}) }] : []),
              ...(status ? [{ id: 'pdi', label: `Open ${status.name || 'the instance'} in a new tab`, run: () => window.open(status.url, '_blank', 'noopener') }] : []),
            ]} />
        )}
      </div>
    </WorkCtx.Provider>
  );
}
