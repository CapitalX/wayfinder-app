import { type Instance } from './db.ts';
import { sn, table } from './sn.ts';

// "What does this touch?": the records on the instance that reference a table, a field, a script include or an ACL.
// Read-only. Each query is bounded, and every hit is checked again here against the fields it came back with: an
// encoded query on a field the instance doesn't have is silently dropped (and would return everything), and LIKE
// matches substrings (incident inside incident_task), so only a confirmed match becomes a reference.

export type ImpactTarget =
  | { kind: 'table'; table: string }
  | { kind: 'field'; table: string; field: string }
  | { kind: 'script_include'; name: string }
  | { kind: 'acl'; name: string; sys_id?: string };

export interface Reference { kind: string; table: string; sys_id: string; name: string; match: string; link: string }
export interface Impact { target: ImpactTarget; refs: Reference[]; counts: Record<string, number>; summary: string; truncated: boolean; skipped: string[]; notes: string[] }

const NAME = /^[a-z0-9_]{1,80}$/;
const SCRIPT_NAME = /^[A-Za-z_$][\w$]{0,79}(\.[A-Za-z_$][\w$]{0,79})?$/;
const SYS_ID = /^[0-9a-f]{32}$/;
const LIMIT = 25;

export function validTarget(t: ImpactTarget): string | null {
  if (t.kind === 'table') return NAME.test(t.table) ? null : 'Not a table name.';
  if (t.kind === 'field') return NAME.test(t.table) && NAME.test(t.field) ? null : 'Not a table and field name.';
  if (t.kind === 'script_include') return SCRIPT_NAME.test(t.name) ? null : 'Not a script include name.';
  if (t.kind === 'acl') return /^[a-z0-9_]{1,80}(\.[a-z0-9_*]{1,80})?$/.test(t.name) && (!t.sys_id || SYS_ID.test(t.sys_id)) ? null : 'Not an ACL name.';
  return 'Unknown target.';
}

// Matches are plain string checks and fixed patterns, never a pattern built from a name.
type Test = (text: string) => boolean;
const isWordChar = (c: string | undefined) => !!c && /\w/.test(c);
// A whole word: u_status, not u_status_old or xu_status.
const word = (w: string): Test => (text) => {
  for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) if (!isWordChar(text[i - 1]) && !isWordChar(text[i + w.length])) return true;
  return false;
};
// A table named in a script the way scripts name tables: GlideRecord('x'), 'x', "x".
const QUOTES = ["'", '"', '`'];
const quotedName = (w: string): Test => (text) => QUOTES.some((a) => QUOTES.some((b) => text.includes(`${a}${w}${b}`)));

interface Source { table: string; kind: string; group: 'script' | 'acl' | 'ui_policy' | 'flow' | 'report' | 'notification' | 'field'; text: string[]; on?: string; name?: string }
// Where references live: the fields holding code or conditions, and the field naming the table they run on.
const SOURCES: Source[] = [
  { table: 'sys_script', kind: 'Business rule', group: 'script', text: ['script', 'condition', 'filter_condition'], on: 'collection' },
  { table: 'sys_script_client', kind: 'Client script', group: 'script', text: ['script', 'field_name'], on: 'table' },
  { table: 'sys_ui_action', kind: 'UI action', group: 'script', text: ['script', 'condition'], on: 'table' },
  { table: 'sys_ui_policy', kind: 'UI policy', group: 'ui_policy', text: ['conditions', 'script_true', 'script_false'], on: 'table', name: 'short_description' },
  { table: 'sys_security_acl', kind: 'ACL', group: 'acl', text: ['name', 'condition', 'script'] },
  { table: 'sysevent_email_action', kind: 'Notification', group: 'notification', text: ['condition', 'advanced_condition', 'message_html'], on: 'collection' },
  { table: 'sys_report', kind: 'Report', group: 'report', text: ['filter', 'field', 'group'], on: 'table', name: 'title' },
  // No table field: these name tables inside their code.
  { table: 'sys_script_include', kind: 'Script include', group: 'script', text: ['script'] },
  { table: 'sysauto_script', kind: 'Scheduled job', group: 'script', text: ['script'] },
  { table: 'sys_ws_operation', kind: 'Scripted REST resource', group: 'script', text: ['operation_script'] },
];

const link = (inst: Instance, t: string, id: string) => `${inst.url}/${t}.do?sys_id=${encodeURIComponent(id)}`;

type Rows = { rows: any[]; full: boolean } | null;
async function rows(inst: Instance, t: string, query: string, fields: string[], skipped: string[]): Promise<Rows> {
  try {
    const r = await table(inst, t, query, ['sys_id', ...new Set(fields)].join(','), LIMIT);
    return { rows: r, full: r.length >= LIMIT };
  } catch (e) {
    skipped.push(`${t} (${/\(403\)/.test((e as Error).message) ? "this account can't read it" : 'the instance refused the query'})`);
    return null;
  }
}

function refsFrom(inst: Instance, s: Source, got: Rows, test: (row: any) => string | null, out: Reference[]) {
  for (const r of got?.rows ?? []) {
    const match = test(r);
    if (match) out.push({ kind: s.kind, table: s.table, sys_id: r.sys_id, name: String(r[s.name ?? 'name'] || r.sys_id), match, link: link(inst, s.table, r.sys_id) });
  }
}

const firstMatch = (row: any, fields: string[], test: Test) => fields.find((f) => test(String(row[f] ?? '')));

async function forTable(inst: Instance, t: string, skipped: string[], notes: string[]) {
  const out: Reference[] = [];
  let truncated = false;
  const named = quotedName(t);
  await Promise.all([
    ...SOURCES.map(async (s) => {
      if (s.table === 'sys_security_acl') {
        const got = await rows(inst, s.table, `name=${t}^ORnameSTARTSWITH${t}.`, ['name', 'operation'], skipped);
        truncated ||= !!got?.full;
        return refsFrom(inst, s, got, (r) => (r.name === t || String(r.name).startsWith(`${t}.`) ? `on ${t} (${r.operation || 'any'})` : null), out);
      }
      const got = s.on
        ? await rows(inst, s.table, `${s.on}=${t}`, [s.on, s.name ?? 'name'], skipped)
        : await rows(inst, s.table, `${s.text[0]}LIKE${t}`, [s.name ?? 'name', ...s.text], skipped);
      truncated ||= !!got?.full;
      refsFrom(inst, s, got, (r) => (s.on ? (r[s.on] === t ? `runs on ${t}` : null) : (firstMatch(r, s.text, named) ? `names ${t} in ${firstMatch(r, s.text, named)}` : null)), out);
    }),
    (async () => {
      const s: Source = { table: 'sys_dictionary', kind: 'Reference field', group: 'field', text: ['reference'] };
      const got = await rows(inst, 'sys_dictionary', `reference=${t}^internal_type=reference`, ['name', 'element', 'reference'], skipped);
      truncated ||= !!got?.full;
      for (const r of got?.rows ?? []) if (r.reference === t && r.element) out.push({ kind: s.kind, table: s.table, sys_id: r.sys_id, name: `${r.name}.${r.element}`, match: `points at ${t}`, link: link(inst, s.table, r.sys_id) });
    })(),
    flowsOn(inst, t, skipped, out),
  ]);
  notes.push('Flows count when they are triggered on this table; what a flow reads inside its steps isn\'t searched.');
  return { out, truncated };
}

async function flowsOn(inst: Instance, t: string, skipped: string[], out: Reference[]) {
  const got = await rows(inst, 'sys_hub_trigger_instance', `table=${t}`, ['table', 'flow'], skipped);
  for (const r of got?.rows ?? []) if (r.table === t && r.flow) out.push({ kind: 'Flow', table: 'sys_hub_flow', sys_id: r.flow, name: r.flow, match: `triggered on ${t}`, link: link(inst, 'sys_hub_flow', r.flow) });
  // Name the flows (the trigger only has the flow's id).
  const ids = out.filter((r) => r.kind === 'Flow' && r.name === r.sys_id && SYS_ID.test(r.sys_id)).map((r) => r.sys_id);
  if (!ids.length) return;
  const named = await rows(inst, 'sys_hub_flow', `sys_idIN${[...new Set(ids)].join(',')}`, ['name', 'type'], skipped);
  for (const f of named?.rows ?? []) for (const r of out) if (r.sys_id === f.sys_id) { r.name = f.name; if (f.type === 'subflow') r.kind = 'Subflow'; }
}

async function forField(inst: Instance, t: string, f: string, skipped: string[], notes: string[]) {
  const out: Reference[] = [];
  let truncated = false;
  const re = word(f);
  const named = quotedName(t);
  await Promise.all([
    ...SOURCES.map(async (s) => {
      if (s.table === 'sys_security_acl') {
        const got = await rows(inst, s.table, `name=${t}.${f}^ORnameSTARTSWITH${t}^conditionLIKE${f}^ORscriptLIKE${f}^ORname=${t}.${f}`, ['name', 'operation', 'condition', 'script'], skipped);
        truncated ||= !!got?.full;
        return refsFrom(inst, s, got, (r) => (r.name === `${t}.${f}` ? `guards ${t}.${f} (${r.operation || 'any'})` : String(r.name).split('.')[0] === t && firstMatch(r, ['condition', 'script'], re) ? `reads ${f} in ${firstMatch(r, ['condition', 'script'], re)}` : null), out);
      }
      const like = s.text.map((x) => `${x}LIKE${f}`).join('^OR');
      const got = s.on
        ? await rows(inst, s.table, `${s.on}=${t}^${like}`, [s.on, s.name ?? 'name', ...s.text], skipped)
        : await rows(inst, s.table, `${like}^${s.text[0]}LIKE${t}`, [s.name ?? 'name', ...s.text], skipped);
      truncated ||= !!got?.full;
      refsFrom(inst, s, got, (r) => {
        if (s.on && r[s.on] !== t) return null;
        if (!s.on && !firstMatch(r, s.text, named)) return null;
        const where = firstMatch(r, s.text, re);
        return where ? `${where === 'field_name' ? 'runs on' : 'reads'} ${f}${where === 'field_name' ? '' : ` in ${where}`}` : null;
      }, out);
    }),
    (async () => {
      const got = await rows(inst, 'sys_ui_policy_action', `table=${t}^field=${f}`, ['table', 'field', 'ui_policy'], skipped);
      truncated ||= !!got?.full;
      for (const r of got?.rows ?? []) if (r.table === t && r.field === f && r.ui_policy)
        out.push({ kind: 'UI policy action', table: 'sys_ui_policy', sys_id: r.ui_policy, name: r.ui_policy, match: `sets ${f} (visible, mandatory or read-only)`, link: link(inst, 'sys_ui_policy', r.ui_policy) });
    })(),
    flowsOn(inst, t, skipped, out),
  ]);
  // A UI policy found through its action and its condition is one reference.
  const seen = new Set<string>();
  const deduped = out.filter((r) => { const k = `${r.table}:${r.sys_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const r of deduped) if (r.kind === 'Flow' || r.kind === 'Subflow') r.match = `triggered on ${t} (may read ${f})`;
  notes.push('Scripts that build the field name at run time, and flow steps, aren\'t searched.');
  return { out: deduped, truncated };
}

// Callers of a script include: new X(, X.method(, and GlideAjax('X') from client code. ServiceNow's code search
// (one call across every script type) is used when the instance has it; otherwise each script table is queried.
const CALL_NEW = /\bnew\s+([\w$.]+)\s*\(/g;
const CALL_METHOD = /(?:^|[^\w$.])([\w$]+(?:\.[\w$]+)?)\.[\w$]+\s*\(/g;
const CALL_AJAX = /GlideAjax\(\s*['"`]([\w$.]+)['"`]/g;
export function callsInclude(name: string): Test {
  const short = name.split('.').pop()!;
  // Scoped or not: LoanUtils or x_acme.LoanUtils.
  const same = (found: string) => found === short || found.endsWith(`.${short}`) && found.split('.').length === 2;
  return (text) => [CALL_NEW, CALL_METHOD, CALL_AJAX].some((re) => [...text.matchAll(re)].some((m) => same(m[1])));
}

async function codeSearch(inst: Instance, term: string): Promise<{ table: string; sys_id: string; name: string; field: string; text: string }[] | null> {
  try {
    const r = await sn(inst, `/api/sn_codesearch/code_search/search?term=${encodeURIComponent(term)}&search_all_scopes=true&limit=200`);
    const groups = Array.isArray(r?.result) ? r.result : null;
    if (!groups) return null;
    const hits: { table: string; sys_id: string; name: string; field: string; text: string }[] = [];
    for (const g of groups) for (const h of g?.hits ?? []) for (const m of h?.matches ?? [])
      if (h.sysId && (h.className || g.recordType)) hits.push({ table: h.className || g.recordType, sys_id: h.sysId, name: h.name ?? h.sysId, field: m.field ?? 'script', text: (m.lineMatches ?? []).map((l: any) => l.context ?? '').join('\n') });
    return hits;
  } catch { return null; }
}

async function forInclude(inst: Instance, name: string, skipped: string[], notes: string[]) {
  const out: Reference[] = [];
  const re = callsInclude(name);
  const short = name.split('.').pop()!;
  const kinds = new Map(SOURCES.map((s) => [s.table, s.kind]));
  let truncated = false;
  const hits = await codeSearch(inst, short);
  if (hits) {
    for (const h of hits) if (re(h.text) && !(h.table === 'sys_script_include' && h.name === short))
      out.push({ kind: kinds.get(h.table) ?? h.table, table: h.table, sys_id: h.sys_id, name: h.name, match: `calls ${short} in ${h.field}`, link: link(inst, h.table, h.sys_id) });
    notes.push('Found with the instance\'s code search.');
  } else {
    await Promise.all(SOURCES.filter((s) => s.group === 'script' || s.table === 'sys_security_acl').map(async (s) => {
      const fields = s.text.filter((x) => x !== 'field_name' && x !== 'name');
      const got = await rows(inst, s.table, fields.map((x) => `${x}LIKE${short}`).join('^OR'), [s.name ?? 'name', ...fields], skipped);
      truncated ||= !!got?.full;
      refsFrom(inst, s, got, (r) => (s.table === 'sys_script_include' && r.name === short ? null : firstMatch(r, fields, re) ? `calls ${short} in ${firstMatch(r, fields, re)}` : null), out);
    }));
  }
  const seen = new Set<string>();
  return { out: out.filter((r) => { const k = `${r.table}:${r.sys_id}`; return seen.has(k) ? false : (seen.add(k), true); }), truncated };
}

async function forAcl(inst: Instance, target: { name: string; sys_id?: string }, skipped: string[], notes: string[]) {
  const out: Reference[] = [];
  const got = await rows(inst, 'sys_security_acl', target.sys_id ? `sys_id=${target.sys_id}` : `name=${target.name}`, ['name', 'operation', 'type', 'active', 'admin_overrides'], skipped);
  const acl = got?.rows.find((r) => (target.sys_id ? r.sys_id === target.sys_id : r.name === target.name));
  if (!acl) { notes.push(`No ACL named ${target.name} was found (or this account can't see it).`); return { out, truncated: false }; }
  // What the instance sent back goes into the next queries only if it looks like what it should be.
  if (!SYS_ID.test(acl.sys_id) || !/^[a-z0-9_]{1,80}(\.[a-z0-9_*]{1,80})?$/.test(acl.name) || !/^[a-z_]{0,40}$/.test(acl.operation ?? '')) {
    notes.push('The ACL came back in an unexpected shape, so its roles and neighbours weren\'t looked up.');
    return { out, truncated: false };
  }
  const [t, f] = String(acl.name).split('.');
  out.push({ kind: 'Table', table: 'sys_db_object', sys_id: '', name: t, match: `${acl.operation || 'any'} on ${f ? `the field ${f}` : 'the table'}`, link: `${inst.url}/sys_db_object_list.do?sysparm_query=${encodeURIComponent(`name=${t}`)}` });
  const roles = await rows(inst, 'sys_security_acl_role', `sys_security_acl=${acl.sys_id}`, ['sys_security_acl', 'sys_user_role'], skipped);
  const roleIds = (roles?.rows ?? []).filter((r) => r.sys_security_acl === acl.sys_id && SYS_ID.test(r.sys_user_role ?? '')).map((r) => r.sys_user_role);
  if (roleIds.length) {
    const named = await rows(inst, 'sys_user_role', `sys_idIN${roleIds.join(',')}`, ['name'], skipped);
    for (const r of named?.rows ?? []) out.push({ kind: 'Role', table: 'sys_user_role', sys_id: r.sys_id, name: r.name, match: 'needed by this ACL', link: link(inst, 'sys_user_role', r.sys_id) });
  } else if (roles) notes.push('This ACL needs no role: anyone who passes its condition and script gets access.');
  // The other ACLs for the same thing decide access together with this one.
  const siblings = await rows(inst, 'sys_security_acl', `name=${acl.name}^ORname=${t}.*^operation=${acl.operation}^sys_id!=${acl.sys_id}`, ['name', 'operation'], skipped);
  for (const r of siblings?.rows ?? []) if (r.sys_id !== acl.sys_id && r.operation === acl.operation && (r.name === acl.name || r.name === `${t}.*`))
    out.push({ kind: 'ACL', table: 'sys_security_acl', sys_id: r.sys_id, name: r.name, match: `also decides ${acl.operation}`, link: link(inst, 'sys_security_acl', r.sys_id) });
  if (acl.admin_overrides === 'true') notes.push('Admins pass it anyway (admin overrides).');
  if (acl.active === 'false') notes.push('It is inactive, so it currently decides nothing.');
  return { out, truncated: false };
}

const PLURAL: Record<string, string> = { 'Business rule': 'scripts', 'Client script': 'scripts', 'UI action': 'scripts', 'Script include': 'scripts', 'Scheduled job': 'scripts', 'Scripted REST resource': 'scripts',
  ACL: 'ACLs', 'UI policy': 'UI policies', 'UI policy action': 'UI policies', Flow: 'flows', Subflow: 'flows', Report: 'reports', Notification: 'notifications', 'Reference field': 'reference fields', Role: 'roles', Table: 'tables' };
const ONE: Record<string, string> = { scripts: 'script', ACLs: 'ACL', 'UI policies': 'UI policy', flows: 'flow', reports: 'report', notifications: 'notification', 'reference fields': 'reference field', roles: 'role', tables: 'table' };

// "4 scripts and 1 flow": the counts in plain words, most first.
export function summarize(refs: Reference[]): { counts: Record<string, number>; text: string } {
  const counts: Record<string, number> = {};
  for (const r of refs) { const k = PLURAL[r.kind] ?? 'other records'; counts[k] = (counts[k] ?? 0) + 1; }
  const rank = (k: string) => { const i = Object.keys(ONE).indexOf(k); return i < 0 ? 99 : i; };
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0])).map(([k, n]) => `${n} ${n === 1 ? ONE[k] ?? k : k}`);
  const text = parts.length ? parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : 'nothing found';
  return { counts, text };
}

export async function findReferences(inst: Instance, target: ImpactTarget): Promise<Impact> {
  const bad = validTarget(target);
  if (bad) throw new Error(bad);
  const skipped: string[] = [], notes: string[] = [];
  const { out, truncated } = target.kind === 'table' ? await forTable(inst, target.table, skipped, notes)
    : target.kind === 'field' ? await forField(inst, target.table, target.field, skipped, notes)
    : target.kind === 'script_include' ? await forInclude(inst, target.name, skipped, notes)
    : await forAcl(inst, target, skipped, notes);
  // An ACL always has its own table; the summary counts what else decides access with it.
  const { counts, text } = summarize(target.kind === 'acl' ? out.filter((r) => r.kind !== 'Table') : out);
  if (truncated) notes.push(`Some searches hit their limit of ${LIMIT}; there may be more.`);
  return { target, refs: out, counts, summary: text, truncated, skipped, notes };
}

// "x_loan.u_status: 4 scripts and 1 flow read it", for an Insights row once its search has run. Cached with the same
// 10 minutes as Insights, and shared while it runs.
const VERB: Record<ImpactTarget['kind'], string> = { field: 'read it', table: 'use it', script_include: 'call it', acl: 'decide access with it' };
const summaries = new Map<string, { at: number; line: Promise<{ summary: string; line: string }> }>();
export function impactLine(inst: Instance, target: ImpactTarget): Promise<{ summary: string; line: string }> {
  const bad = validTarget(target);
  if (bad) return Promise.reject(new Error(bad));
  const key = `${inst.id}|${inst.client_id}|${JSON.stringify(target)}`;
  const hit = summaries.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.line;
  const name = target.kind === 'field' ? `${target.table}.${target.field}` : target.kind === 'table' ? target.table : target.name;
  const p = findReferences(inst, target).then((r) => ({ summary: r.summary, line: r.summary === 'nothing found' ? `Nothing found that uses ${name}` : `${name}: ${r.summary} ${VERB[target.kind]}` }));
  summaries.set(key, { at: Date.now(), line: p });
  p.catch(() => summaries.delete(key));
  return p;
}
export const clearImpact = (instanceId: string) => { for (const k of summaries.keys()) if (k.startsWith(`${instanceId}|`)) summaries.delete(k); };
