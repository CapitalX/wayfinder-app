import { describe, expect, it } from 'vitest';
import { workedMs, workLimitNote } from '../src/server/budget.ts';
import { MODE_CONFIG } from '../src/server/prompts.ts';

describe('working time of one answer', () => {
  const min = 60_000;
  it('is wall time minus time spent waiting on approval cards', () => {
    expect(workedMs(30 * min, 0, 0, [])).toBe(30 * min);
    expect(workedMs(30 * min, 0, 10 * min, [])).toBe(20 * min);
    expect(workedMs(30 * min, 0, 10 * min, [25 * min])).toBe(15 * min); // a card open for the last 5 minutes
  });
  it('says plainly why it stopped and how to go on', () => {
    expect(workLimitNote(45, 'build')).toMatch(/Stopped after 45 minutes of work, the limit for one build answer\. Say "continue"/);
  });
  it('gives every mode a limit, longest for Build', () => {
    const limits = Object.values(MODE_CONFIG).map((m) => m.maxMinutes);
    expect(limits.every((m) => m > 0)).toBe(true);
    expect(MODE_CONFIG.build.maxMinutes).toBe(Math.max(...limits));
  });
});
