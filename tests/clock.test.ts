import { afterEach, describe, expect, it } from 'vitest';
import { settings } from '../src/server/db.ts';
import { isoDay, nowWords, parts, validZone, zone, zoned } from '../src/server/clock.ts';
import { nextRun } from '../src/server/routines.ts';
import { systemPrompt } from '../src/server/prompts.ts';
import { noteText } from '../src/server/facts.ts';

afterEach(() => settings.set({ timeZone: '' }));

describe('the user\'s clock', () => {
  it('accepts a real zone and falls back to the process zone otherwise', () => {
    expect(validZone('America/Chicago')).toBe(true);
    for (const bad of ['Mars/Olympus', '', 42, null, 'x'.repeat(65)]) expect(validZone(bad)).toBe(false);
    settings.set({ timeZone: 'Pacific/Auckland' });
    expect(zone()).toBe('Pacific/Auckland');
    settings.set({ timeZone: '' });
    expect(zone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
  it('reads wall-clock parts and finds the instant for a wall time, across a DST switch', () => {
    // 2026-10-29 14:00Z is 09:00 Thursday in Chicago (CDT), 03:00 Friday in Auckland (NZDT).
    const t = Date.UTC(2026, 9, 29, 14);
    expect(parts(t, 'America/Chicago')).toMatchObject({ y: 2026, m: 10, d: 29, h: 9, weekday: 4 });
    expect(parts(t, 'Pacific/Auckland')).toMatchObject({ y: 2026, m: 10, d: 30, h: 3, weekday: 5 });
    expect(zoned(2026, 10, 29, 9, 'America/Chicago')).toBe(t);
    // Chicago leaves DST on 1 Nov 2026: 08:00 is 13:00Z before, 14:00Z after.
    expect(zoned(2026, 10, 31, 8, 'America/Chicago')).toBe(Date.UTC(2026, 9, 31, 13));
    expect(zoned(2026, 11, 2, 8, 'America/Chicago')).toBe(Date.UTC(2026, 10, 2, 14));
  });
  it('schedules routines on the user\'s clock, not the machine\'s', () => {
    const from = Date.UTC(2026, 9, 29, 14);   // Thu 09:00 Chicago, Fri 03:00 Auckland
    expect(nextRun({ every: 'day', hour: 8, weekday: 0 }, from, 'America/Chicago')).toBe(Date.UTC(2026, 9, 30, 13));
    expect(nextRun({ every: 'day', hour: 8, weekday: 0 }, from, 'Pacific/Auckland')).toBe(Date.UTC(2026, 9, 29, 19));
    // Monday 08:00 Chicago after the DST switch stays 08:00 on the wall: 14:00Z, not 13:00Z.
    expect(nextRun({ every: 'week', hour: 8, weekday: 1 }, from, 'America/Chicago')).toBe(Date.UTC(2026, 10, 2, 14));
    // Daily runs step on the wall calendar through the switch.
    const sat = nextRun({ every: 'day', hour: 8, weekday: 0 }, Date.UTC(2026, 9, 31, 14), 'America/Chicago');
    expect(sat).toBe(Date.UTC(2026, 10, 1, 14));
    expect(nextRun({ every: 'hour', hour: 8, weekday: 0 }, from + 1, 'Pacific/Auckland')).toBe(from + 3_600_000);
  });
  it('tells Pip the time in the user\'s zone and dates notes by it', () => {
    settings.set({ timeZone: 'Pacific/Auckland' });
    const at = new Date(Date.UTC(2026, 9, 29, 14));
    expect(nowWords(at)).toMatch(/^Friday,? 30 October 2026 at 03:00 \(Pacific\/Auckland\)$/);
    expect(isoDay(at)).toBe('2026-10-30');
    expect(noteText({ changed: ['a'], why: 'w', risk: 'r' }, at)).toContain('[Wayfinder 2026-10-30]');
    const prompt = systemPrompt('explore', undefined, settings.get(), { release: 'zurich', now: at });
    expect(prompt).toMatch(/Now: Friday,? 30 October 2026 at 03:00 \(Pacific\/Auckland\)/);
    expect(prompt).toContain('the instance stores and shows UTC');
  });
});
