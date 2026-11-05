import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASELINE, GROWTH_LIMIT, measure, overLimit } from '../ops/context-size.ts';

// What each mode sends before the user's first word (system prompt + Wayfinder's tool definitions). A change that
// grows a mode by more than 15% fails here; if that's intended, run `npm run eval:baseline` and commit the new file.
describe('context size per mode', () => {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));

  it('stays within 15% of the baseline in every mode', async () => {
    const now = await measure();
    expect(Object.keys(now).sort()).toEqual(Object.keys(base).sort());
    expect(overLimit(now, base), 'Run `npm run eval:baseline` and commit it if the growth is intended.').toEqual([]);
  });

  it('flags only growth past the limit, and says by how much', () => {
    const b = { explore: { total: 1000 } };
    expect(GROWTH_LIMIT).toBe(0.15);
    expect(overLimit({ explore: { total: 1150 } }, b)).toEqual([]);
    expect(overLimit({ explore: { total: 1200 } }, b)).toEqual(['explore: 1200 characters, 20% more than the baseline 1000']);
    expect(overLimit({ explore: { total: 500 } }, b)).toEqual([]);
  });
});
