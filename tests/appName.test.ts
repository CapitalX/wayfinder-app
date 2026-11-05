import { describe, expect, it } from 'vitest';
import { nameConfirmed } from '../src/server/appName.ts';

describe('nameConfirmed', () => {
  it('accepts a name from the interview answers', () => {
    expect(nameConfirmed('Loaner Tracker', ['Build a loaner app', '- App name? → Loaner Tracker\n- Who uses it? → IT staff'])).toBe(true);
  });
  it('ignores case, spacing and punctuation', () => {
    expect(nameConfirmed('Loaner  tracker', ['call it "loaner-tracker", please'])).toBe(true);
    expect(nameConfirmed('Asset Loans', ['Name it asset loans.'])).toBe(true);
  });
  it('refuses a name the user never wrote', () => {
    expect(nameConfirmed('Loaner Tracker', ['Build an app to track loaner laptops'])).toBe(false);
    expect(nameConfirmed('Loan', ['Build a loaner app'])).toBe(false); // whole words only
    expect(nameConfirmed('', ['anything'])).toBe(false);
  });
});
