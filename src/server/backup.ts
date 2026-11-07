import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_DIR } from './config.ts';
import type { Instance } from './db.ts';
import { table } from './sn.ts';

// Saves every in-progress update set as an XML file in the "unload" format that
// System Update Sets > Retrieved Update Sets > Import Update Set from XML accepts.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const field = (name: string, value: unknown) => `<${name}>${esc(String(value ?? ''))}</${name}>`;
const slug = (s: string) => s.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'update-set';

// Sets are fetched a few at a time: quicker than one by one, without hammering a small developer instance.
const PARALLEL = 4;
// Dated backup folders kept per instance; older ones are removed after each backup.
export const KEEP = 8;
// The most sets and records per set one backup takes. A backup that hits either says so in its index (truncated),
// instead of looking complete.
export const MAX_SETS = 200, MAX_RECORDS = 5000;

// Written beside the target, then renamed over it: a crash mid-write never leaves half a file that looks whole.
function writeWhole(file: string, text: string) {
  writeFileSync(`${file}.part`, text);
  renameSync(`${file}.part`, file);
}

export const backupWeek = (now = Date.now()) => `${new Date(now).getUTCFullYear()}-${Math.floor((now / 86_400_000 + 4) / 7)}`;
const hostDir = (inst: Instance) => join(BACKUP_DIR, new URL(inst.url).hostname);
const stateFile = (inst: Instance) => join(hostDir(inst), 'last-backup.json');

// The weekly backup is due when this instance has no backup for this week yet. Kept on disk, so a restart (and
// updates restart the app) doesn't start another one.
export function backupDue(inst: Instance, week = backupWeek()): boolean {
  try { return JSON.parse(readFileSync(stateFile(inst), 'utf8')).week !== week; } catch { return true; }
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function backupUpdateSets(inst: Instance) {
  const sets = await table(inst, 'sys_update_set', 'state=in progress^nameNOT LIKEDefault', 'sys_id,name,description,application,release_date,state', MAX_SETS);
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = join(hostDir(inst), stamp);
  mkdirSync(dir, { recursive: true });

  const saved = await inBatches(sets, PARALLEL, async (set) => {
    const rows = await table(inst, 'sys_update_xml', `update_set=${set.sys_id}`, 'sys_id,name,action,type,target_name,table,application,category,payload,update_domain,view,replace_on_upgrade,update_guid', MAX_RECORDS);
    const head = [
      '<sys_remote_update_set action="INSERT_OR_UPDATE">',
      field('application', set.application), field('description', set.description), field('name', set.name),
      field('release_date', set.release_date), field('remote_sys_id', set.sys_id), field('state', 'loaded'),
      field('sys_id', set.sys_id),
      '</sys_remote_update_set>',
    ].join('');
    const body = rows.map((r) => [
      '<sys_update_xml action="INSERT_OR_UPDATE">',
      field('action', r.action), field('application', r.application), field('category', r.category), field('name', r.name),
      field('payload', r.payload), field('remote_update_set', set.sys_id), field('replace_on_upgrade', r.replace_on_upgrade),
      field('sys_id', r.sys_id), field('table', r.table), field('target_name', r.target_name), field('type', r.type),
      field('update_domain', r.update_domain), field('update_guid', r.update_guid), field('update_set', ''), field('view', r.view),
      '</sys_update_xml>',
    ].join('')).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><unload unload_date="${new Date().toISOString().replace('T', ' ').slice(0, 19)}">\n${head}\n${body}\n</unload>\n`;
    const file = join(dir, `${slug(set.name)}-${slug(String(set.sys_id).slice(0, 8))}.xml`);
    writeWhole(file, xml);
    return { name: set.name as string, records: rows.length, file, ...(rows.length >= MAX_RECORDS ? { truncated: true } : {}) };
  });
  // Truncated: there may be more sets or records than one backup takes; the index says so rather than looking complete.
  const truncated = sets.length >= MAX_SETS || saved.some((s) => s.truncated);
  writeWhole(join(dir, 'index.json'), JSON.stringify({ instance: inst.url, at: new Date().toISOString(), complete: !truncated, ...(truncated ? { truncated: { sets_limit: sets.length >= MAX_SETS, sets_cut: saved.filter((s) => s.truncated).map((s) => s.name) } } : {}), sets: saved }, null, 2));
  // Only now, with every file written, does this week count as backed up.
  writeWhole(stateFile(inst), JSON.stringify({ week: backupWeek(), at: new Date().toISOString(), complete: !truncated }));
  const removed = prune(inst);
  return { dir, sets: saved, removed, complete: !truncated };
}

// Keeps the newest KEEP dated folders for this instance (names are YYYY-MM-DD, so they sort by date).
function prune(inst: Instance): string[] {
  const root = hostDir(inst);
  if (!existsSync(root)) return [];
  const dated = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const old = dated.slice(0, Math.max(0, dated.length - KEEP));
  for (const d of old) rmSync(join(root, d), { recursive: true, force: true });
  return old;
}
