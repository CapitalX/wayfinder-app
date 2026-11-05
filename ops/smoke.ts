// Smoke test for a running Wayfinder: health, version, live stream, a board/memory round trip and speed limits.
// Read-only on the PDI. Usage: WAYFINDER_URL=http://127.0.0.1:8797 WAYFINDER_TOKEN=… npx tsx ops/smoke.ts
// WAYFINDER_SMOKE=update is the short profile `wayfinder update` uses to decide on a rollback: only what a release can
// break by itself (health, version, a board round trip), not the instance, the network or past speed records.
// (or set WAYFINDER_* like the server and the token is read from the secrets file). Exits non-zero on any failure.
import { readFileSync } from 'node:fs';

const base = (process.env.WAYFINDER_URL ?? `http://127.0.0.1:${process.env.WAYFINDER_PORT ?? process.env.SNW_PORT ?? 8797}`).replace(/\/$/, '');
const token = process.env.WAYFINDER_TOKEN ?? (await import('../src/server/secrets.ts')).secrets.appToken();
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Speed budgets (ms). A smoke run fails if a check is slower than this.
// features is generous: the first search after a restart waits on the instance (token, cold queries), not on Wayfinder.
const BUDGET = { session: 500, features: 30000, board: 800, perfFirstWordP50: 15000 };

const full = process.env.WAYFINDER_SMOKE !== 'update';
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
async function call(path: string, init: RequestInit = {}) {
  const t = Date.now();
  const res = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: body as any, ms: Date.now() - t };
}

const s = await call('/api/session');
check('session', s.status === 200, `${s.ms} ms`);
if (full) check('session speed', s.ms < BUDGET.session, `${s.ms} ms (budget ${BUDGET.session})`);
const a = await call('/api/about');
check('version matches package.json', a.body?.version === version, `${a.body?.version} vs ${version}`);
let st = full ? await call('/api/status') : { status: 200, body: null as any, ms: 0 };
// Right after a restart the app hasn't checked the instance yet; ask it to check now.
if (full && !st.body) st = await call('/api/status/check', { method: 'POST' });
if (full) check('status', st.status === 200, st.body ? `${st.body.name ?? st.body.url} ${st.body.state}` : 'no instance connected');

// Live stream: open it and expect the ping or an event quickly.
if (full) {
  const live = await fetch(base + '/api/events', { headers: { Authorization: `Bearer ${token}` } });
  check('live stream opens', live.status === 200 && (live.headers.get('content-type') ?? '').includes('text/event-stream'));
  await live.body?.cancel();
}

if (full && st.body?.state === 'awake') {
  const f = await call('/api/features?q=performance%20analytics');
  // /api/features answers { features, problems }: a refused or failed check is a problem, never an empty result.
  const found = f.body?.features ?? [], problems: string[] = f.body?.problems ?? [];
  check('features search', f.status === 200 && Array.isArray(found) && found.length > 0, `${found.length} results in ${f.ms} ms${problems.length ? ` (couldn't check: ${problems.join('; ').slice(0, 200)})` : ''}`);
  check('features speed', f.ms < BUDGET.features, `${f.ms} ms (budget ${BUDGET.features})`);
}

const p = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'smoke test (delete me)' }) });
const item = await call('/api/board', { method: 'POST', body: JSON.stringify({ project_id: p.body.id, kind: 'note', title: 'smoke' }) });
check('board round trip', item.status === 200, `${item.ms} ms`);
if (full) check('board speed', item.ms < BUDGET.board, `${item.ms} ms (budget ${BUDGET.board})`);
await call(`/api/board/${item.body.id}`, { method: 'DELETE' });
if (full) {
  const m = await call('/api/memories', { method: 'POST', body: JSON.stringify({ text: 'smoke test memory' }) });
  check('memory round trip', m.status === 200 && (await call(`/api/memories/${m.body.id}`, { method: 'DELETE' })).status === 200);
}
await call(`/api/projects/${p.body.id}`, { method: 'DELETE' });

const perf = full ? await call('/api/perf') : null;
const fw = perf?.body?.first_word?.p50;
if (perf) check('speed record', perf.status === 200, perf.body?.answers ? `${perf.body.answers} answers, first word p50 ${fw} ms` : 'no answers yet');
// Only judge speed once there are enough answers for a typical value to mean something.
if (perf && fw && (perf.body?.answers ?? 0) >= 5) check('first sign of life speed', fw < BUDGET.perfFirstWordP50, `${fw} ms (budget ${BUDGET.perfFirstWordP50})`);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
