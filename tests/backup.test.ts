import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake instance: N in-progress sets, each with two update records, and every call takes DELAY ms.
let N = 20;
let crafted = false;
let bigSet = false; // one set returns the per-set record limit
const DELAY = 50;
let inFlight = 0, peak = 0;
const snTable = vi.fn(async (_i: unknown, name: string, q: string) => {
  inFlight++; peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, DELAY));
  inFlight--;
  if (name === 'sys_update_set' && crafted) return [{ sys_id: '/../../x', name: '../../evil', application: 'global' }];
  if (name === 'sys_update_set') return Array.from({ length: N }, (_, i) => ({ sys_id: `${String(i).padStart(8, '0')}${'a'.repeat(24)}`, name: i === 1 ? 'Same name' : i === 2 ? 'Same name' : `Set ${i}`, application: 'global' }));
  if (bigSet && q.includes('00000000')) return Array.from({ length: 5000 }, (_, i) => ({ sys_id: `r${i}`, name: `rec ${i}`, payload: '<x/>' }));
  return [{ sys_id: 'x1', name: `rec for ${q}`, payload: '<record_update table="sys_script"><sys_script><script>if (a < b && c > d) {}</script></sys_script></record_update>' }, { sys_id: 'x2', name: 'rec 2', payload: '<y/>' }];
});
vi.mock('../src/server/sn.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/sn.ts')>()), table: snTable }));

const { backupDue, backupUpdateSets, backupWeek, KEEP } = await import('../src/server/backup.ts');
const { BACKUP_DIR } = await import('../src/server/config.ts');
const inst = { id: 'i1', url: 'https://dev12345.service-now.com' } as any;
const host = join(BACKUP_DIR, 'dev12345.service-now.com');

beforeEach(() => { N = 20; crafted = false; bigSet = false; peak = 0; snTable.mockClear(); });

describe('update set backup', () => {
  it('fetches a few sets at a time and saves every one, even with the same name', async () => {
    const t = Date.now();
    const r = await backupUpdateSets(inst);
    const ms = Date.now() - t;
    expect(r.sets).toHaveLength(20);
    expect(new Set(r.sets.map((s) => s.file)).size).toBe(20);
    expect(peak).toBe(4);
    // One by one this is 21 calls × 50 ms ≈ 1050 ms; four at a time it's 1 + 5 rounds ≈ 300 ms.
    expect(ms).toBeLessThan(700);
    console.log(`backup of 20 sets at ${DELAY} ms per call: ${ms} ms`);
  });

  it('is due once per week per instance, and the mark survives a restart (it is on disk)', async () => {
    await backupUpdateSets(inst);
    expect(backupDue(inst)).toBe(false);
    expect(JSON.parse(readFileSync(join(host, 'last-backup.json'), 'utf8')).week).toBe(backupWeek());
    expect(backupDue(inst, '1999-1')).toBe(true);
    expect(backupDue({ ...inst, url: 'https://dev67890.service-now.com' })).toBe(true);
  });

  it(`keeps the newest ${KEEP} dated folders`, async () => {
    for (let d = 1; d <= 12; d++) mkdirSync(join(host, `2025-01-${String(d).padStart(2, '0')}`), { recursive: true });
    mkdirSync(join(host, 'notes'), { recursive: true });
    const r = await backupUpdateSets(inst);
    const dated = readdirSync(host).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    expect(dated).toHaveLength(KEEP);
    expect(dated.at(-1)).toBe(new Date().toISOString().slice(0, 10));
    expect(r.removed).toContain('2025-01-01');
    expect(existsSync(join(host, 'notes'))).toBe(true);
  });

  it('keeps every file inside the dated folder, even with a crafted sys_id or name', async () => {
    crafted = true;
    const r = await backupUpdateSets(inst);
    expect(r.sets).toHaveLength(1);
    expect(dirname(r.sets[0].file)).toBe(r.dir);
    expect(existsSync(r.sets[0].file)).toBe(true);
  });
});

describe('what a backup can be trusted for', () => {
  const unesc = (x: string) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  it('writes files ServiceNow can import back: one remote update set and its updates, payloads intact', async () => {
    N = 3;
    const r = await backupUpdateSets(inst);
    expect(r.complete).toBe(true);
    const xml = readFileSync(r.sets[0].file, 'utf8');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><unload unload_date="[\d-]+ [\d:]+">/);
    expect(xml.match(/<sys_remote_update_set action="INSERT_OR_UPDATE">/g)).toHaveLength(1);
    const setId = /<remote_sys_id>([^<]+)<\/remote_sys_id>/.exec(xml)![1];
    const updates = xml.match(/<sys_update_xml action="INSERT_OR_UPDATE">[\s\S]*?<\/sys_update_xml>/g)!;
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u).toContain(`<remote_update_set>${setId}</remote_update_set>`);
    // The payload is XML inside XML: escaped once, so the instance reads back exactly what was exported.
    const payload = unesc(/<payload>([\s\S]*?)<\/payload>/.exec(updates[0])![1]);
    expect(payload).toBe('<record_update table="sys_script"><sys_script><script>if (a < b && c > d) {}</script></sys_script></record_update>');
    expect(readdirSync(dirname(r.sets[0].file)).some((f) => f.endsWith('.part'))).toBe(false);
  });
  it('says when a set hit the record limit, instead of looking complete', async () => {
    N = 2; bigSet = true;
    const r = await backupUpdateSets(inst);
    expect(r.complete).toBe(false);
    const index = JSON.parse(readFileSync(join(dirname(r.sets[0].file), 'index.json'), 'utf8'));
    expect(index.complete).toBe(false);
    expect(index.truncated.sets_cut).toEqual(['Set 0']);
    expect(JSON.parse(readFileSync(join(host, 'last-backup.json'), 'utf8')).complete).toBe(false);
  });
});
