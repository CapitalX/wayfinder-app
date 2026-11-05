import { useContext, useState } from 'react';
import { api, type ShowField, type ShowSnapshot } from '../api.ts';
import { BlockCtx } from './Blocks.tsx';

// A picture of something on the PDI: a record, its form or a list. It says when and where it was taken and what
// it leaves out, and links to the live page, because UI policies and scripts can change what the real form shows.
export function ShowCard({ snap, onPreview }: { snap: ShowSnapshot; onPreview: (html: string) => void }) {
  const { chatId } = useContext(BlockCtx);
  const [pinned, setPinned] = useState(false);
  // Pin it to the investigation board as evidence, with the key fields and the live link.
  const pin = async () => {
    const fields = snap.fields ?? snap.sections?.flatMap((s) => [...(s.top ?? []), ...s.columns.flat(), ...(s.full ?? [])]) ?? [];
    const detail = snap.kind === 'list'
      ? `${snap.total ?? snap.rows?.length ?? 0} records${snap.query ? ` where ${snap.query}` : ''}`
      : fields.filter((f) => f.display || f.value).slice(0, 8).map((f) => `${f.label}: ${f.display || f.value}`).join('\n');
    await api('/board', { body: { chat_id: chatId, kind: 'record', title: `${snap.table_label}: ${snap.title}`, detail: `${detail}\n(as of ${new Date(snap.as_of).toLocaleString()} from ${snap.instance})`, link: snap.link } });
    setPinned(true);
  };
  const when = new Date(snap.as_of).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="show-card">
      <div className="show-head">
        <span className="spec-kicker">{snap.kind === 'list' ? 'List' : snap.kind === 'form' ? 'Form' : 'Record'} · {snap.table_label}</span>
        <strong>{snap.title}</strong>
        {snap.query && <code className="show-query">{snap.query}</code>}
      </div>
      {snap.kind === 'record' && <Fields fields={snap.fields ?? []} />}
      {snap.kind === 'form' && snap.sections?.map((s, i) => (
        <div key={i} className="show-section">
          {snap.sections!.length > 1 && <div className="label">{s.caption}</div>}
          {s.top && <Fields fields={s.top} />}
          {!!s.columns.length && (
            <div className="show-cols" style={{ gridTemplateColumns: `repeat(${Math.min(s.columns.length, 2)}, minmax(0, 1fr))` }}>
              {s.columns.slice(0, 2).map((col, j) => <Fields key={j} fields={col} />)}
            </div>
          )}
          {s.full && <Fields fields={s.full} />}
        </div>
      ))}
      {snap.kind === 'list' && (
        <div className="show-list">
          <table>
            <thead><tr>{snap.columns?.map((c) => <th key={c.name}>{c.label}</th>)}</tr></thead>
            <tbody>
              {snap.rows?.map((r) => <tr key={r.sys_id}>{snap.columns?.map((c) => <td key={c.name}>{r.cells[c.name]}</td>)}</tr>)}
              {!snap.rows?.length && <tr><td colSpan={snap.columns?.length ?? 1} className="muted">No records match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="show-foot">
        <span className="ver">As of {when} from {snap.instance}{snap.total !== undefined ? ` · ${snap.total} total` : ''}</span>
        <span className="row-actions">
          {chatId && <button className="link" onClick={pin} disabled={pinned}>{pinned ? 'Pinned' : 'Pin to board'}</button>}
          <button className="link" onClick={() => onPreview(toHtml(snap))}>Expand</button>
          <a className="link" href={snap.link} target="_blank" rel="noreferrer">Open live on PDI ↗</a>
        </span>
      </div>
      {!!snap.omitted.length && <p className="muted tiny">Not shown: {snap.omitted.join('; ')}.</p>}
    </div>
  );
}

function Fields({ fields }: { fields: ShowField[] }) {
  return (
    <div className="show-fields">
      {fields.map((f) => (
        <div key={f.name} className="show-field" title={f.name}>
          <span className="show-label">{f.label}</span>
          <span className="show-value">{f.display || f.value || <span className="muted">empty</span>}</span>
        </div>
      ))}
    </div>
  );
}

// The same snapshot as a standalone page in the classic ServiceNow form/list style, for the preview panel.
function toHtml(s: ShowSnapshot): string {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const field = (f: ShowField) => `<div class="f"><label>${esc(f.label)}</label><div class="v">${esc(f.display || f.value || '')}</div></div>`;
  let body = '';
  if (s.kind === 'list') {
    body = `<table><thead><tr>${s.columns!.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${s.rows!.map((r) => `<tr>${s.columns!.map((c) => `<td>${esc(r.cells[c.name] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  } else if (s.kind === 'form') {
    const wide = (fs?: ShowField[]) => (fs?.length ? `<div class="wide">${fs.map(field).join('')}</div>` : '');
    body = s.sections!.map((sec) => `<section><h3>${esc(sec.caption)}</h3>${wide(sec.top)}<div class="cols">${sec.columns.slice(0, 2).map((c) => `<div>${c.map(field).join('')}</div>`).join('')}</div>${wide(sec.full)}</section>`).join('');
  } else body = `<section><div class="cols"><div>${(s.fields ?? []).map(field).join('')}</div></div></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.title)}</title><style>
body{margin:0;font:13px/1.4 "Source Sans Pro",Arial,sans-serif;background:#fff;color:#293e40}
header{background:#293e40;color:#fff;padding:10px 16px;display:flex;gap:10px;align-items:baseline}
header b{font-size:15px}header span{opacity:.7}
main{padding:16px 20px}section{margin-bottom:18px}h3{font-size:14px;border-bottom:1px solid #ddd;padding-bottom:4px;margin:0 0 10px}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 32px}
.f{display:grid;grid-template-columns:38% 1fr;gap:10px;align-items:center;margin:6px 0}.wide .f{grid-template-columns:18.2% 1fr}
label{text-align:right;color:#485563}.v{border:1px solid #cbcbcb;border-radius:3px;padding:5px 8px;min-height:18px;background:#fff;word-break:break-word}
table{border-collapse:collapse;width:100%}th{text-align:left;background:#f6f6f6;border-bottom:2px solid #ddd;padding:6px 8px}td{border-bottom:1px solid #eee;padding:6px 8px}
footer{color:#888;font-size:12px;padding:0 20px 16px}
</style></head><body><header><b>${esc(s.table_label)}</b><span>${esc(s.title)}</span></header><main>${body}</main>
<footer>Snapshot from ${esc(s.instance)} at ${esc(new Date(s.as_of).toLocaleString())}. Not shown: ${esc(s.omitted.join('; ') || 'nothing')}.</footer></body></html>`;
}
