import { settings } from './db.ts';

// The user's clock. The browser sends its time zone with each message (settings.timeZone), so Pip, the routines'
// schedules and dated notes follow the person, not the machine Wayfinder runs on (a server, Docker, WSL).
// Without one yet, the process's own zone.
export const validZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};
export const zone = (): string => {
  const tz = settings.get().timeZone;
  return validZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
};

// Wall-clock parts of an instant in a zone.
export function parts(ms: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
// The instant at which a zone's clock reads y-m-d h:00. Two passes, so a change of offset between the guess and the
// answer (a DST switch that day) is taken into account; a wall time that doesn't exist that day lands an hour on.
export function zoned(y: number, m: number, d: number, h: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h);
  const offset = (at: number) => { const p = parts(at, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - at; };
  const guess = wall - offset(wall);
  return wall - offset(guess);
}

export const nowWords = (at = new Date(), tz = zone()) => `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(at)} (${tz})`;
export const dayWords = (at = new Date(), tz = zone()) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(at);
export const isoDay = (at = new Date(), tz = zone()) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(at);
