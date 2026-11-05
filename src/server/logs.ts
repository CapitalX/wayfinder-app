import { type Instance } from './db.ts';
import { sn, table } from './sn.ts';

// Pip's log tool: one call summarises the system log for a window (totals, top sources, repeating messages grouped
// into patterns, an hourly trend), so investigations don't page through syslog a few rows at a time. Reads go
// straight to the Table and Aggregate APIs with the account's own access.

const LEVEL: Record<string, string> = { error: '2', warning: '1', info: '0' };
export interface LogFilter { hours?: number; level?: 'error' | 'warning' | 'info' | 'all'; source?: string; contains?: string; exclude_sources?: string[] }

export function logQuery(f: LogFilter): string {
  const hours = Math.min(Math.max(Math.round(f.hours ?? 24), 1), 24 * 14);
  const parts = [`sys_created_on>=javascript:gs.hoursAgo(${hours})`];
  if (f.level && f.level !== 'all') parts.push(`level=${LEVEL[f.level]}`);
  const safe = (s: string) => s.replace(/[\^\n]/g, ' ').trim();
  if (f.source) parts.push(`sourceLIKE${safe(f.source)}`);
  if (f.contains) parts.push(`messageLIKE${safe(f.contains)}`);
  for (const x of f.exclude_sources ?? []) parts.push(`sourceNOT LIKE${safe(x)}`);
  return parts.join('^');
}

// Messages that differ only in ids, numbers, quoted values, URLs or paths are one pattern.
export function pattern(message: string): string {
  return message
    .replace(/\b[0-9a-f]{32}\b/gi, '<sys_id>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/'[^']{0,200}'|"[^"]{0,200}"/g, '<value>')
    .replace(/\b(INC|CHG|PRB|RITM|REQ|TASK|SCTASK)\d+\b/g, '<number>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

async function stats(inst: Instance, q: string, groupBy?: string): Promise<{ value: string; count: number }[]> {
  const r = await sn(inst, `/api/now/stats/syslog?sysparm_count=true${groupBy ? `&sysparm_group_by=${groupBy}` : ''}&sysparm_query=${encodeURIComponent(q)}`);
  const res = r.result;
  if (!groupBy) return [{ value: 'total', count: Number(res?.stats?.count ?? 0) }];
  return (Array.isArray(res) ? res : []).map((g: any) => ({ value: g.groupby_fields?.[0]?.value || '(empty)', count: Number(g.stats?.count ?? 0) })).sort((a, b) => b.count - a.count);
}

export async function logSummary(inst: Instance, f: LogFilter) {
  const q = logQuery({ level: 'error', ...f });
  const [[total], sources, sample] = await Promise.all([
    stats(inst, q), stats(inst, q, 'source'),
    table(inst, 'syslog', `${q}^ORDERBYDESCsys_created_on`, 'sys_created_on,source,message', 500),
  ]);
  const rows = sample as { sys_created_on: string; source: string; message: string }[];
  const groups = new Map<string, { pattern: string; count: number; sources: Set<string>; first: string; last: string; example: string }>();
  const hours = new Map<string, number>();
  for (const r of rows) {
    const p = pattern(r.message ?? '');
    const g = groups.get(p) ?? { pattern: p, count: 0, sources: new Set(), first: r.sys_created_on, last: r.sys_created_on, example: (r.message ?? '').slice(0, 300) };
    g.count++; g.sources.add(r.source || '(empty)');
    if (r.sys_created_on < g.first) g.first = r.sys_created_on;
    if (r.sys_created_on > g.last) g.last = r.sys_created_on;
    groups.set(p, g);
    const h = (r.sys_created_on ?? '').slice(0, 13);
    hours.set(h, (hours.get(h) ?? 0) + 1);
  }
  const scale = rows.length ? total.count / rows.length : 1;
  return {
    window_hours: f.hours ?? 24, level: f.level ?? 'error', total: total.count,
    sampled: rows.length, note: rows.length < total.count ? `Patterns come from the newest ${rows.length} of ${total.count} entries; "estimate" scales them to the total.` : undefined,
    top_sources: sources.slice(0, 12).map((s) => ({ source: s.value, count: s.count, share: total.count ? `${Math.round((s.count / total.count) * 100)}%` : '0%' })),
    patterns: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 12).map((g) => ({
      pattern: g.pattern, in_sample: g.count, estimate: Math.round(g.count * scale), sources: [...g.sources].slice(0, 3), first: g.first, last: g.last, example: g.example,
    })),
    by_hour: [...hours.entries()].sort().map(([hour, n]) => ({ hour, in_sample: n })),
    list_link: `${inst.url}/syslog_list.do?sysparm_query=${encodeURIComponent(q)}`,
  };
}

export async function logSearch(inst: Instance, f: LogFilter & { limit?: number }) {
  const q = logQuery(f);
  const rows = await table(inst, 'syslog', `${q}^ORDERBYDESCsys_created_on`, 'sys_id,sys_created_on,level,source,message', Math.min(f.limit ?? 25, 100));
  return { query: q, rows: (rows as any[]).map((r) => ({ ...r, message: String(r.message ?? '').slice(0, 600) })), list_link: `${inst.url}/syslog_list.do?sysparm_query=${encodeURIComponent(q)}` };
}
