import { readFileSync } from 'node:fs';
import { query, type HookCallbackMatcher, type HookEvent, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_CWD, SNDOCS_TOKEN_FILE, SNDOCS_URL } from './config.ts';
import { artifacts, board, boardKey, chats, instances, jobs, messages, perf, projects, settings, type Block } from './db.ts';
import { pdiServer } from './pdiTools.ts';
import { projectServer } from './projectTools.ts';
import { buildServer } from './buildTools.ts';
import { makeCanUseTool, type Emit } from './policy.ts';
import { prepareSkills } from './skills.ts';
import { activeMemories, guidedCount } from './memoryHub.ts';
import { contextNotice, contextTokens } from './contextBudget.ts';
import { answerCost, budgetGate, budgetNotice, heldNow, releaseBudget, reserveBudget, spentToday, stoppedEarly, type CostSnapshot } from './budget.ts';
import { firstTurn, keptThroughSummary, parseCarried } from './carryOver.ts';
import { WRITES_IN, hiddenTools } from './modeTools.ts';
import { workedMs, workLimitNote } from './budget.ts';
import { autoTitle, retitle } from './chatTitle.ts';
import { AGENTS, MODE_CONFIG, MODES, systemPrompt, type Mode } from './prompts.ts';
import { currentUpdateSet, instanceFacts, docsRelease } from './facts.ts';
import { docReleases, docsSource } from './docs.ts';
import { localDocsServer } from './docsLocal.ts';
import { noteToolResult } from './buildGate.ts';
import { guardrails } from './guardrails.ts';
import { releaseCall, releaseChat } from './instanceLock.ts';
import { lessonRecorder } from './toolLessons.ts';
import { instanceServer } from './instanceTools.ts';
import { learnRefusal } from './access.ts';
import { claudeEnv } from './claudeAccess.ts';
import { assembleToolServers, toolServers } from './toolServers.ts';
import { startLive } from './liveAnswer.ts';
import { scrub, scrubText } from './scrub.ts';

const running = new Map<string, AbortController>();

export function stop(chatId: string) {
  running.get(chatId)?.abort();
}

export const isRunning = (chatId: string) => running.has(chatId);
export const answering = () => running.size;

// A restart (an update, or the computer shutting down) ends running answers. Each one stops like a Stop click, keeps
// what it did, and says it was cut off, with Continue. An answer the process couldn't save (killed, crashed) gets the
// same note at the next start, from the answering_since mark.
export const CUT_OFF = 'Pip\'s answer was cut off: Wayfinder restarted (an update, or the computer restarting) before it finished.';
let closing = false;
export async function stopAllForRestart(waitMs = 15_000) {
  closing = true;
  for (const a of running.values()) a.abort();
  const until = Date.now() + waitMs;
  while (running.size && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}
export function noteCutOff() {
  for (const id of chats.cutOff()) {
    messages.add(id, 'assistant', [{ type: 'notice', level: 'warn', text: `${CUT_OFF} Nothing from that answer was saved; Continue asks Pip to pick it up again.`, action: 'continue' }]);
    chats.setAnswering(id, null);
  }
}

// Starting Claude can fail when its program is missing or being replaced (spawn ETXTBSY while an update writes the
// files, ENOENT, EACCES). That's no fault of the question, so say it plainly and offer Continue, not a raw error.
export const COULD_NOT_START = 'Pip couldn\'t start this answer: Wayfinder\'s files were being updated or couldn\'t be opened at that moment. Nothing was changed. Continue tries again.';
const START_CODES = new Set(['ETXTBSY', 'ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENOEXEC']);
export function couldNotStart(e: unknown): boolean {
  const err = e as { code?: unknown; syscall?: unknown; message?: unknown };
  if (typeof err?.code === 'string' && START_CODES.has(err.code) && (err.syscall === undefined || String(err.syscall).startsWith('spawn'))) return true;
  return typeof err?.message === 'string' && /\bspawn\b[^\n]*\b(ETXTBSY|ENOENT|EACCES|EPERM|EAGAIN|EMFILE|ENOEXEC)\b/.test(err.message);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

export async function runChat(chatId: string, userText: string, emit: Emit, opts: { system?: string } = {}) {
  const chat = chats.get(chatId);
  if (!chat) throw new Error('No such chat');
  if (running.has(chatId)) throw new Error('This chat is already answering');

  const s = settings.get();
  const inst = chat.instance_id ? instances.get(chat.instance_id) : undefined;
  const mode = (chat.mode in MODES ? chat.mode : 'explore') as Mode;
  const project = chat.project_id ? projects.get(chat.project_id) : undefined;

  // Messages the app starts itself (e.g. after an install) show as a short note, not as something the user typed.
  if (opts.system) messages.add(chatId, 'assistant', [{ type: 'notice', level: 'info', text: opts.system }]);
  else messages.add(chatId, 'user', [{ type: 'text', text: userText }]);
  const firstAnswer = chat.title === 'New chat' && !opts.system;
  if (chat.title === 'New chat') chats.update(chatId, { title: autoTitle(userText) });

  // The day's spending limit (Settings → Pip): once it's used up (or reserved by other chats' answers), answers wait.
  // The share this one may spend is reserved when it starts, below.
  const spentBefore = spentToday();
  const gate = budgetGate(s.dailyBudgetUsd, spentBefore, heldNow());
  if ('refuse' in gate) {
    messages.add(chatId, 'assistant', [{ type: 'notice', level: 'warn', text: gate.refuse }]);
    emit({ t: 'notice', level: 'warn', text: gate.refuse });
    emit({ t: 'done' });
    return;
  }
  // From here every event also goes to the chat's live log, so a page that opens the chat mid-answer can catch up.
  const toLive = startLive(chatId), toCaller = emit;
  emit = (event) => { toLive(event); toCaller(event); };

  const mcpServers: Record<string, McpServerConfig> = {};
  const docs = docsSource();
  if (docs === 'server')
    mcpServers.sndocs = { type: 'http', url: SNDOCS_URL, headers: { Authorization: `Bearer ${readFileSync(SNDOCS_TOKEN_FILE, 'utf8').trim()}` } };
  else if (docs === 'local') mcpServers.sndocs = localDocsServer();
  else emit({ t: 'notice', level: 'warn', text: 'The ServiceNow docs aren\'t set up on this machine, so answers won\'t cite them. Download them in Settings → Pip → ServiceNow docs, or run: wayfinder docs setup' });

  if (inst && inst.status === 'active') {
    mcpServers.instance = instanceServer(inst, WRITES_IN[mode]);
    mcpServers.pdi = pdiServer(inst, chatId, (event) => record(event));
  } else if (inst) {
    emit({ t: 'notice', level: 'info', text: `This chat belongs to a ${inst.status === 'removed' ? 'removed' : 'retired'} instance (${inst.url}); instance tools are off.` });
  }

  mcpServers.project = projectServer(project, chatId);
  if (mode === 'build') mcpServers.build = buildServer(inst?.status === 'active' ? inst : undefined, project, chatId);

  const blocks: Block[] = [];
  const toolIndex = new Map<string, Extract<Block, { type: 'tool' }>>();
  // Time spent waiting on approval cards, which doesn't count toward the answer's working-time limit.
  const waiting = new Map<string, number>();
  let waitedMs = 0;
  const record: Emit = (event) => {
    if (event.t === 'approval' && event.auto !== true) waiting.set(String(event.id), Date.now());
    if (event.t === 'approval_done' && waiting.has(String(event.id))) { waitedMs += Date.now() - waiting.get(String(event.id))!; waiting.delete(String(event.id)); }
    if (event.t === 'approval') blocks.push({ type: 'approval', id: String(event.id), tool: String(event.tool), input: event.input, auto: event.auto === true || undefined, full_permissions: event.full_permissions === true || undefined });
    if (event.t === 'approval_done') {
      const b = blocks.find((x) => x.type === 'approval' && x.id === event.id) as Extract<Block, { type: 'approval' }> | undefined;
      if (b) b.decision = event.decision as 'allow' | 'deny';
    }
    emit(event);
  };

  // Known up front so Pip doesn't spend tool calls finding them: instance facts and the docs releases available.
  const activeInst = inst?.status === 'active' ? inst : undefined;
  const [cached, releases, liveSet] = await Promise.all([activeInst ? instanceFacts(activeInst).catch(() => null) : Promise.resolve(null), docReleases(),
    activeInst ? currentUpdateSet(activeInst).catch(() => undefined) : undefined]);
  // Facts are cached ten minutes, but the update set is read fresh: another chat on this account may have switched it.
  const facts = cached && liveSet !== undefined ? { ...cached, updateSet: liveSet } : cached;
  let turns: number | null = null, costUsd: number | null = null, peakContext = 0;

  // Timings for this answer: time to the agent starting, to the first word, and each tool call.
  const t0 = Date.now();
  let startMs: number | null = null, firstWordMs: number | null = null;
  const toolStarted = new Map<string, number>();

  // A chat that continues an earlier one starts from its summary, in its first user turn (quoted data; see carryOver.ts).
  const prompt = firstTurn(parseCarried(chat.carried), userText, !!chat.session_id);

  // Skills are read fresh each answer, so an edited SKILL.md applies on the next one.
  const skills = prepareSkills(mode);

  const abort = new AbortController();
  running.set(chatId, abort);
  chats.setAnswering(chatId, Date.now());
  // One answer gets a bounded amount of working time; past it, it's stopped like a Stop click, with a note.
  const maxMinutes = MODE_CONFIG[mode].maxMinutes;
  let overTime = false;
  const workClock = setInterval(() => {
    if (workedMs(Date.now(), t0, waitedMs, waiting.values()) > maxMinutes * 60_000) { overTime = true; abort.abort(); }
  }, 15_000);
  workClock.unref();
  try {
    // Reserved here, inside the try, so every way out (done, stop, error) releases it in finally.
    const share = reserveBudget(chatId, s.dailyBudgetUsd, spentToday());
    if ('refuse' in share) throw new Error(share.refuse);
    const extraServers = await assembleToolServers(toolServers.list(), undefined, abort.signal);
    abort.signal.throwIfAborted();
    Object.assign(mcpServers, extraServers.servers);
    const unavailable = extraServers.unavailable.length ? `User tool servers unavailable for this answer: ${extraServers.unavailable.join(', ')}. Continue with the other tools.` : '';
    if (unavailable) { record({ t: 'notice', level: 'warn', text: unavailable }); blocks.push({ type: 'notice', level: 'warn', text: unavailable }); }
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        model: s.model,
        systemPrompt: systemPrompt(mode, activeInst, s, {
          project, saved: artifacts.list(project?.id ?? null), remembered: activeMemories(project?.id ?? null),
          clues: board.list(boardKey(project?.id ?? null, chatId)), facts, release: docsRelease(facts, releases), skills: skills.set, toolServers: toolServers.list().filter((s) => s.enabled), toolServerNote: unavailable,
        }),
        // Efficiency: effort and turn budget per mode, a fallback model when the main one is busy, and guardrail
        // hints after failed tools so the next step changes approach instead of retrying.
        effort: MODE_CONFIG[mode].effort,
        thinking: { type: 'adaptive' },
        fallbackModel: s.model === 'sonnet' ? 'haiku' : 'sonnet',
        tools: ['WebFetch', 'WebSearch', 'Agent', 'Skill'],
        // Wayfinder's own skills only: the plugin folder it wrote, and exactly those names (the CLI's bundled skills stay hidden).
        plugins: [skills.plugin],
        skills: skills.names,
        mcpServers,
        agents: AGENTS,
        canUseTool: makeCanUseTool(chatId, inst?.id ?? null, record, { followup: !!opts.system, mode, toolServerRevisions: extraServers.revisions }),
        // Tools this mode can't use stay out of the model's context.
        disallowedTools: hiddenTools(mode),
        includePartialMessages: true,
        settingSources: [],
        // Only the servers above: no claude.ai connectors or user-level MCP config leak in.
        strictMcpConfig: true,
        resume: chat.session_id ?? undefined,
        abortController: abort,
        maxTurns: MODE_CONFIG[mode].maxTurns,
        ...(share.maxBudgetUsd ? { maxBudgetUsd: share.maxBudgetUsd } : {}),
        // When the SDK summarises a long chat, put back what the summary mustn't lose, and keep its summary for a fresh chat.
        hooks: {
          ...withReleases(guardrails(lessonRecorder())),
          SessionStart: [{ hooks: [async (input) => {
            const kept = input.hook_event_name === 'SessionStart' && input.source === 'compact' ? keptThroughSummary(chatId, activeInst?.id ?? null) : '';
            return kept ? { hookSpecificOutput: { hookEventName: 'SessionStart' as const, additionalContext: kept } } : {};
          }] }],
          PostCompact: [{ hooks: [async (input) => {
            if (input.hook_event_name === 'PostCompact' && input.compact_summary) chats.update(chatId, { compact_summary: input.compact_summary.slice(0, 20_000) });
            return {};
          }] }],
        },
        env: { ...claudeEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: 'wayfinder/1.11' },
      },
    });

    for await (const msg of stream) {
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        const m = (msg as any).compact_metadata ?? {};
        const note = `Pip summarised the earlier part of this chat to make room${m.pre_tokens ? ` (about ${Math.round(m.pre_tokens / 1000)}k tokens)` : ''}. Decisions, changes and where the work lives are kept.`;
        emit({ t: 'notice', level: 'info', text: note });
        blocks.push({ type: 'notice', level: 'info', text: note });
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        startMs ??= Date.now() - t0;
        chats.update(chatId, { session_id: msg.session_id });
        chats.addSession(chatId, msg.session_id);
        const down = (msg.mcp_servers ?? []).filter((m: any) => m.status !== 'connected');
        if (down.length) emit({ t: 'notice', level: 'warn', text: `Not connected: ${down.map((m: any) => `${m.name} (${m.status})`).join(', ')}` });
      } else if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
        const ev: any = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { firstWordMs ??= Date.now() - t0; emit({ t: 'text', d: ev.delta.text }); }
      } else if (msg.type === 'assistant') {
        const parent = msg.parent_tool_use_id;
        if (parent === null) peakContext = Math.max(peakContext, contextTokens((msg.message as any).usage));
        for (const c of msg.message.content as any[]) {
          if (c.type === 'text' && parent === null) {
            const last = blocks[blocks.length - 1];
            if (last?.type === 'text') last.text += c.text;
            else blocks.push({ type: 'text', text: c.text });
            emit({ t: 'text_end' });
          } else if (c.type === 'tool_use') {
            const b: Extract<Block, { type: 'tool' }> = { type: 'tool', id: c.id, name: c.name, input: c.input, status: 'running', parent };
            blocks.push(b);
            toolIndex.set(c.id, b);
            toolStarted.set(c.id, Date.now());
            // "First sign of life": a step starting counts as much as a first word.
            firstWordMs ??= Date.now() - t0;
            emit({ t: 'tool_start', id: c.id, name: c.name, input: c.input, parent });
          }
        }
      } else if (msg.type === 'user' && Array.isArray((msg.message as any).content)) {
        for (const c of (msg.message as any).content) {
          if (c.type !== 'tool_result') continue;
          const b = toolIndex.get(c.tool_use_id);
          // Show me cards draw from the result, so they keep more of it.
          // Masked here too: what's shown and saved matches what Pip was given (the hook in withReleases).
          const out = clip(scrubText(resultText(c.content)), b?.name === 'mcp__pdi__show' ? 40_000 : 6000);
          const denied = c.is_error && /did not approve|not on the web allowlist|not available in Wayfinder|allowlist/.test(out);
          const status = denied ? 'denied' : c.is_error ? 'error' : 'done';
          // The instance refused (ACL or role): remember it so Pip doesn't try the same thing again.
          if (b && /^mcp__(instance|pdi)__/.test(b.name) && inst?.status === 'active' && /\b403\b|not authorized|insufficient_privileges|acl validation|forbidden/i.test(out) && !denied) {
            const input = (b.input ?? {}) as Record<string, any>;
            const tool = b.name.replace(/^mcp__[a-z]+__/, '');
            const table = input.table ?? input.args?.table ?? input.arguments?.table;
            learnRefusal(inst, `${tool}${table ? ` on ${table}` : ''}`);
          }
          const ms = toolStarted.has(c.tool_use_id) ? Date.now() - toolStarted.get(c.tool_use_id)! : undefined;
          if (b) Object.assign(b, { status, result: out, ms });
          // A docs lookup or plugin/Store check that came back with a result counts toward the build gate.
          if (b) noteToolResult(chatId, b.name, b.input, !!c.is_error, out);
          emit({ t: 'tool_result', id: c.tool_use_id, status, result: out, ms });
        }
      } else if (msg.type === 'result') {
        turns = (msg as any).num_turns ?? null;
        let prev: CostSnapshot | null = null;
        try { prev = JSON.parse(chats.get(chatId)?.cost_snapshot ?? 'null'); } catch { /* unreadable: count in full */ }
        const total = (msg as any).total_cost_usd ?? null;
        costUsd = answerCost(total, msg.session_id, prev);
        if (total !== null) chats.update(chatId, { cost_snapshot: JSON.stringify({ session: msg.session_id, total } satisfies CostSnapshot) });
        chats.update(chatId, { session_id: msg.session_id });
        if (msg.subtype !== 'success') {
          const why = stoppedEarly(msg.subtype, s.dailyBudgetUsd, MODE_CONFIG[mode].maxTurns);
          const level = msg.subtype === 'error_max_turns' || msg.subtype === 'error_max_budget_usd' ? 'warn' : 'error';
          emit({ t: 'notice', level, text: why });
          blocks.push({ type: 'notice', level, text: why });
        }
      }
    }
  } catch (e) {
    const aborted = abort.signal.aborted;
    // After a stop, say what got done and what is still running on its own, so nothing is a surprise.
    const done = [...toolIndex.values()].filter((b) => b.status === 'done' && !b.parent).length;
    const still = jobs.running().filter((j) => j.chat_id === chatId).map((j) => j.target);
    const summary = `${closing ? CUT_OFF : overTime ? workLimitNote(maxMinutes, mode) : 'Stopped.'}${done ? ` ${done} step${done > 1 ? 's' : ''} finished before that.` : ''}${still.length ? ` Still running in the background: ${still.join(', ')}.` : ''}`;
    const stopped: Block = closing || overTime ? { type: 'notice', level: 'warn', text: summary, action: 'continue' } : { type: 'notice', level: 'info', text: summary };
    const startFailed = !aborted && couldNotStart(e);
    if (startFailed) {
      console.error('An answer could not start Claude (%s).', String((e as { code?: unknown }).code ?? 'spawn error'));   // no message: it can hold paths
      emit({ t: 'notice', level: 'warn', text: COULD_NOT_START, action: 'continue' });
      blocks.push({ type: 'notice', level: 'warn', text: COULD_NOT_START, action: 'continue' });
    } else {
      emit(aborted ? { t: 'notice', ...stopped } : { t: 'notice', level: 'error', text: `Error: ${(e as Error).message}` });
      if (aborted) blocks.push(stopped);
      if (!aborted) blocks.push({ type: 'text', text: `\n\n_Error: ${(e as Error).message}_` });
    }
  } finally {
    // First, so nothing below can leak it; this block has no await, so no other answer sees the gap before perf.add.
    releaseBudget(chatId);
    clearInterval(workClock);
    running.delete(chatId);
    releaseChat(chatId); // any instance hold left by a call that never returned
    for (const b of toolIndex.values()) if (b.status === 'running') b.status = 'error';
    const longChat = contextNotice(peakContext, perf.peakContext(chatId));
    if (longChat) { emit({ t: 'notice', level: 'info', text: longChat, action: 'fresh-chat' }); blocks.push({ type: 'notice', level: 'info', text: longChat, action: 'fresh-chat' }); }
    // The answer's footer: how many saved rules shaped it (with a link to the Memory page), its steps out of the mode's
    // limit, and what it cost.
    const guided = guidedCount(activeInst, project?.id ?? null, mode);
    if (blocks.some((b) => b.type === 'text')) blocks.push({ type: 'guided', count: guided, steps: turns, limit: MODE_CONFIG[mode].maxTurns, cost: costUsd });
    const spend = budgetNotice(s.dailyBudgetUsd, spentBefore, spentBefore + (costUsd ?? 0));
    if (spend) { emit({ t: 'notice', level: 'warn', text: spend }); blocks.push({ type: 'notice', level: 'warn', text: spend }); }
    messages.add(chatId, 'assistant', blocks);
    chats.setAnswering(chatId, null);
    chats.update(chatId, {});
    perf.add({ at: t0, chat_id: chatId, mode, start_ms: startMs, first_word_ms: firstWordMs, total_ms: Date.now() - t0,
      tools: [...toolIndex.values()].filter((b) => b.ms !== undefined).map((b) => ({ name: b.name, ms: b.ms! })),
      turns, tool_errors: [...toolIndex.values()].filter((b) => b.status === 'error').length, cost_usd: costUsd, context_tokens: peakContext || null });
    emit({ t: 'done' });
    // After the first answer, a short real title from the small-jobs model (in the background; the list updates).
    const answer = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ');
    if (firstAnswer && answer.trim()) void retitle(chatId, userText, answer).catch(() => {});
  }
}

// A write's hold on the instance (policy.ts) ends when its result or failure comes back. Results from the instance are
// masked (scrub.ts) before the model sees them.
function withReleases(h: Partial<Record<HookEvent, HookCallbackMatcher[]>>): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const release: HookCallbackMatcher = { hooks: [async (input) => { if ('tool_use_id' in input) releaseCall(String(input.tool_use_id)); return {}; }] };
  return { ...h, PostToolUse: [...(h.PostToolUse ?? []), release, MASK_RESULTS], PostToolUseFailure: [...(h.PostToolUseFailure ?? []), release] };
}
export const MASK_RESULTS: HookCallbackMatcher = {
  matcher: '^mcp__',
  hooks: [async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    let masked: unknown = scrub(input.tool_response);
    if (!/^mcp__(instance|pdi|project|build|sndocs|docs)__/.test(input.tool_name)) {
      const text = typeof masked === 'string' ? masked : JSON.stringify(masked);
      if (text && text.length > 6000) masked = clip(text, 6000);
    }
    return masked === input.tool_response ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, updatedToolOutput: masked } };
  }],
};
