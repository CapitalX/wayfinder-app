import { describe, expect, it } from 'vitest';
import { BOARD_CAP, MEMORY_WORDS, SAVED_CAP, boardIndex, memoryIndex, savedIndex, systemPrompt } from '../src/server/prompts.ts';
import { contextNotice, contextTokens } from '../src/server/contextBudget.ts';
import { memories, perf, settings, type Artifact, type BoardItem, type Memory, type Project } from '../src/server/db.ts';
import { projectServer } from '../src/server/projectTools.ts';

const clue = (i: number, status: BoardItem['status'] = 'open') => ({ id: `c${i}`, kind: 'log', status, title: `clue ${i}` }) as BoardItem;
const item = (i: number) => ({ id: `a${i}`, kind: 'note', title: `item ${i}` }) as Artifact;
const memory = (i: number, words: number, scope: Memory['scope'] = 'core') => ({ id: `m${i}`, text: Array(words).fill(`w${i}`).join(' '), scope }) as Memory;

describe('board in the prompt', () => {
  it('lists live clues newest first, capped, and counts the rest', () => {
    const clues = [...Array.from({ length: 20 }, (_, i) => clue(i)), clue(98, 'ruled_out'), clue(99, 'confirmed')];
    const out = boardIndex(clues);
    const lines = out.split('\n');
    expect(lines[0]).toContain('(c99)');
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(BOARD_CAP);
    expect(out).not.toContain('(c98)');
    expect(out).toContain('9 older clues not listed, 1 ruled out: project board_list shows them all.');
  });

  it('says how many were ruled out even when nothing is live', () => {
    expect(boardIndex([clue(1, 'ruled_out')])).toBe('(1 ruled out: project board_list shows them all.)');
    expect(boardIndex([])).toBe('');
  });
});

describe('saved items in the prompt', () => {
  it('lists the newest titles and points at list_saved for the rest', () => {
    const out = savedIndex(Array.from({ length: 14 }, (_, i) => item(i)));
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(SAVED_CAP);
    expect(out).toContain('- [note] "item 0" (a0)');
    expect(out).not.toContain('(a10)');
    expect(out).toContain('(4 older items not listed: project list_saved shows them all.)');
  });

  it('adds no count line when everything fits', () => {
    expect(savedIndex([item(1)])).toBe('- [note] "item 1" (a1)');
  });
});

describe('memories in the prompt', () => {
  it('keeps memories in full up to the word budget, project ones first', () => {
    const { lines, shortened } = memoryIndex([memory(1, 300), memory(2, 300), memory(3, 300, 'project')]);
    const rows = lines.split('\n');
    expect(rows[0]).toMatch(/^- "w3 w3.*" \(this project\)$/);
    expect(shortened).toBe(1);
    expect(rows[2]).toBe(`- "${Array(10).fill('w2').join(' ')}…" (m2)`);
  });

  it('shortens nothing under the budget, and the prompt only mentions read_memory when it does', () => {
    expect(memoryIndex([memory(1, MEMORY_WORDS)]).shortened).toBe(0);
    const project = { id: 'p1', name: 'Loans', brief: '' } as Project;
    const small = systemPrompt('explore', undefined, settings.get(), { project, remembered: [memory(1, 20)], release: 'zurich' });
    const big = systemPrompt('explore', undefined, settings.get(), { project, remembered: [memory(1, MEMORY_WORDS), memory(2, 20)], release: 'zurich' });
    expect(small).not.toMatch(/shortened to save room/);
    expect(big).toContain('The last 1 memory is shortened to save room: open one with project read_memory before relying on it.');
  });
});

describe('read_memory', () => {
  const call = async (id: string) => {
    const server = projectServer(undefined, 'chat-1') as any;
    const t = server.instance._registeredTools.read_memory;
    return t.handler({ id }, {});
  };

  it('reads an active memory in full and refuses an unknown or proposed one', async () => {
    const saved = memories.add({ text: 'Prefer Flow Designer over business rules for approvals.', why: '', scope: 'core', project_id: null, status: 'saved', chat_id: null });
    const proposed = memories.add({ text: 'Proposed only.', why: '', scope: 'core', project_id: null, status: 'proposed', chat_id: null });
    expect(JSON.stringify(await call(saved.id))).toContain('Prefer Flow Designer');
    expect((await call(proposed.id)).isError).toBe(true);
    expect((await call('nope')).isError).toBe(true);
  });
});

describe('long-chat note', () => {
  it('adds fresh, cached and cache-written tokens', () => {
    expect(contextTokens({ input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000 })).toBe(95_010);
    expect(contextTokens(undefined)).toBe(0);
  });

  it('shows once when a chat first crosses each step', () => {
    expect(contextNotice(60_000, 0)).toBeNull();
    expect(contextNotice(104_000, 0)).toMatch(/about 104k tokens/);
    expect(contextNotice(120_000, 104_000)).toBeNull();
    expect(contextNotice(151_000, 120_000)).toMatch(/about 151k tokens/);
    expect(contextNotice(160_000, 151_000)).toBeNull();
  });

  it('remembers the largest step per chat', () => {
    perf.add({ at: Date.now(), chat_id: 'long-chat', mode: 'explore', start_ms: 1, first_word_ms: 1, total_ms: 1, tools: [], context_tokens: 104_000 });
    perf.add({ at: Date.now(), chat_id: 'long-chat', mode: 'explore', start_ms: 1, first_word_ms: 1, total_ms: 1, tools: [], context_tokens: 30_000 });
    expect(perf.peakContext('long-chat')).toBe(104_000);
    expect(perf.peakContext('other-chat')).toBe(0);
  });
});
