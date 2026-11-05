import { useContext, useState } from 'react';
import { AutoTextarea } from './AutoTextarea.tsx';
import { BlockCtx } from './Blocks.tsx';

// Pip's interview as a form: chips for choices, a box for free text, yes/no toggles, defaults preselected, and quick
// exits ("Use what's built in", "Just build it"). Submit sends one plain message with every answer. On older
// messages (or while Pip is still talking) the form is read-only.
//   ```questions  JSON { "title", "questions": [{ "id", "text", "kind": "choice|multi|text|yesno", "options", "default", "why" }],
//                         "exits": [{ "label", "reply" }] }
type Q = { id: string; text: string; kind?: 'choice' | 'multi' | 'text' | 'yesno'; options?: string[]; default?: string | string[] | boolean; why?: string };
type Exit = { label: string; reply?: string } | string;
export type QuestionSet = { title?: string; questions: Q[]; exits?: Exit[] };

export function parseQuestions(body: string): QuestionSet | null {
  try {
    const v = JSON.parse(body);
    const set: QuestionSet = Array.isArray(v) ? { questions: v } : v;
    return Array.isArray(set?.questions) && set.questions.every((q) => q && typeof q.text === 'string') ? set : null;
  } catch { return null; }
}

const initial = (q: Q): string | string[] => {
  if (q.kind === 'multi') return Array.isArray(q.default) ? q.default : [];
  if (q.kind === 'yesno') return q.default === true || q.default === 'yes' ? 'Yes' : q.default === false || q.default === 'no' ? 'No' : '';
  return typeof q.default === 'string' ? q.default : '';
};

export function formatAnswers(set: QuestionSet, answers: Record<string, string | string[]>, notes: Record<string, string>) {
  const lines = set.questions.map((q, i) => {
    const a = answers[q.id ?? String(i)];
    const val = Array.isArray(a) ? (a.length ? a.join(', ') : '(none)') : a?.trim() || '(your call)';
    const note = notes[q.id ?? String(i)]?.trim();
    return `- ${q.text} → ${val}${note ? ` (${note})` : ''}`;
  });
  return `My answers:\n${lines.join('\n')}`;
}

export function QuestionsForm({ set }: { set: QuestionSet }) {
  const { onReply } = useContext(BlockCtx);
  const key = (q: Q, i: number) => q.id ?? String(i);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => Object.fromEntries(set.questions.map((q, i) => [key(q, i), initial(q)])));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState(false);
  const active = !!onReply && !sent;
  const set1 = (k: string, v: string | string[]) => setAnswers((a) => ({ ...a, [k]: v }));
  const toggle = (k: string, opt: string) => setAnswers((a) => {
    const cur = Array.isArray(a[k]) ? a[k] as string[] : [];
    return { ...a, [k]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt] };
  });
  const submit = () => { if (!onReply) return; setSent(true); onReply(formatAnswers(set, answers, notes), true); };
  const exits = (set.exits ?? []).map((e) => typeof e === 'string' ? { label: e, reply: e } : { label: e.label, reply: e.reply ?? e.label });

  return (
    <form className={`qform ${active ? '' : 'readonly'}`} onSubmit={(e) => { e.preventDefault(); if (active) submit(); }}>
      {set.title && <div className="qform-title">{set.title}</div>}
      {set.questions.map((q, i) => {
        const k = key(q, i);
        const a = answers[k];
        const kind = q.kind ?? (q.options?.length ? 'choice' : 'text');
        const opts = kind === 'yesno' ? ['Yes', 'No'] : q.options ?? [];
        return (
          <fieldset key={k} className="q" disabled={!active}>
            <legend>{q.text}</legend>
            {q.why && <div className="muted tiny">{q.why}</div>}
            {kind === 'text'
              ? <AutoTextarea value={typeof a === 'string' ? a : ''} placeholder="Type an answer, or leave it to Pip" label={q.text} onChange={(v) => set1(k, v)} maxRows={4} />
              : <div className="q-chips" role={kind === 'multi' ? 'group' : 'radiogroup'}>
                  {opts.map((o) => {
                    const on = Array.isArray(a) ? a.includes(o) : a === o;
                    return <button type="button" key={o} className={`qchip ${on ? "on" : ""}`} aria-pressed={on}
                      onClick={() => kind === 'multi' ? toggle(k, o) : set1(k, on ? '' : o)}>{o}</button>;
                  })}
                  {active && !noteOpen[k] && <button type="button" className="link small" onClick={() => setNoteOpen((n) => ({ ...n, [k]: true }))}>+ note</button>}
                </div>}
            {noteOpen[k] && <AutoTextarea className="q-note" autoFocus value={notes[k] ?? ''} placeholder="Anything to add?" maxRows={4} onChange={(v) => setNotes((n) => ({ ...n, [k]: v }))} />}
          </fieldset>
        );
      })}
      {active
        ? <div className="qform-actions">
            <button type="submit" className="primary">Send answers</button>
            {exits.map((e) => <button type="button" key={e.label} onClick={() => { setSent(true); onReply!(e.reply, true); }}>{e.label}</button>)}
            <span className="muted tiny">Enter sends · blanks are Pip's call</span>
          </div>
        : sent ? <div className="muted tiny">Answers sent.</div> : null}
    </form>
  );
}
