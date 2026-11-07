import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

// An update about to restart the app (`wayfinder update`) first writes <data>/updating.json,
// {"until": <ms>}. While it's there, new answers don't start in a server that's about to stop: a send gets a 503 that
// says so, and the page sends it again once the new server answers. The new server clears it when it starts; `until`
// ends a window an update left behind.
export const UPDATING_FILE = join(DATA_DIR, 'updating.json');
export const UPDATING = 'Wayfinder is updating, starting in a moment.';

// Fails closed: a marker that's there but can't be read or makes no sense holds answers until something removes it
// (the update when it ends, or the next server when it starts). Only a readable `until` can end a window by itself.
export function updating(now = Date.now()): boolean {
  try { statSync(UPDATING_FILE); } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
  let until: unknown;
  try { until = JSON.parse(readFileSync(UPDATING_FILE, 'utf8'))?.until; } catch { return true; }
  return typeof until === 'number' && Number.isFinite(until) ? until > now : true;
}

export function clearUpdating() { rmSync(UPDATING_FILE, { force: true }); }
