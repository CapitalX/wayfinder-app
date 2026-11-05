import { describe, expect, it, vi } from 'vitest';

// The rule-drafting call is mocked: it answers with a rule for whatever lesson it was given.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: string }) => (async function* () {
    const id = /id: (\S+)/.exec(prompt)?.[1];
    yield { type: 'result', subtype: 'success', result: JSON.stringify([{ id, rule: 'instance query_records: use gs.hoursAgo(n), not hoursAgoStart.' }]) };
  })(),
}));
// This file mocks the SDK's query itself, so small jobs use the real runner (which then calls the mock).
(await import('../src/server/smallJob.ts')).setSmallJobRunner();

const { toolLessons } = await import('../src/server/db.ts');
const { lessonRecorder, toolTips } = await import('../src/server/toolLessons.ts');
const { logQuery, pattern } = await import('../src/server/logs.ts');

describe('learning from bad calls', () => {
  const bad = { table: 'syslog', query: 'level=2^sys_created_on>=javascript:gs.hoursAgoStart(24)' };
  const good = { table: 'syslog', query: 'level=2^sys_created_on>=javascript:gs.hoursAgo(24)' };
  const err = 'Error: Query contains unsafe JavaScript expression: "javascript:gs.hoursAgoStart(24)…". (Code: VALIDATION_ERROR)';

  it('a failure followed by a working call becomes a rule in the prompt', async () => {
    const r = lessonRecorder();
    r.failed('mcp__instance__query_records', bad, err);
    expect(toolLessons.list('miss')).toHaveLength(1);
    r.worked('mcp__instance__query_records', good);
    await vi.waitFor(() => expect(toolLessons.list('learned')).toHaveLength(1));
    const l = toolLessons.list('learned')[0];
    expect(l.failed).toContain('hoursAgoStart');
    expect(l.worked).toContain('hoursAgo(24)');
    expect(toolTips()).toContain('use gs.hoursAgo(n)');
  });

  it('the same mistake again counts on the same lesson', () => {
    const r = lessonRecorder();
    r.failed('mcp__instance__query_records', bad, err.replace('24', '48'));
    expect(toolLessons.list().filter((l) => l.tool === 'mcp__instance__query_records')).toHaveLength(1);
  });

  it('ignores refusals, sign-in problems and timeouts', () => {
    const r = lessonRecorder();
    for (const e of ['Error: HTTP 403 insufficient_privileges', 'Error: 401 sign-in failed', 'Error: request timed out', 'This account cannot install plugins'])
      r.failed('mcp__instance__get_record', { table: 'x' }, e);
    expect(toolLessons.list().filter((l) => l.tool === 'mcp__instance__get_record')).toHaveLength(0);
  });

  it('removed rules leave the prompt', () => {
    const l = toolLessons.list('learned')[0];
    toolLessons.update(l.id, { status: 'removed' });
    expect(toolTips()).toBe('');
  });
});

describe('log tool', () => {
  it('builds a safe query with the allowed date function', () => {
    expect(logQuery({ hours: 6, level: 'error', source: 'Script^x', exclude_sources: ['UADownloader'] }))
      .toBe('sys_created_on>=javascript:gs.hoursAgo(6)^level=2^sourceLIKEScript x^sourceNOT LIKEUADownloader');
  });
  it('groups messages that differ only in ids, numbers and values', () => {
    expect(pattern("Record 0123456789abcdef0123456789abcdef not found in 'incident' after 34 ms"))
      .toBe(pattern("Record fedcba9876543210fedcba9876543210 not found in 'problem' after 7 ms"));
  });
});
