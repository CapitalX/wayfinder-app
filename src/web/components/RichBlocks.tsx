import { useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { QuestionsForm, parseQuestions } from './Questions.tsx';
import { inlineImage } from '../images.ts';
import { VIEWPORTS, type Device } from '../preview.ts';
import { parseScreen, renderScreen, type Screen } from '../screen.ts';
import { PreviewFrame, PreviewFullscreen } from './PreviewFrame.tsx';

// Structured content Pip can put in an answer, written as fenced blocks so they survive saving and streaming:
//   ```html      a live view (mockups render in place, sandboxed; Code tab shows the source)
//   ```cards     JSON [{ "title", "body", "meta", "tag", "href" }]
//   ```stats     JSON [{ "label", "value", "hint", "tone" }]
//   ```steps     JSON [{ "title", "body", "status": "done"|"now"|"todo" }]
//   ```callout   "tone: info|success|warn|danger" and optional "title: …" lines, a blank line, then markdown
//   ```columns   markdown sections separated by a line of ---
// Anything that doesn't parse (or is still streaming) falls back to the raw text, never an error.
//   ```questions an interview form (see Questions.tsx)
export const RICH = new Set(['html', 'screen', 'cards', 'stats', 'steps', 'callout', 'columns', 'questions']);

// Web images become a link: nothing is fetched until the user clicks.
export const MdImage = ({ src, alt }: { src?: string; alt?: string }) =>
  inlineImage(src) ? <img src={src} alt={alt ?? ''} /> : <a href={src} target="_blank" rel="noreferrer">{alt?.trim() || 'Image'} ↗</a>;
const md = (text: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>, img: MdImage as any }}>{text}</ReactMarkdown>;
const parseJson = <T,>(body: string): T | null => { try { const v = JSON.parse(body); return v as T; } catch { return null; } };
const raw = (body: string) => <pre className="output">{body}</pre>;

export function RichBlock({ lang, body, live, onPreview, actions }: { lang: string; body: string; live?: boolean; onPreview: (html: string) => void; actions?: ReactNode }) {
  switch (lang) {
    case 'html': return <HtmlView body={body} live={live} onPreview={onPreview} actions={actions} />;
    case 'screen': return <ScreenView body={body} live={live} onPreview={onPreview} actions={actions} />;
    case 'cards': {
      const items = parseJson<{ title: string; body?: string; meta?: string; tag?: string; href?: string }[]>(body);
      if (!Array.isArray(items)) return live ? <Drawing what="cards" /> : raw(body);
      return (
        <div className="rb-cards">
          {items.map((c, i) => {
            const inner = <>{c.tag && <span className="rb-tag">{c.tag}</span>}<strong>{c.title}</strong>{c.body && <div className="rb-body">{md(c.body)}</div>}{c.meta && <span className="rb-meta">{c.meta}</span>}</>;
            return c.href ? <a key={i} className="rb-card link-card" href={c.href} target="_blank" rel="noreferrer">{inner}</a> : <div key={i} className="rb-card">{inner}</div>;
          })}
        </div>
      );
    }
    case 'stats': {
      const items = parseJson<{ label: string; value: string | number; hint?: string; tone?: string }[]>(body);
      if (!Array.isArray(items)) return live ? <Drawing what="numbers" /> : raw(body);
      return <div className="rb-stats">{items.map((s, i) => <div key={i} className={`rb-stat tone-${s.tone ?? 'plain'}`}><span className="label">{s.label}</span><b>{String(s.value)}</b>{s.hint && <span className="muted tiny">{s.hint}</span>}</div>)}</div>;
    }
    case 'steps': {
      const items = parseJson<{ title: string; body?: string; status?: string }[]>(body);
      if (!Array.isArray(items)) return live ? <Drawing what="steps" /> : raw(body);
      return <ol className="rb-steps">{items.map((s, i) => <li key={i} className={`st-${s.status ?? 'todo'}`}><span className="rb-step-dot" /><div><strong>{s.title}</strong>{s.body && <div className="rb-body">{md(s.body)}</div>}</div></li>)}</ol>;
    }
    case 'callout': {
      const [head, ...rest] = body.split(/\n\s*\n/);
      const meta: Record<string, string> = {};
      const headLines = head.split('\n').filter((l) => /^\s*(tone|title)\s*:/i.test(l));
      for (const l of headLines) { const [k, ...v] = l.split(':'); meta[k.trim().toLowerCase()] = v.join(':').trim(); }
      const text = headLines.length === head.split('\n').length ? rest.join('\n\n') : body;
      return <div className={`rb-callout tone-${meta.tone ?? 'info'}`}>{meta.title && <strong>{meta.title}</strong>}{md(text)}</div>;
    }
    case 'columns': {
      const cols = body.split(/\n-{3,}\n/).map((c) => c.trim()).filter(Boolean);
      return <div className="rb-columns" style={{ gridTemplateColumns: `repeat(${Math.min(cols.length, 3)}, minmax(0, 1fr))` }}>{cols.map((c, i) => <div key={i} className="rb-col md">{md(c)}</div>)}</div>;
    }
    case 'questions': {
      const set = parseQuestions(body);
      if (!set) return live ? <Drawing what="questions" /> : raw(body);
      return <QuestionsForm set={set} />;
    }
    default: return raw(body);
  }
}

const Drawing = ({ what }: { what: string }) => <div className="rb-drawing"><span className="thinking"><span /><span /><span /></span> Drawing the {what}…</div>;

// A screen spec (```screen): checked, then drawn by the screen kit at the viewport it names. A spec the kit can't draw
// shows exactly what's wrong instead of a half-right picture.
function ScreenView({ body, live, onPreview, actions }: { body: string; live?: boolean; onPreview: (html: string) => void; actions?: ReactNode }) {
  const [tab, setTab] = useState<'view' | 'spec'>('view');
  const [full, setFull] = useState(false);
  const [device, setDevice] = useState<Device | null>(null);
  const parsed = useMemo(() => (live ? null : parseScreen(body)), [body, live]);
  const html = useMemo(() => (parsed && 'spec' in parsed ? renderScreen(parsed.spec) : null), [parsed]);
  if (live || !parsed) return <div className="rb-html"><div className="rb-html-head"><span className="spec-kicker">Screen</span></div><Drawing what="screen" /></div>;
  if (!html || !('spec' in parsed)) return (
    <div className="rb-html screen-bad">
      <div className="rb-html-head"><span className="spec-kicker">Screen</span><strong>The screen kit can't draw this</strong></div>
      <ul className="small">{'problems' in parsed && parsed.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      <pre className="rb-code"><code>{body}</code></pre>
    </div>
  );
  const spec: Screen = parsed.spec;
  const shown = device ?? spec.viewport;
  return (
    <div className="rb-html">
      <div className="rb-html-head">
        <span className="spec-kicker">Screen · {spec.title}</span>
        <div className="seg">
          <button className={tab === 'view' ? 'on' : ''} onClick={() => setTab('view')}>View</button>
          <button className={tab === 'spec' ? 'on' : ''} onClick={() => setTab('spec')}>Spec</button>
        </div>
        {tab === 'view' && (
          <div className="seg" role="group" aria-label="Device">
            {(Object.keys(VIEWPORTS) as Device[]).map((d) => <button key={d} className={shown === d ? 'on' : ''} onClick={() => setDevice(d)} title={`${VIEWPORTS[d].w} × ${VIEWPORTS[d].h}`}>{VIEWPORTS[d].label}</button>)}
          </div>
        )}
        <span className="code-actions">
          <button className="link" onClick={() => setFull(true)}>Full screen</button>
          <button className="link" onClick={() => onPreview(html)}>Expand</button>
          {actions}
        </span>
      </div>
      {tab === 'view'
        ? <PreviewFrame html={html} device={shown} zoom="fit" fit="width" title={`Screen: ${spec.title}`} />
        : <pre className="rb-code"><code>{JSON.stringify(spec, null, 2)}</code></pre>}
      {full && <PreviewFullscreen html={html} device={shown} onClose={() => setFull(false)} />}
    </div>
  );
}

// A live HTML view: drawn in place at a real device size and scaled to the chat's width, in a sandboxed frame with no
// access to the app, its cookies or the network. The source is a tab away; Expand opens it in the work area and Full
// screen fills the window. While the answer is still streaming it shows a placeholder, not half a page.
function HtmlView({ body, live, onPreview, actions }: { body: string; live?: boolean; onPreview: (html: string) => void; actions?: ReactNode }) {
  const [tab, setTab] = useState<'view' | 'code'>('view');
  const [device, setDevice] = useState<Device>('desktop');
  const [full, setFull] = useState(false);
  if (live) return <div className="rb-html"><div className="rb-html-head"><span className="spec-kicker">Live view</span></div><Drawing what={`view (${Math.round(body.length / 100) / 10} KB so far)`} /></div>;
  return (
    <div className="rb-html">
      <div className="rb-html-head">
        <span className="spec-kicker">Live view</span>
        <div className="seg">
          <button className={tab === 'view' ? 'on' : ''} onClick={() => setTab('view')}>View</button>
          <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>Code</button>
        </div>
        {tab === 'view' && (
          <div className="seg" role="group" aria-label="Device">
            {(Object.keys(VIEWPORTS) as Device[]).map((d) => <button key={d} className={device === d ? 'on' : ''} onClick={() => setDevice(d)} title={`${VIEWPORTS[d].w} × ${VIEWPORTS[d].h}`}>{VIEWPORTS[d].label}</button>)}
          </div>
        )}
        <span className="code-actions">
          <button className="link" onClick={() => setFull(true)}>Full screen</button>
          <button className="link" onClick={() => onPreview(body)}>Expand</button>
          {actions}
        </span>
      </div>
      {tab === 'view'
        ? <PreviewFrame html={body} device={device} zoom="fit" fit="width" title="Live view" />
        : <pre className="rb-code"><code>{body}</code></pre>}
      {full && <PreviewFullscreen html={body} device={device} onClose={() => setFull(false)} />}
    </div>
  );
}
