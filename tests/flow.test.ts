import { describe, expect, it } from 'vitest';
import { guardrails } from '../src/server/guardrails.ts';
import { ghostFor } from '../src/web/components/Ghost.tsx';
import { formatAnswers, parseQuestions } from '../src/web/components/Questions.tsx';

const run = async (g: ReturnType<typeof guardrails>, ev: 'PostToolUse' | 'PostToolUseFailure', input: object) =>
  (await (g[ev]![0].hooks[0] as any)(input, undefined, { signal: new AbortController().signal })) as any;

describe('guardrails', () => {
  it('turns a 403 into "do not retry"', async () => {
    const g = guardrails();
    const r = await run(g, 'PostToolUseFailure', { tool_name: 'mcp__instance__query_records', error: 'HTTP 403 insufficient_privileges' });
    expect(r.hookSpecificOutput.additionalContext).toMatch(/Don't retry/);
  });

  it('stops the same tool after three failures', async () => {
    const g = guardrails();
    const input = { tool_name: 'mcp__build__build_app', error: 'something odd' };
    expect(await run(g, 'PostToolUseFailure', input)).toEqual({});
    await run(g, 'PostToolUseFailure', input);
    const third = await run(g, 'PostToolUseFailure', input);
    expect(third.hookSpecificOutput.additionalContext).toMatch(/failed 3 times/);
  });

  it('a success resets the count and says nothing', async () => {
    const g = guardrails();
    expect(await run(g, 'PostToolUse', { tool_name: 't', tool_response: { content: 'ok' } })).toEqual({});
  });
});

describe('ghost text', () => {
  const c = ['Mock up the form for my Loan table', 'What has changed on my instance?'];
  it('completes a known start, case-insensitively', () => expect(ghostFor('mock up the', c)).toBe(' form for my Loan table'));
  it('needs three characters and no newline', () => {
    expect(ghostFor('Mo', c)).toBe('');
    expect(ghostFor('Mock\nup', c)).toBe('');
  });
  it('offers nothing for a full match or no match', () => {
    expect(ghostFor('What has changed on my instance?', c)).toBe('');
    expect(ghostFor('Why is', c)).toBe('');
  });
});

describe('questions block', () => {
  const body = JSON.stringify({ title: 'A few things', questions: [
    { id: 'who', text: 'Who uses it?', kind: 'choice', options: ['IT', 'Everyone'], default: 'IT' },
    { id: 'notify', text: 'Reminders?', kind: 'yesno' },
    { id: 'extra', text: 'Anything else?', kind: 'text' },
  ], exits: ['Use what is built in'] });

  it('parses the object and the bare-array forms, rejects junk', () => {
    expect(parseQuestions(body)?.questions).toHaveLength(3);
    expect(parseQuestions('[{"id":"a","text":"Q?"}]')?.questions).toHaveLength(1);
    expect(parseQuestions('{"questions": [')).toBeNull();
    expect(parseQuestions('{"questions": [{"id": 1}]}')).toBeNull();
  });

  it('formats answers as one readable message, blanks left to Pip', () => {
    const set = parseQuestions(body)!;
    const msg = formatAnswers(set, { who: 'IT', notify: 'Yes', extra: '' }, { who: 'mostly the service desk' });
    expect(msg).toBe('My answers:\n- Who uses it? → IT (mostly the service desk)\n- Reminders? → Yes\n- Anything else? → (your call)');
  });
});
