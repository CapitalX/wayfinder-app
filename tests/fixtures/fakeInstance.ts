import { vi } from 'vitest';

// A fake instance for read-only tests: an in-memory Table API and Aggregate (stats) API that understand the encoded
// queries Wayfinder sends (=, !=, LIKE, NOT LIKE, STARTSWITH, IN, NOT IN, ISEMPTY, <, <=, >, >=, ^OR, ORDERBY…), with
// javascript:gs.hoursAgo(n) / gs.daysAgo(n) worked out against the real clock. Rows are plain objects; dates are
// "YYYY-MM-DD HH:MM:SS" in UTC, like the Table API returns them.

export type Row = Record<string, string>;
// loose: like a real instance, a condition on a field the table doesn't have is ignored (so it matches everything).
export interface Fake { tables: Record<string, Row[]>; calls: string[]; denied: Set<string>; codeSearch?: unknown; loose: boolean; stub: () => void }

export const ago = (ms: number) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
export const hoursAgo = (h: number) => ago(h * 3_600_000);
export const daysAgo = (d: number) => ago(d * 86_400_000);
export const id = (n: number) => n.toString(16).padStart(32, '0');

function value(v: string): string {
  const m = v.match(/^javascript:gs\.(hoursAgo|daysAgo)\((\d+)\)$/);
  if (!m) return v;
  return m[1] === 'hoursAgo' ? hoursAgo(Number(m[2])) : daysAgo(Number(m[2]));
}

const OPS = ['NOT LIKE', 'NOT IN', 'ISNOTEMPTY', 'ISEMPTY', 'STARTSWITH', 'ENDSWITH', 'LIKE', 'IN', '!=', '>=', '<=', '>', '<', '='];

function term(row: Row, t: string, loose: boolean): boolean {
  const m = t.match(/^([a-z0-9_.]+)(.*)$/);
  if (!m) return true;
  const [, field, rest] = m;
  const op = OPS.find((o) => rest.startsWith(o));
  if (!op) return true;
  if (loose && !(field in row)) return true;
  const want = value(rest.slice(op.length));
  const have = String(row[field] ?? '');
  switch (op) {
    case '=': return have === want;
    case '!=': return have !== want;
    case 'LIKE': return have.toLowerCase().includes(want.toLowerCase());
    case 'NOT LIKE': return !have.toLowerCase().includes(want.toLowerCase());
    case 'STARTSWITH': return have.startsWith(want);
    case 'ENDSWITH': return have.endsWith(want);
    case 'IN': return want.split(',').includes(have);
    case 'NOT IN': return !want.split(',').includes(have);
    case 'ISEMPTY': return !have;
    case 'ISNOTEMPTY': return !!have;
    case '>=': return have >= want;
    case '<=': return have <= want;
    case '>': return have > want;
    case '<': return have < want;
  }
  return true;
}

// a^b^ORc means a AND (b OR c).
export function matches(row: Row, query: string, loose = false): boolean {
  const parts = query.split('^').filter((p) => p && !p.startsWith('ORDERBY'));
  const groups: string[][] = [];
  for (const p of parts) if (p.startsWith('OR') && groups.length) groups[groups.length - 1].push(p.slice(2)); else groups.push([p]);
  return groups.every((g) => g.some((t) => term(row, t, loose)));
}

function order(rows: Row[], query: string) {
  const o = query.split('^').find((p) => p.startsWith('ORDERBY'));
  if (!o) return rows;
  const desc = o.startsWith('ORDERBYDESC');
  const f = o.slice(desc ? 11 : 7);
  return [...rows].sort((a, b) => (String(a[f] ?? '') < String(b[f] ?? '') ? -1 : 1) * (desc ? -1 : 1));
}

export function fakeInstance(tables: Record<string, Row[]> = {}): Fake {
  const fake: Fake = {
    tables, calls: [], denied: new Set(), loose: false,
    stub: () => vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      // Read-only: anything but a GET fails the test that caused it.
      if ((init.method ?? 'GET') !== 'GET') throw new Error(`fake instance: ${init.method} ${input} (only GET is allowed)`);
      const u = new URL(String(input));
      fake.calls.push(`${u.pathname}${u.search}`);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (u.pathname.startsWith('/api/sn_codesearch/')) return fake.codeSearch === undefined ? json(404, { error: { message: 'no code search' } }) : json(200, { result: fake.codeSearch });
      const [, api, name] = u.pathname.match(/^\/api\/now\/(table|stats)\/([^/]+)$/) ?? [];
      if (!api) return json(404, { error: { message: 'not found' } });
      if (fake.denied.has(name)) return json(403, { error: { message: 'Insufficient rights' } });
      const q = u.searchParams.get('sysparm_query') ?? '';
      const found = order((fake.tables[name] ?? []).filter((r) => matches(r, q, fake.loose)), q);
      if (api === 'stats') return json(200, { result: { stats: { count: String(found.length) } } });
      const fields = (u.searchParams.get('sysparm_fields') ?? '').split(',').filter(Boolean);
      const limit = Number(u.searchParams.get('sysparm_limit') ?? 100);
      return json(200, { result: found.slice(0, limit).map((r) => (fields.length ? Object.fromEntries(fields.map((f) => [f, r[f] ?? ''])) : r)) });
    })),
  };
  return fake;
}
