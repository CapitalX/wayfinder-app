import { describe, expect, it } from 'vitest';
import { memoryRejection } from '../src/server/projectTools.ts';

const lesson = 'Vulnerability Response has a multithreaded background job processor; use it instead of a plain scheduled job.';

describe('memory suggestion gates', () => {
  it('accepts a fresh ServiceNow lesson', () => {
    expect(memoryRejection(lesson, false, [])).toBeNull();
  });

  it.each([
    'check_features is slow on this instance, so call it once.',
    'The read_script tool uses from_line for paging.',
    'Wayfinder clips long results, so ask for fewer fields.',
    'Use mcp__pdi__show for forms.',
    'The pdi show card hides related lists.',
    'This tool cannot read syslog.',
  ])('rejects notes about its own tools: %j', (t) => {
    expect(memoryRejection(t, false, [])).toMatch(/own tools/);
  });

  it('allows one suggestion per answer', () => {
    expect(memoryRejection(lesson, true, [])).toMatch(/one memory suggestion per answer/);
  });

  it('rejects a near-duplicate and says whether it was saved or suggested', () => {
    const reworded = 'Use the multithreaded background job processor from Vulnerability Response rather than a scheduled job.';
    expect(memoryRejection(reworded, false, [{ text: lesson, status: 'saved' }])).toMatch(/^Already remembered/);
    expect(memoryRejection(reworded, false, [{ text: lesson, status: 'proposed' }])).toMatch(/^Already suggested/);
  });

  it('keeps lessons that only share a few words', () => {
    const other = 'Prefer Flow Designer subflows over workflow activities for new catalog fulfillment.';
    expect(memoryRejection(other, false, [{ text: lesson, status: 'saved' }])).toBeNull();
  });
});
