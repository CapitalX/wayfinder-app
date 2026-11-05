import { useEffect, useRef, useState } from 'react';

// Pip: the app's face. Two periwinkle dot eyes, a brow and a small mouth on a soft shape, drawn from the Wayfinder
// brand dot. It feels alive: its eyes follow your pointer and what you type, it blinks on its own (sometimes twice),
// glances around when idle, ponders over hard decisions and talks while it answers. Quiet presence keeps it still.
export type PipState = 'idle' | 'listening' | 'thinking' | 'pondering' | 'discovery' | 'building' | 'waiting' | 'talking' | 'success' | 'failure';

export const PIP_LABEL: Record<PipState, string> = {
  idle: 'Ready', listening: 'Listening', thinking: 'Thinking', pondering: 'Weighing it up', discovery: 'Found something',
  building: 'Building', waiting: 'Waiting on you', talking: 'Answering', success: 'Done', failure: 'Hit a problem',
};

// Presence: alive (default), still (no animation) or off (no character at all). Saved on the server so every device
// agrees; mirrored here so the face updates the moment it changes.
export type Presence = 'alive' | 'still' | 'off';
let presence: Presence = (() => { try { return (localStorage.getItem('snw-presence') as Presence) || 'alive'; } catch { return 'alive'; } })();
export const getPresence = () => presence;
export function setPresence(p: Presence) {
  presence = p;
  try { localStorage.setItem('snw-presence', p); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event('snw-presence'));
}
export function usePresence(): Presence {
  const [p, setP] = useState(presence);
  useEffect(() => {
    const on = () => setP(presence);
    window.addEventListener('snw-presence', on);
    return () => window.removeEventListener('snw-presence', on);
  }, []);
  return p;
}
// Kept for older callers: "quiet" now means still or off.
export const useQuiet = () => usePresence() !== 'alive';
export const setQuietPresence = (on: boolean) => setPresence(on ? 'still' : 'alive');
// The name shown beside answers: Pip, or the product when the character is off.
export const useAssistantName = () => (usePresence() === 'off' ? 'Wayfinder' : 'Pip');

// States where Pip looks somewhere on purpose; pointer tracking pauses for these.
const OWN_GAZE = new Set<PipState>(['thinking', 'pondering', 'building', 'success', 'failure']);
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Pip({ state = 'idle', size = 28, still = false, title, track = false, gaze }: {
  state?: PipState; size?: number; still?: boolean; title?: string;
  track?: boolean;                 // follow the pointer around the page
  gaze?: { x: number; y: number }; // look somewhere specific (-1..1), e.g. at the text being typed
}) {
  const mode = usePresence();
  const calm = still || mode !== 'alive' || reduced();
  const shown: PipState = calm && state !== 'failure' && state !== 'waiting' ? 'idle' : state;
  const ref = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const [boop, setBoop] = useState(0);
  const pointerAt = useRef(0);
  // Boop: click Pip and it scrunches its eyes, looks down, bounces up, then opens its eyes and blinks twice.
  const poke = () => {
    if (calm) return;
    setBoop((n) => n + 1);
    window.setTimeout(() => setBoop(0), 1250);
  };

  // Blink on a natural, uneven rhythm; now and then twice. Also blink once when the state changes.
  useEffect(() => {
    if (calm) return;
    let t: number;
    const once = (then?: () => void) => { setBlink(true); window.setTimeout(() => { setBlink(false); then?.(); }, 130); };
    const loop = () => {
      t = window.setTimeout(() => once(() => (Math.random() < 0.2 ? window.setTimeout(() => once(loop), 180) : loop())), 2600 + Math.random() * 3800);
    };
    loop();
    return () => window.clearTimeout(t);
  }, [calm]);
  const lastState = useRef(shown);
  useEffect(() => {
    if (calm || lastState.current === shown) return;
    lastState.current = shown;
    setBlink(true);
    const t = window.setTimeout(() => setBlink(false), 140);
    return () => window.clearTimeout(t);
  }, [shown, calm]);

  // Follow the pointer, within reach of the eyes.
  useEffect(() => {
    if (calm || !track) return;
    const move = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.max(1, Math.hypot(dx, dy));
      const reach = Math.min(1, d / 260);
      pointerAt.current = Date.now();
      setLook({ x: (dx / d) * reach, y: (dy / d) * reach });
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [calm, track]);

  // When nothing is moving, glance around now and then instead of staring.
  useEffect(() => {
    if (calm || shown !== 'idle' || gaze) return;
    const t = window.setInterval(() => {
      if (Date.now() - pointerAt.current < 3000) return;
      setLook(Math.random() < 0.45 ? { x: 0, y: 0 } : { x: Math.random() * 1.6 - 0.8, y: Math.random() * 0.8 - 0.4 });
    }, 3200);
    return () => window.clearInterval(t);
  }, [calm, shown, gaze]);

  if (mode === 'off') return null;
  const target = gaze ?? look;
  const eyes = calm || OWN_GAZE.has(shown) ? { x: 0, y: 0 } : { x: target.x * 3, y: target.y * 2.4 };

  return (
    <svg
      ref={ref}
      className={`pip pip-${shown} ${blink && !boop ? 'pip-blink' : ''} ${calm ? 'pip-calm' : ''} ${boop ? 'pip-boop' : ''}`}
      key={boop ? `boop-${boop}` : 'pip'}
      onPointerDown={poke}
      width={size}
      height={size}
      viewBox="0 0 56 56"
      role="img"
      aria-label={title ?? `Pip: ${PIP_LABEL[shown]}`}
    >
      <title>{title ?? `Pip · ${PIP_LABEL[shown]}`}</title>
      <circle className="pip-halo" cx="28" cy="28" r="27" />
      <g className="pip-whole">
        <rect className="pip-body" x="5" y="7" width="46" height="42" rx="19" />
        <g className="pip-look" style={{ transform: `translate(${eyes.x}px, ${eyes.y}px)` }}>
          <g className="pip-brows">
            <path className="pip-brow pip-brow-l" d="M15.5 19.5 L24 18.5" />
            <path className="pip-brow pip-brow-r" d="M32 18.5 L40.5 19.5" />
          </g>
          <g className="pip-eyes">
            <ellipse className="pip-eye" cx="20" cy="28" rx="3.3" ry="3.3" />
            <ellipse className="pip-eye" cx="36" cy="28" rx="3.3" ry="3.3" />
            <path className="pip-smile-eye" d="M16.5 29 Q20 24.5 23.5 29" />
            <path className="pip-smile-eye" d="M32.5 29 Q36 24.5 39.5 29" />
          </g>
          <path className="pip-mouth" d="M24.5 37.5 Q28 39.6 31.5 37.5" />
        </g>
      </g>
    </svg>
  );
}
