import { join } from 'node:path';
import type { DatabaseSync as Db } from 'node:sqlite';
import { DOCS_DIR } from './config.ts';

const { DatabaseSync } = await import('node:sqlite');

// One read-only connection per local docs release, opened on first use and reused across answers.
const open = new Map<string, Db>();
export function lazyDb(release: string): Db {
  let db = open.get(release);
  if (!db) { db = new DatabaseSync(join(DOCS_DIR, `${release}.db`), { readOnly: true }); open.set(release, db); }
  return db;
}
// After a rebuild replaced the file, the next read opens the new one.
export function closeDb(release: string) { open.get(release)?.close(); open.delete(release); }
