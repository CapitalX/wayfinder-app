import { describe, expect, it } from 'vitest';
import { inferMode } from '../src/web/route.ts';

describe('inferMode', () => {
  it.each([
    ['Build an equipment loaner app with due dates', 'build'],
    ['Create a tracker for laptop loans', 'build'],
    ['An asset intake app for the service desk', 'build'],
    ['Mock up a workspace landing page for remediation owners', 'mockup'],
    ['What would an onboarding portal page look like?', 'mockup'],
    ['INC0010009 is P1 but nobody is assigned', 'debug'],
    ['Why does my scheduled job fail every night?', 'debug'],
    ['Should I use a custom table or extend task?', 'decide'],
    ['Flow Designer vs business rules for approvals', 'decide'],
    ['How are ACLs evaluated?', 'explore'],
    ['Teach me Performance Analytics', 'explore'],
  ])('%s → %s', (text, mode) => expect(inferMode(text)).toBe(mode));
});
