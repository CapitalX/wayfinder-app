import { z } from 'zod';

// Screen specs: Pip describes a screen as data (a ```screen block) and this kit draws it, so every mockup gets the same
// navigation, type, spacing, tables, fields, tabs, actions and loading/empty/error states. Pip chooses components,
// content and relationships; the renderer owns the look. Kit 1 draws one template well: a Next Experience-style
// list/detail workspace. Anything the kit doesn't support is rejected with a plain reason, never drawn half right.
// Free-form ```html stays available as an explicit concept mode.

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'ids are short lowercase names like "list" or "f_serial"');
const text = (max = 120) => z.string().max(max);
const state = z.enum(['ready', 'loading', 'empty', 'error']).default('ready');

const field = z.object({
  id, label: text(60), value: text(400).default(''),
  type: z.enum(['string', 'text', 'reference', 'choice', 'date', 'datetime', 'boolean', 'number', 'currency', 'email', 'url']).default('string'),
  mandatory: z.boolean().default(false), readonly: z.boolean().default(false),
  choices: z.array(text(60)).max(20).optional(),
}).strict();

const section = z.object({ id, label: text(60).optional(), columns: z.union([z.literal(1), z.literal(2)]).default(2), fields: z.array(field).min(1).max(24) }).strict();
const activity = z.object({ who: text(60), when: text(40), text: text(600) }).strict();
const tab = z.object({
  id, label: text(40),
  sections: z.array(section).max(6).optional(),
  activity: z.array(activity).max(20).optional(),
}).strict().refine((t) => !!t.sections !== !!t.activity, { message: 'a tab has either sections (fields) or activity, not both or neither' });

const action = z.object({ id, label: text(30), primary: z.boolean().default(false), danger: z.boolean().default(false) }).strict();
const column = z.object({ field: z.string().regex(/^[a-z0-9_.]{1,60}$/, 'column field must be a field name'), label: text(40), width: z.number().int().min(60).max(480).optional() }).strict();

export const SCREEN = z.object({
  kit: z.literal('workspace-list-detail@1'),
  title: text(60),
  surface: z.literal('workspace'),
  release: text(30).default('Next Experience'),
  theme: z.enum(['light', 'dark']).default('light'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  viewport: z.enum(['desktop', 'tablet', 'phone']).default('desktop'),
  assumptions: z.array(text(200)).max(8).default([]),
  simulated: z.array(text(200)).max(8).default([]),
  nav: z.object({
    id, items: z.array(z.object({ id, label: text(40), count: z.number().int().min(0).max(99999).optional(), active: z.boolean().default(false) }).strict()).min(1).max(12),
  }).strict(),
  list: z.object({
    id, title: text(60), columns: z.array(column).min(1).max(8),
    rows: z.array(z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()]))).max(50).default([]),
    selected: z.number().int().min(0).optional(), state, empty_text: text(160).optional(), error_text: text(200).optional(),
  }).strict(),
  record: z.object({
    id, title: text(80), subtitle: text(120).optional(), actions: z.array(action).max(6).default([]),
    tabs: z.array(tab).min(1).max(6), active_tab: id.optional(), state, error_text: text(200).optional(),
  }).strict(),
}).strict();

export type Screen = z.infer<typeof SCREEN>;
type Field = z.infer<typeof field>;

// What a ```screen block says, checked. Problems name the exact place, e.g. "record.tabs.0.charts: not supported".
export function parseScreen(body: string): { spec: Screen } | { problems: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch (e) { return { problems: [`Not valid JSON: ${(e as Error).message}`] }; }
  const r = SCREEN.safeParse(raw);
  if (!r.success) return { problems: r.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || 'screen'}: ${i.code === 'unrecognized_keys' ? `not supported by this kit (${(i as { keys: string[] }).keys.join(', ')})` : i.message}`) };
  const s = r.data;
  const problems: string[] = [];
  const ids = [s.nav.id, s.list.id, s.record.id, ...s.nav.items.map((i) => i.id), ...s.record.actions.map((a) => a.id),
    ...s.record.tabs.flatMap((t) => [t.id, ...(t.sections ?? []).flatMap((sec) => [sec.id, ...sec.fields.map((f) => f.id)])])];
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) problems.push(`ids must be unique (repeated: ${[...new Set(dup)].join(', ')}), so revisions can target one part`);
  if (s.record.active_tab && !s.record.tabs.some((t) => t.id === s.record.active_tab)) problems.push(`record.active_tab: no tab "${s.record.active_tab}"`);
  if (s.list.selected !== undefined && s.list.selected >= s.list.rows.length) problems.push('list.selected: no row at that position');
  const known = new Set(s.list.columns.map((c) => c.field));
  for (const [i, row] of s.list.rows.entries()) for (const k of Object.keys(row)) if (!known.has(k)) { problems.push(`list.rows.${i}: "${k}" isn't one of the columns`); break; }
  return problems.length ? { problems } : { spec: s };
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// The kit's look: one stylesheet for every screen, light or dark, comfortable or compact. Phone and tablet stack the
// panes. System fonts only (previews load nothing from the network).
const CSS = `
:root{--bg:#f4f5f7;--panel:#fff;--line:#d9dde3;--text:#1b1f24;--muted:#5d6670;--accent:#0b6bcb;--accent-soft:#e6f0fb;--bar:#1f2b33;--bar-text:#eef2f5;--danger:#b42318;--warn:#fff4e5;--pad:12px;--row:36px;--fs:14px}
.dark{--bg:#14181c;--panel:#1c2126;--line:#2e353c;--text:#e8ecef;--muted:#9aa4ad;--accent:#5aa3ff;--accent-soft:#1d2d40;--bar:#0e1215;--warn:#3a2c12}
.compact{--pad:8px;--row:30px;--fs:13px}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:var(--fs)/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
.ws{display:grid;grid-template-rows:48px auto 1fr;height:100%}
.bar{display:flex;align-items:center;gap:16px;padding:0 16px;background:var(--bar);color:var(--bar-text)}
.bar b{font-size:15px}.bar .sp{flex:1}.bar .chip{font-size:11px;border:1px solid #ffffff40;border-radius:99px;padding:2px 8px;opacity:.85}
.note{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:6px 16px;background:var(--warn);color:var(--text);font-size:12px;border-bottom:1px solid var(--line)}
.body{display:grid;grid-template-columns:220px minmax(280px,1fr) minmax(360px,1.4fr);min-height:0}
nav{background:var(--panel);border-right:1px solid var(--line);padding:var(--pad) 0;overflow:auto}
nav a{display:flex;justify-content:space-between;gap:10px;padding:8px 16px;color:var(--text);text-decoration:none;border-left:3px solid transparent}
nav a.on{background:var(--accent-soft);border-left-color:var(--accent);font-weight:600}nav .n{color:var(--muted);font-size:12px}
.pane{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line);background:var(--panel)}
.ph{display:flex;align-items:center;gap:8px;padding:var(--pad) 16px;border-bottom:1px solid var(--line);min-height:48px}
.ph h1,.ph h2{margin:0;font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ph .sub{color:var(--muted);font-size:12px}
.ph .acts{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.btn{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:6px;padding:5px 12px}
.btn.p{background:var(--accent);border-color:var(--accent);color:#fff}.btn.d{color:var(--danger);border-color:var(--danger)}
.scroll{overflow:auto;min-height:0;flex:1}
table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;padding:0 12px;height:var(--row);border-bottom:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}tr.sel td{background:var(--accent-soft)}td:first-child{color:var(--accent)}
.tabs{display:flex;gap:4px;padding:0 16px;border-bottom:1px solid var(--line)}.tabs span{padding:10px 8px;color:var(--muted);border-bottom:2px solid transparent}.tabs span.on{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.sec{padding:var(--pad) 16px}.sec h3{margin:4px 0 10px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px}.grid.one{grid-template-columns:1fr}
.f label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}.f label .m{color:var(--danger)}
.f .v{border:1px solid var(--line);border-radius:6px;padding:6px 8px;min-height:32px;background:var(--panel);overflow-wrap:anywhere}.f .v.ro{background:var(--bg)}.f .v.ref{color:var(--accent)}.f .v.txt{min-height:64px;white-space:pre-wrap}
.act{padding:var(--pad) 16px;border-bottom:1px solid var(--line)}.act b{font-size:13px}.act .w{color:var(--muted);font-size:12px;margin-left:6px}.act p{margin:4px 0 0;white-space:pre-wrap}
.st{padding:32px 16px;text-align:center;color:var(--muted)}.st.err{color:var(--danger)}
.sk{height:12px;border-radius:6px;background:linear-gradient(90deg,var(--line),var(--bg),var(--line));margin:12px 16px}
@media (max-width:1000px){.body{grid-template-columns:1fr;grid-template-rows:auto auto 1fr}nav{display:flex;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:0}nav a{border-left:0;border-bottom:3px solid transparent;white-space:nowrap}nav a.on{border-bottom-color:var(--accent)}.pane{border-right:0;border-bottom:1px solid var(--line)}.grid{grid-template-columns:1fr}}
`;

const stateHtml = (st: string, emptyText?: string, errorText?: string) =>
  st === 'loading' ? '<div class="sk" style="width:70%"></div><div class="sk"></div><div class="sk" style="width:55%"></div><div class="st">Loading…</div>'
    : st === 'empty' ? `<div class="st">${esc(emptyText || 'No records to show.')}</div>`
      : st === 'error' ? `<div class="st err">${esc(errorText || 'Something went wrong loading this.')}</div>` : '';

function fieldHtml(f: Field) {
  const val = f.type === 'boolean' ? (/^(true|yes|1)$/i.test(f.value) ? '☑ Yes' : '☐ No') : f.value;
  const cls = ['v', f.readonly ? 'ro' : '', f.type === 'reference' ? 'ref' : '', f.type === 'text' ? 'txt' : ''].filter(Boolean).join(' ');
  return `<div class="f" data-id="${esc(f.id)}"><label>${f.mandatory ? '<span class="m">* </span>' : ''}${esc(f.label)}</label><div class="${cls}">${esc(val) || '&nbsp;'}</div></div>`;
}

// The screen as one self-contained HTML document. The spec rides along in a comment, so a saved mockup can be revised.
export function renderScreen(s: Screen): string {
  const tab = s.record.tabs.find((t) => t.id === s.record.active_tab) ?? s.record.tabs[0];
  const rows = s.list.rows.map((r, i) => `<tr class="${i === s.list.selected ? 'sel' : ''}">${s.list.columns.map((c) => `<td>${esc(r[c.field])}</td>`).join('')}</tr>`).join('');
  const listBody = s.list.state !== 'ready' ? stateHtml(s.list.state, s.list.empty_text, s.list.error_text)
    : s.list.rows.length ? `<table><colgroup>${s.list.columns.map((c) => `<col${c.width ? ` style="width:${c.width}px"` : ''}>`).join('')}</colgroup><thead><tr>${s.list.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
      : stateHtml('empty', s.list.empty_text);
  const recBody = s.record.state !== 'ready' ? stateHtml(s.record.state, 'Select a record to see it here.', s.record.error_text)
    : tab.activity ? tab.activity.map((a) => `<div class="act"><b>${esc(a.who)}</b><span class="w">${esc(a.when)}</span><p>${esc(a.text)}</p></div>`).join('') || stateHtml('empty', 'No activity yet.')
      : (tab.sections ?? []).map((sec) => `<div class="sec" data-id="${esc(sec.id)}">${sec.label ? `<h3>${esc(sec.label)}</h3>` : ''}<div class="grid${sec.columns === 1 ? ' one' : ''}">${sec.fields.map(fieldHtml).join('')}</div></div>`).join('');
  const notes = [`<b>Mockup</b> · ${esc(s.release)} list/detail workspace, drawn by Wayfinder's screen kit. Not a UI Builder page.`,
    ...s.simulated.map((x) => `Simulated: ${esc(x)}`), ...s.assumptions.map((x) => `Assumed: ${esc(x)}`)];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(s.title)}</title><style>${CSS}</style></head>
<body class="${s.theme === 'dark' ? 'dark' : ''} ${s.density === 'compact' ? 'compact' : ''}">
<!-- wayfinder-screen: ${esc(JSON.stringify(s))} -->
<div class="ws">
<header class="bar"><b>${esc(s.title)}</b><span class="sp"></span><span class="chip">${esc(s.release)}</span></header>
<div class="note">${notes.join(' <span>·</span> ')}</div>
<div class="body">
<nav data-id="${esc(s.nav.id)}">${s.nav.items.map((n) => `<a class="${n.active ? 'on' : ''}" data-id="${esc(n.id)}"><span>${esc(n.label)}</span>${n.count !== undefined ? `<span class="n">${n.count}</span>` : ''}</a>`).join('')}</nav>
<section class="pane" data-id="${esc(s.list.id)}"><div class="ph"><h2>${esc(s.list.title)}</h2><span class="sub">${s.list.state === 'ready' ? `${s.list.rows.length} records` : ''}</span></div><div class="scroll">${listBody}</div></section>
<section class="pane" data-id="${esc(s.record.id)}"><div class="ph"><div style="min-width:0"><h1>${esc(s.record.title)}</h1>${s.record.subtitle ? `<div class="sub">${esc(s.record.subtitle)}</div>` : ''}</div><div class="acts">${s.record.actions.map((a) => `<button class="btn${a.primary ? ' p' : ''}${a.danger ? ' d' : ''}" data-id="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div></div>
<div class="tabs">${s.record.tabs.map((t) => `<span class="${t.id === tab.id ? 'on' : ''}" data-id="${esc(t.id)}">${esc(t.label)}</span>`).join('')}</div><div class="scroll">${recBody}</div></section>
</div></div></body></html>`;
}
