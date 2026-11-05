import type { Block, Message } from './api.ts';

// Where a Build chat is: Plan → Write → Build → Install → Test, read from what has happened in the chat. The strip
// above the conversation and the timeline in the work area both draw this.
export type StepState = 'todo' | 'now' | 'done' | 'error';
export interface BuildStep { key: string; short: string; label: string; detail: string; state: StepState }
export interface BuildProgress { steps: BuildStep[]; tests: { passed: number; failed: number } | null; live: boolean }

type Tool = Extract<Block, { type: 'tool' }>;
type Notice = Extract<Block, { type: 'notice' }>;

const T = {
  plan: ['mcp__build__propose_app'],
  write: ['mcp__build__write_app_file', 'mcp__build__delete_app_file'],
  build: ['mcp__build__build_app'],
  install: ['mcp__build__install_app'],
  test: ['mcp__build__run_app_tests'],
};
const of = (tools: Tool[], names: string[]) => tools.filter((t) => names.includes(t.name));

// The ATF job's note when it finishes: "<suite> finished after 3 min. 4 passed, 1 failed." (jobs.ts), with a card.
export function atfResult(n: Notice): { passed: number; failed: number } | null {
  if (n.card?.kind === 'atf') {
    const stat = (l: string) => Number(n.card?.stats?.find((s) => s.label === l)?.value ?? 0);
    return { passed: stat('Passed'), failed: stat('Failed') };
  }
  const m = /(\d+) passed, (\d+) failed\./.exec(n.text);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

export function buildProgress(messages: Message[], draft: Block[] | null): BuildProgress | null {
  const blocks = [...messages.flatMap((m) => m.blocks), ...(draft ?? [])];
  const tools = blocks.filter((b): b is Tool => b.type === 'tool');
  if (!tools.some((t) => t.name.startsWith('mcp__build__'))) return null;
  const notices = blocks.filter((b): b is Notice => b.type === 'notice');
  const running = (ts: Tool[]) => ts.some((t) => t.status === 'running');
  const done = (ts: Tool[]) => ts.some((t) => t.status === 'done');
  const failed = (ts: Tool[]) => ts.some((t) => t.status === 'error' || t.status === 'denied');
  const simple = (ts: Tool[]): StepState => running(ts) ? 'now' : done(ts) ? 'done' : failed(ts) ? 'error' : 'todo';

  // Plan: the card waits for the user's Approve; writing files means it was approved.
  const plan = of(tools, T.plan), write = of(tools, T.write);
  const planState: StepState = running(plan) ? 'now' : write.length ? 'done' : done(plan) ? 'now' : failed(plan) ? 'error' : 'todo';

  // Build: the last build decides. Its result says whether it ran in the sandbox; until then the caption claims nothing.
  const builds = of(tools, T.build), lastBuild = builds[builds.length - 1];
  const buildState: StepState = running(builds) ? 'now' : !lastBuild ? 'todo' : /"ok":\s*true/.test(lastBuild.result ?? '') ? 'done' : 'error';
  const sandboxed = /"sandboxed":\s*true/.test(lastBuild?.result ?? '') ? true : /"sandboxed":\s*false/.test(lastBuild?.result ?? '') ? false : null;

  // Install runs in the background after the tool returns; its note says how it ended.
  const installs = of(tools, T.install);
  const installState: StepState = running(installs) ? 'now'
    : notices.some((n) => /is installed on the PDI/.test(n.text)) ? 'done'
    : notices.some((n) => /failed to install|failed to build/.test(n.text)) ? 'error'
    : done(installs) ? 'now' : failed(installs) ? 'error' : 'todo';

  // Tests: run_app_tests only starts the ATF job; the result comes later as a note, after the last run.
  const runs = of(tools, T.test);
  const lastRun = blocks.lastIndexOf(runs[runs.length - 1] as Block);
  const result = lastRun < 0 ? null : blocks.slice(lastRun + 1).filter((b): b is Notice => b.type === 'notice').map(atfResult).find(Boolean) ?? null;
  const testState: StepState = running(runs) ? 'now' : result ? (result.failed ? 'error' : 'done') : done(runs) ? 'now' : failed(runs) ? 'error' : 'todo';

  const steps: BuildStep[] = [
    { key: 'plan', short: 'Plan', label: planState === 'done' ? 'Plan approved' : 'Plan', detail: planState === 'done' ? 'by you' : done(plan) ? 'waiting for your OK' : 'what the app will do', state: planState },
    { key: 'write', short: 'Write', label: 'Write the app', detail: 'ServiceNow SDK', state: simple(write) },
    { key: 'build', short: 'Build', label: sandboxed ? 'Build in a sandbox' : 'Build', detail: sandboxed ? 'no keys, no network' : sandboxed === false ? 'sandbox is off on this computer' : 'checks the code before install', state: buildState },
    { key: 'install', short: 'Install', label: 'Install', detail: 'on your instance', state: installState },
    { key: 'test', short: 'Test', label: 'Run tests', detail: result ? `${result.passed} of ${result.passed + result.failed} tests passed` : done(runs) && !running(runs) ? 'running on your instance' : 'automated', state: testState },
  ];
  return { steps, tests: result, live: tools.some((t) => t.status === 'running' && t.name.startsWith('mcp__build__')) };
}
