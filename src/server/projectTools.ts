import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { activeMemories } from './memoryHub.ts';
import { parseScreen } from '../web/screen.ts';
import { apps, artifacts, board, boardKey, memories, type BoardKind, type BoardStatus, type Memory, type Project } from './db.ts';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true });

// Mentions of Wayfinder's own tools or internals: memories about those are rejected.
const TOOL_TALK = /\b(check_features|board_(list|pin|update)|propose_(memory|app)|pdi_status|list_plugins|install_status|find_store_app|fluent_docs|query_records|count_records|aggregate|get_table_schema|get_mandatory_fields|read_script|run_script|sndocs|mcp__\w+|wayfinder|this (tool|app)|the tool)\b|\bpdi (show|tool)\b/i;
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
// Word overlap between two lessons (0 to 1); 0.5 and up counts as the same lesson.
function similar(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size);
}

// Why a suggested memory can't be kept, or null when it can. Memories are ServiceNow lessons and the user's
// preferences, never notes about Wayfinder's own tools: a tool quirk is a product bug to report, not something to remember.
export function memoryRejection(lesson: string, proposedThisAnswer: boolean, existing: Pick<Memory, 'text' | 'status'>[]): string | null {
  if (TOOL_TALK.test(lesson)) return 'That is about how Wayfinder\'s own tools behave, so it is not a memory. If a tool misbehaved, tell the user in one line so it can be fixed.';
  if (proposedThisAnswer) return 'Only one memory suggestion per answer.';
  const same = existing.find((m) => similar(m.text, lesson) >= 0.5);
  if (same) return `Already ${same.status === 'saved' ? 'remembered' : 'suggested'}: "${same.text}". Don't suggest it again.`;
  return null;
}

// Saved items for the chat's project (or the unfiled pile when the chat has no project).
// Local to the app, so these never need approval.
export function projectServer(project: Project | undefined, chatId: string) {
  const projectId = project?.id ?? null;
  let proposedThisAnswer = false; // this server is built per answer, so this caps suggestions at one per answer
  const key = boardKey(projectId, chatId);
  const KINDS = ['error', 'record', 'log', 'doc', 'hypothesis', 'note'] as const;
  const STATUSES = ['open', 'tested', 'ruled_out', 'confirmed'] as const;
  return createSdkMcpServer({
    name: 'project',
    version: '1.0.0',
    tools: [
      tool('list_saved', 'List what has been saved in this project: decisions, notes, scripts, mockups and app specs (titles only), plus the apps built in it. Check this before re-deciding something.', {}, async () =>
        text({
          project: project ? { name: project.name, brief: project.brief } : null,
          saved: artifacts.list(projectId).map(({ id, kind, title, created_at }) => ({ id, kind, title, saved: new Date(created_at).toISOString().slice(0, 10) })),
          apps: apps.list(projectId).map(({ id, name, scope, status }) => ({ id, name, scope, status })),
        })),
      tool('read_saved', 'Read one saved item in full.', { id: z.string() }, async ({ id }) => {
        const a = artifacts.get(id);
        if (!a || a.project_id !== projectId) return fail('No saved item with that id in this project.');
        return text({ kind: a.kind, title: a.title, content: a.content });
      }),
      tool('read_memory', 'Read one saved memory in full, when the prompt lists it shortened.', { id: z.string() }, async ({ id }) => {
        const m = activeMemories(projectId).find((x) => x.id === id);
        if (!m) return fail('No saved memory with that id for this chat (it may be paused or deleted).');
        return text({ text: m.text, scope: m.scope });
      }),
      tool('save', 'Save something worth keeping to this project: a decision (what was decided and why), a note, a script, or a mockup (full HTML). Save decisions when the user settles one. Keep titles short and specific.', {
        kind: z.enum(['decision', 'note', 'script', 'mockup']),
        title: z.string().min(3).max(120),
        content: z.string().min(1).max(200_000),
      }, async ({ kind, title, content }) => {
        const a = artifacts.add({ project_id: projectId, chat_id: chatId, kind, title, content });
        return text({ saved: true, id: a.id, where: project ? `project "${project.name}"` : 'unfiled (this chat has no project)' });
      }),
      tool('check_screen', 'Check a screen spec (the JSON of a ```screen block) against the screen kit before you show it. Returns ok, or the exact problems to fix. Fix and check again at most twice; if it still fails, say what the kit can\'t draw and offer a concept mockup in ```html instead.', {
        spec: z.string().min(2).max(60_000).describe('The screen spec JSON'),
      }, async ({ spec }) => {
        const r = parseScreen(spec);
        return text('spec' in r ? { ok: true } : { ok: false, problems: r.problems });
      }),
      tool('board_list', 'The investigation board for this project (or this chat): pinned clues with their status. Read it before debugging so you pick up where things were left.', {}, async () =>
        text(board.list(key).map(({ id, kind, title, detail, link, status, author }) => ({ id, kind, title, detail: detail.slice(0, 500), link, status, by: author })))),
      tool('board_pin', 'Pin a clue to the investigation board while debugging: an error message, a record, a log line, a docs page, a hypothesis or a note. Pin evidence as you find it and each hypothesis before testing it. Keep titles short; put the evidence in detail.', {
        kind: z.enum(KINDS),
        title: z.string().min(3).max(140),
        detail: z.string().max(4000).default(''),
        link: z.string().url().optional().describe('Record, log or docs URL, if there is one'),
        status: z.enum(STATUSES).default('open'),
      }, async ({ kind, title, detail, link, status }) => {
        const item = board.add({ board: key, kind: kind as BoardKind, title, detail, link: link ?? null, status: status as BoardStatus, author: 'pip', chat_id: chatId });
        return text({ pinned: true, id: item.id });
      }),
      tool('board_update', 'Update a clue on the board: mark a hypothesis tested, ruled out or confirmed, and add what you found to its detail.', {
        id: z.string(),
        status: z.enum(STATUSES).optional(),
        detail: z.string().max(4000).optional().describe('Replaces the detail; include the earlier evidence if it still matters'),
      }, async ({ id, status, detail }) => {
        const item = board.get(id);
        if (!item || item.board !== key) return fail('No clue with that id on this board.');
        board.update(id, { status: status as BoardStatus | undefined, detail });
        return text({ updated: true });
      }),
      tool('propose_memory', 'Suggest a lesson for the user to keep, so future chats know it. Good: a ServiceNow capability that should change how things get built (e.g. "Vulnerability Response has a multithreaded background job processor; use it instead of a plain scheduled job"), a correction the user made, a lasting preference, or a durable fact about their instance that changes recommendations. Not a memory: anything about how Wayfinder or its tools behave, one-off facts, or what any ServiceNow developer already knows. The user keeps or dismisses it. At most one per answer, never a near-duplicate of a saved or suggested memory.', {
        text: z.string().min(10).max(400).describe('The lesson as one or two plain sentences, written as a rule to follow'),
        why: z.string().max(400).describe('Where it comes from: the docs page, what you saw on the instance, or what the user said'),
        scope: z.enum(['core', 'project']).describe('core = useful in any project; project = only for this project'),
      }, async ({ text: lesson, why, scope }) => {
        const rejected = memoryRejection(lesson, proposedThisAnswer, memories.list());
        if (rejected) return fail(rejected);
        proposedThisAnswer = true;
        const m = memories.add({ text: lesson, why, scope: scope === 'project' && projectId ? 'project' : 'core', project_id: scope === 'project' ? projectId : null, status: 'proposed', chat_id: chatId });
        return text({ proposed: true, memory_id: m.id, note: 'The user decides on the card. Mention it in one short line at most.' });
      }),
    ],
  });
}
