// Ghost text: when what you've typed starts a known suggestion (instance-aware starters, earlier messages in this
// chat), the rest shows faintly after the caret; → (or Tab) at the end of the text accepts it.
export function ghostFor(input: string, candidates: string[]): string {
  const typed = input.replace(/\s+$/, input.endsWith(' ') ? ' ' : '');
  if (typed.trim().length < 3 || input.includes('\n')) return '';
  const low = typed.toLowerCase();
  const hit = candidates.find((c) => c.length > typed.length && c.toLowerCase().startsWith(low));
  return hit ? hit.slice(typed.length) : '';
}

// Accept on → or Tab only when the caret is at the end and nothing is selected, so normal editing is untouched.
export function acceptGhost(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, ghost: string, set: (v: string) => void): boolean {
  if (!ghost || (e.key !== 'ArrowRight' && e.key !== 'Tab') || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
  const el = e.currentTarget;
  if (el.selectionStart !== el.value.length || el.selectionEnd !== el.value.length) return false;
  e.preventDefault();
  set(el.value + ghost);
  return true;
}

// The faint overlay: an invisible copy of the typed text, then the suggested rest.
export function GhostLayer({ input, ghost }: { input: string; ghost: string }) {
  if (!ghost) return null;
  return <div className="ghost-layer" aria-hidden><span className="ghost-typed">{input}</span><span className="ghost-rest">{ghost}</span><span className="ghost-key">→</span></div>;
}
