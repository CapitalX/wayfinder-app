import { useLayoutEffect, useRef } from 'react';

// A text box for sentences: grows from one line up to maxRows as you type, Enter adds a line, and ⌘/Ctrl+Enter
// submits (with a hint saying so). Used wherever people type a sentence rather than a name.
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const SUBMIT_KEYS = MAC ? '⌘ Enter' : 'Ctrl Enter';

export function AutoTextarea({ value, onChange, onSubmit, submitHint, placeholder, maxRows = 6, className = '', autoFocus, label, disabled }: {
  value: string; onChange: (v: string) => void; onSubmit?: () => void; submitHint?: string; placeholder?: string; maxRows?: number;
  className?: string; autoFocus?: boolean; label?: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    const max = line * maxRows + pad;
    el.style.height = `${Math.min(el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), max)}px`;
    el.style.overflowY = el.scrollHeight + pad > max + 1 ? 'auto' : 'hidden';
  }, [value, maxRows]);
  return (
    <span className={`auto-ta ${className}`}>
      <textarea ref={ref} rows={1} value={value} placeholder={placeholder} autoFocus={autoFocus} aria-label={label ?? placeholder} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); } }} />
      {onSubmit && submitHint && <span className="ta-hint muted tiny">{SUBMIT_KEYS} {submitHint}</span>}
    </span>
  );
}
