import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { inferMode, type HomeMode } from '../route.ts';
import { GhostLayer, acceptGhost, ghostFor } from './Ghost.tsx';
import { ICON } from './icons.tsx';

// The home screen's one way in: a box, the modes as small buttons under it (Auto guesses from the text), and three
// example prompts for the selected mode that fill the box to edit. If Auto guesses Build, a one-line check asks before
// a (slow) build chat starts; picking Build yourself skips it, and Pip still shows a plan before building anything.
const MODES: { id: 'auto' | HomeMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Pip picks the mode from what you write' },
  { id: 'build', label: 'Build', hint: 'Plan, build and install a scoped app' },
  { id: 'explore', label: 'Learn', hint: 'How it works, with docs and live records' },
  { id: 'mockup', label: 'Mockup', hint: 'A live preview of a form, list, workspace or portal page' },
  { id: 'decide', label: 'Decide', hint: 'Options, trade-offs and one recommendation' },
  { id: 'debug', label: 'Debug', hint: 'Read-only checks, clues pinned to the board' },
];
const NAME: Record<HomeMode, string> = { build: 'Build', explore: 'Learn', mockup: 'Mockup', decide: 'Decide', debug: 'Debug' };
const PLACEHOLDER: Record<string, string> = {
  auto: 'Ask, describe an app, or paste an error…', build: 'Describe the app: who uses it, what it tracks, the rules…',
  explore: 'What do you want to learn?', mockup: 'Which screen, and who uses it?', decide: 'What are you deciding?', debug: 'What’s going wrong? A record number or error helps',
};

type Example = { label: string; text: string; why?: string };

export function HomeStart({ onStart, canBuild = true }: { onStart: (mode: HomeMode, text: string) => void; canBuild?: boolean }) {
  const [mode, setMode] = useState<'auto' | HomeMode>(() => { try { return (localStorage.getItem('snw-home-mode') as any) || 'auto'; } catch { return 'auto'; } });
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [examples, setExamples] = useState<Example[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try { localStorage.setItem('snw-home-mode', mode); } catch { /* storage unavailable */ }
    setExamples(null);
    const want = mode === 'auto' ? (['build', 'explore', 'debug'] as const) : [mode];
    Promise.all(want.map((m) => api<Example[]>(`/suggestions?mode=${m}`).catch(() => [] as Example[])))
      .then((lists) => setExamples(mode === 'auto' ? lists.map((l) => l[0]).filter(Boolean) : lists[0].slice(0, 3)));
  }, [mode]);

  const guess = text.trim().length >= 6 ? inferMode(text) : null;
  const ghost = focused ? ghostFor(text, (examples ?? []).map((e) => e.text)) : '';
  const go = (m: HomeMode) => { const t = text.trim(); if (!t) return; setConfirm(false); onStart(m, t); setText(''); };
  const submit = () => {
    if (!text.trim()) return;
    if (mode !== 'auto') return go(mode);
    if (guess === 'build') return setConfirm(true);
    go(guess ?? 'explore');
  };
  const fill = (t: string) => { setText(t); setConfirm(false); setTimeout(() => { box.current?.focus(); box.current?.setSelectionRange(t.length, t.length); }, 0); };

  return (
    <div className="home-start">
      <div className="composer-box home-box">
        <div className="ghost-wrap">
          <GhostLayer input={text} ghost={ghost} />
          <textarea ref={box} autoFocus rows={2} value={text} placeholder={PLACEHOLDER[mode]} aria-label="What are we doing?"
            onChange={(e) => { setText(e.target.value); setConfirm(false); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (acceptGhost(e, ghost, setText)) return;
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            }} />
        </div>
        <button className="round primary" disabled={!text.trim()} onClick={submit} title="Start" aria-label="Start">{ICON.send}</button>
      </div>

      <div className="home-modes" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} className={`mode-pick ${mode === m.id ? 'on' : ''}`} title={m.hint} onClick={() => { setMode(m.id); setConfirm(false); box.current?.focus(); }}>{m.label}</button>
        ))}
        <span className="muted tiny home-guess">{mode === 'auto' && guess ? `→ ${NAME[guess]}` : MODES.find((m) => m.id === mode)?.hint}</span>
      </div>
      {mode === 'build' && !canBuild && <p className="muted small">Your account can't install apps on this instance, so Pip will plan and build it here; an admin installs it.</p>}

      {confirm && (
        <div className="home-confirm" role="alert">
          <span>Sounds like an app. Plan a build, or look at options first?</span>
          <button className="primary" autoFocus onClick={() => go('build')}>Plan an app</button>
          <button onClick={() => go('explore')}>Explore options first</button>
        </div>
      )}

      <div className="home-examples">
        {examples === null ? <span className="muted small">Looking at your instance…</span>
          : examples.map((e) => <button key={e.label} className="pill" title={e.why ? `Because: ${e.why}` : e.text} onClick={() => fill(e.text)}>{e.label}</button>)}
      </div>
    </div>
  );
}
