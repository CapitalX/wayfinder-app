import { describe, expect, it } from 'vitest';
import { atfResult, buildProgress } from '../src/web/buildProgress.ts';
import type { Block, Message } from '../src/web/api.ts';

let n = 0;
const tool = (name: string, status: 'running' | 'done' | 'error' | 'denied' = 'done', result?: unknown): Block =>
  ({ type: 'tool', id: `t${n++}`, name: `mcp__build__${name}`, input: {}, status, ...(result ? { result: JSON.stringify(result) } : {}) });
const notice = (text: string, extra: Partial<Extract<Block, { type: 'notice' }>> = {}): Block => ({ type: 'notice', level: 'info', text, ...extra });
const msgs = (...blocks: Block[]): Message[] => [{ id: 'm1', role: 'assistant', blocks, created_at: 0 } as unknown as Message];
const states = (p: ReturnType<typeof buildProgress>) => Object.fromEntries(p!.steps.map((s) => [s.key, s.state]));

describe('build progress', () => {
  it('is nothing until Pip uses a build tool', () => {
    expect(buildProgress(msgs({ type: 'text', text: 'hi' }), null)).toBeNull();
  });

  it('waits on the user after the plan, and counts it approved once files are written', () => {
    const waiting = buildProgress(msgs(tool('propose_app')), null)!;
    expect(states(waiting).plan).toBe('now');
    expect(waiting.steps[0].detail).toBe('waiting for your OK');
    const approved = buildProgress(msgs(tool('propose_app'), tool('write_app_file')), null)!;
    expect(approved.steps[0]).toMatchObject({ label: 'Plan approved', detail: 'by you', state: 'done' });
  });

  it('is live while a build tool runs in the answer being streamed', () => {
    const p = buildProgress(msgs(tool('propose_app')), [tool('write_app_file', 'running')])!;
    expect(p.live).toBe(true);
    expect(states(p).write).toBe('now');
    expect(buildProgress(msgs(tool('propose_app')), null)!.live).toBe(false);
  });

  it('only claims the sandbox when the build says it ran in one', () => {
    const before = buildProgress(msgs(tool('write_app_file')), null)!.steps[2];
    expect(before.label).toBe('Build');
    const inBox = buildProgress(msgs(tool('build_app', 'done', { ok: true, sandboxed: true })), null)!.steps[2];
    expect(inBox).toMatchObject({ label: 'Build in a sandbox', detail: 'no keys, no network', state: 'done' });
    const off = buildProgress(msgs(tool('build_app', 'done', { ok: true, sandboxed: false })), null)!.steps[2];
    expect(off.label).toBe('Build');
    expect(off.detail).toMatch(/sandbox is off/);
  });

  it('takes the last build: a failed one after a good one is an error', () => {
    const p = buildProgress(msgs(tool('build_app', 'done', { ok: true }), tool('build_app', 'done', { ok: false, errors: [] })), null)!;
    expect(states(p).build).toBe('error');
  });

  it('keeps install going until the note says how it ended', () => {
    expect(states(buildProgress(msgs(tool('install_app')), null)).install).toBe('now');
    expect(states(buildProgress(msgs(tool('install_app'), notice('Loaner is installed on the PDI.')), null)).install).toBe('done');
    expect(states(buildProgress(msgs(tool('install_app'), notice('Loaner failed to install after 2 min.')), null)).install).toBe('error');
  });

  it('ends with the test score from the ATF note that follows the last run', () => {
    const running = buildProgress(msgs(tool('run_app_tests')), null)!;
    expect(states(running).test).toBe('now');
    expect(running.tests).toBeNull();
    const card = { kind: 'atf' as const, ok: true, title: 'all passed', stats: [{ label: 'Passed', value: 4 }, { label: 'Failed', value: 0 }] };
    const passed = buildProgress(msgs(tool('run_app_tests'), notice('Loaner tests finished after 3 min. 4 passed, 0 failed.', { card })), null)!;
    expect(passed.tests).toEqual({ passed: 4, failed: 0 });
    expect(passed.steps[4]).toMatchObject({ state: 'done', detail: '4 of 4 tests passed' });
    // A new run hides the old score until its own note arrives.
    const rerun = buildProgress(msgs(tool('run_app_tests'), notice('x finished after 1 min. 3 passed, 1 failed.'), tool('run_app_tests')), null)!;
    expect(rerun.tests).toBeNull();
    expect(states(rerun).test).toBe('now');
  });

  it('reads the score from the note text when there is no card', () => {
    expect(atfResult({ type: 'notice', level: 'error', text: 'Suite failed after 2 min. 3 passed, 2 failed.' })).toEqual({ passed: 3, failed: 2 });
    expect(atfResult({ type: 'notice', level: 'info', text: 'Something else.' })).toBeNull();
  });
});
