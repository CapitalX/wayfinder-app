import { describe, expect, it } from 'vitest';
import { soundsUnfinished } from '../src/web/useVoice.ts';

describe('soundsUnfinished', () => {
  it.each([
    'check the loan table and',
    'check the loan table and…',
    'look at the incident, ',
    'compare it with the',
    'um',
    'so maybe we could use flow designer because',
    'AND',
  ])('waits for more after %j', (t) => expect(soundsUnfinished(t)).toBe(true));

  it.each([
    'check the loan table',
    'what is a business rule?',
    'turn on the plugin.',
    'show me INC0010009',
    'sandwich', // ends in "and" only inside a word
    'operator', // ends in "or" only inside a word
  ])('sends %j', (t) => expect(soundsUnfinished(t)).toBe(false));
});
