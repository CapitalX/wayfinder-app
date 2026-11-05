import { instances, settings } from './db.ts';
import { pdiStatus, type PdiStatus } from './sn.ts';
import { backupDue, backupUpdateSets, backupWeek } from './backup.ts';
import { checkAccess, parse as parseAccess } from './access.ts';

// Watches the active PDI: awake or hibernating, and days since the owner's last interactive login.
// ServiceNow reclaims PDIs older than 90 days after 10 days without a login, and API calls don't count,
// so the app can only remind; the owner has to log in. The in-app banner reads currentStatus(); phone pushes
// can come from any external watcher that polls GET /api/status with the status-only token.

let last: (PdiStatus & { instanceId: string; url: string; remind: boolean }) | null = null;
let running = '';

export const currentStatus = () => last;

export async function checkNow() {
  const inst = instances.active();
  if (!inst) { last = null; return null; }
  const status = await pdiStatus(inst);
  const { reminderDays } = settings.get();
  const remind = status.state === 'hibernating' || (status.daysSinceLogin ?? 0) >= reminderDays;
  last = { ...status, instanceId: inst.id, url: inst.url, remind };
  // Keep the access profile fresh (roles change): re-check when it's missing or older than six hours.
  const profile = parseAccess(inst);
  if (status.state === 'awake' && (!profile || Date.now() - profile.checkedAt > 6 * 3_600_000)) checkAccess(inst).catch(() => {});

  // Weekly copy of in-progress update sets, so a reclaimed PDI costs little.
  // Due once per week per instance (recorded on disk after a backup succeeds); the in-memory mark only stops a second
  // run starting while one is going. A failed backup is tried again at the next check.
  const week = backupWeek();
  if (status.state === 'awake' && running !== `${inst.id}:${week}` && backupDue(inst, week)) {
    running = `${inst.id}:${week}`;
    backupUpdateSets(inst).catch((e) => { console.error('backup failed', e); running = ''; });
  }
  return last;
}

export function startMonitor() {
  const tick = () => checkNow().catch((e) => console.error('monitor', e));
  setTimeout(tick, 5_000);
  setInterval(tick, 6 * 60 * 60_000);
}
