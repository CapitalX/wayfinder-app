import type { Instance } from './db.ts';
import { sn, table } from './sn.ts';

// "Show me": a read-only snapshot of a record, its form or a list, for the chat to draw as a card.
// It always says when and where it came from and what it left out, because it's a picture, not the live form.

export interface ShowField { name: string; label: string; value: string; display: string }
export interface ShowSnapshot {
  kind: 'record' | 'form' | 'list';
  table: string;
  table_label: string;
  title: string;
  instance: string;
  as_of: string;
  link: string;
  sys_id?: string;
  query?: string;
  fields?: ShowField[];                        // record
  sections?: { caption: string; top?: ShowField[]; columns: ShowField[][]; full?: ShowField[] }[];  // form: full-width fields above and below the two columns
  columns?: { name: string; label: string }[]; // list
  rows?: { sys_id: string; cells: Record<string, string> }[];
  total?: number;
  omitted: string[];
}

const SYSTEM = /^sys_(?!id$)|^(sys_tags|sys_domain_path)$/;
const short = (v: unknown) => { const s = String(v ?? ''); return s.length > 300 ? s.slice(0, 300) + '…' : s; };
const host = (inst: Instance) => new URL(inst.url).hostname.split('.')[0];

// Field labels for a table, including the ones it inherits (e.g. task fields on incident).
// Field labels change rarely; keep them 10 minutes per instance and table.
const labelCache = new Map<string, { at: number; value: { tableLabel: string; labels: Map<string, string> } }>();
async function labels(inst: Instance, name: string): Promise<{ tableLabel: string; labels: Map<string, string> }> {
  const key = `${inst.id}:${name}`;
  const hit = labelCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;
  const value = await loadLabels(inst, name);
  labelCache.set(key, { at: Date.now(), value });
  return value;
}
async function loadLabels(inst: Instance, name: string): Promise<{ tableLabel: string; labels: Map<string, string> }> {
  const chain: string[] = [];
  let tableLabel = name;
  let current: string | undefined = name;
  for (let i = 0; current && i < 6; i++) {
    const [row]: any[] = await table(inst, 'sys_db_object', `name=${current}`, 'name,label,super_class.name', 1).catch(() => []);
    if (!row) break;
    if (i === 0) tableLabel = row.label || name;
    chain.push(current);
    current = row['super_class.name'] || undefined;
  }
  const docs = chain.length ? await table(inst, 'sys_documentation', `nameIN${chain.join(',')}^language=en`, 'name,element,label', 1000).catch(() => []) : [];
  const out = new Map<string, string>();
  // Closest table wins: walk from the parent down so the child's label overrides.
  for (const t of [...chain].reverse()) for (const d of docs) if (d.name === t && d.element) out.set(d.element, d.label);
  return { tableLabel, labels: out };
}

async function getRecord(inst: Instance, name: string, sysId: string) {
  const res = await sn(inst, `/api/now/table/${name}/${encodeURIComponent(sysId)}?sysparm_display_value=all&sysparm_exclude_reference_link=true`);
  return res.result as Record<string, { value: string; display_value: string }>;
}

const fieldOf = (rec: Record<string, any>, name: string, labelMap: Map<string, string>): ShowField => {
  const v = rec[name];
  const value = typeof v === 'object' && v ? v.value : v;
  const display = typeof v === 'object' && v ? v.display_value : v;
  return { name, label: labelMap.get(name) ?? name, value: short(value), display: short(display) };
};

export async function showRecord(inst: Instance, name: string, sysId: string, fields?: string[]): Promise<ShowSnapshot> {
  const [rec, meta, layout] = await Promise.all([getRecord(inst, name, sysId), labels(inst, name), fields?.length ? Promise.resolve([]) : formLayout(inst, name)]);
  const all = Object.keys(rec);
  const filled = (f: string) => String(rec[f]?.value ?? '') !== '';
  let chosen: string[];
  if (fields?.length) chosen = fields.filter((f) => f in rec);
  else {
    // The form's fields first, in form order; without a form, every filled non-system field.
    const onForm = [...new Set(layout.flatMap((s) => s.elements.map((e) => e.element)).filter((f) => f && f in rec && filled(f)))];
    chosen = onForm.length ? onForm : all.filter((f) => !SYSTEM.test(f) && filled(f));
  }
  const shown = chosen.slice(0, 30);
  const titleField = ['number', 'name', 'short_description', 'title', 'u_name'].find((f) => rec[f]?.display_value);
  const hidden = all.filter((f) => !shown.includes(f) && filled(f) && !SYSTEM.test(f)).length;
  return {
    kind: 'record', table: name, table_label: meta.tableLabel, instance: host(inst), as_of: new Date().toISOString(), sys_id: sysId,
    title: titleField ? String(rec[titleField].display_value) : sysId,
    link: `${inst.url}/${name}.do?sys_id=${sysId}`,
    fields: shown.map((f) => fieldOf(rec, f, meta.labels)),
    omitted: [...(hidden ? [`${hidden} other filled fields not on the form`] : []), 'empty and system fields'],
  };
}

// The Default view's sections in display order (the main section has no caption and comes first), each with its
// elements in order. The Default view's sys_id is literally "Default view".
async function formLayout(inst: Instance, name: string) {
  const sections = await table(inst, 'sys_ui_section', `name=${name}^view=Default view`, 'sys_id,caption,position', 20).catch(() => []);
  const ordered = [...sections].sort((a: any, b: any) => (a.caption ? 1 : 0) - (b.caption ? 1 : 0) || Number(a.position || 0) - Number(b.position || 0));
  return Promise.all(ordered.map(async (sec: any) => ({
    caption: sec.caption as string,
    elements: (await table(inst, 'sys_ui_element', `sys_ui_section=${sec.sys_id}^ORDERBYposition`, 'element,type', 200).catch(() => [])) as { element: string; type: string }[],
  })));
}

// The form as laid out for the Default view: full-width fields, then the two columns, then full-width again.
export async function showForm(inst: Instance, name: string, sysId: string): Promise<ShowSnapshot> {
  const [rec, meta, layout] = await Promise.all([getRecord(inst, name, sysId), labels(inst, name), formLayout(inst, name)]);
  const out: NonNullable<ShowSnapshot['sections']> = [];
  for (const sec of layout) {
    const top: ShowField[] = [], left: ShowField[] = [], right: ShowField[] = [], full: ShowField[] = [];
    // Forms often have no .begin_split: when a section has a .split, everything before it is the left column.
    let where: 'top' | 'left' | 'right' | 'full' = sec.elements.some((e) => e.type === '.split') && !sec.elements.some((e) => e.type === '.begin_split') ? 'left' : 'top';
    for (const el of sec.elements) {
      if (el.type === '.begin_split') { where = 'left'; continue; }
      if (el.type === '.split') { where = 'right'; continue; }
      if (el.type === '.end_split') { where = 'full'; continue; }
      if (!el.element || el.type === 'formatter' || el.type === 'list' || !(el.element in rec)) continue;
      ({ top, left, right, full })[where].push(fieldOf(rec, el.element, meta.labels));
    }
    if (top.length || left.length || right.length || full.length)
      out.push({ caption: sec.caption || meta.tableLabel, top: top.length ? top : undefined, columns: [left, right].filter((c) => c.length), full: full.length ? full : undefined });
  }
  if (!out.length) {
    const snap = await showRecord(inst, name, sysId);
    return { ...snap, omitted: [...snap.omitted, 'no form layout found, so this shows the filled fields'] };
  }
  const titleField = ['number', 'name', 'short_description'].find((f) => rec[f]?.display_value);
  return {
    kind: 'form', table: name, table_label: meta.tableLabel, instance: host(inst), as_of: new Date().toISOString(), sys_id: sysId,
    title: titleField ? String(rec[titleField].display_value) : sysId,
    link: `${inst.url}/${name}.do?sys_id=${sysId}`,
    sections: out,
    omitted: ['related lists', 'formatters (activity, attachments)', 'UI policies and client scripts, which can hide or change fields live'],
  };
}

export async function showList(inst: Instance, name: string, query: string, fields: string[] | undefined, limit: number): Promise<ShowSnapshot> {
  const meta = await labels(inst, name);
  const cols = fields?.length ? fields.slice(0, 8) : ['number', 'name', 'short_description', 'state', 'sys_updated_on'].filter((f) => meta.labels.has(f) || f === 'sys_updated_on').slice(0, 5);
  const res = await sn(inst, `/api/now/table/${name}?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=sys_id,${cols.join(',')}&sysparm_limit=${Math.min(limit, 25)}&sysparm_display_value=true&sysparm_exclude_reference_link=true`);
  const count = await sn(inst, `/api/now/stats/${name}?sysparm_count=true&sysparm_query=${encodeURIComponent(query)}`).then((r) => Number(r.result?.stats?.count ?? 0)).catch(() => undefined);
  const rows = (res.result as any[]).map((r) => ({ sys_id: r.sys_id, cells: Object.fromEntries(cols.map((c) => [c, short(r[c])])) }));
  return {
    kind: 'list', table: name, table_label: meta.tableLabel, instance: host(inst), as_of: new Date().toISOString(),
    title: meta.tableLabel, query: query || undefined,
    link: `${inst.url}/${name}_list.do?sysparm_query=${encodeURIComponent(query)}`,
    columns: cols.map((c) => ({ name: c, label: meta.labels.get(c) ?? (c === 'sys_updated_on' ? 'Updated' : c) })),
    rows, total: count,
    omitted: count !== undefined && count > rows.length ? [`${count - rows.length} more rows`] : [],
  };
}
