import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearTranscripts } from '../src/server/transcripts.ts';
import { chats } from '../src/server/db.ts';

const A = '0456bf4d-1c58-4937-804e-88400a49f0cf', B = '41972e60-333e-45bd-abed-ce2f4f44c678', OTHER = '0c10ac48-3caf-4d99-a5db-821d0f2c3bd2';

describe('deleting a chat\'s transcripts', () => {
  it('removes exactly that chat\'s session files (and subagent folders), nothing else', () => {
    const home = mkdtempSync(join(tmpdir(), 'wf-claude-'));
    const proj = join(home, 'projects', '-home-me-wayfinder-data-agent-cwd');
    mkdirSync(join(proj, A, 'subagents'), { recursive: true });
    for (const id of [A, B, OTHER]) writeFileSync(join(proj, `${id}.jsonl`), '{}');
    expect(clearTranscripts([A, B, null, 'not-a-session', '../../etc'], home)).toBe(3);
    expect(existsSync(join(proj, `${A}.jsonl`)) || existsSync(join(proj, A)) || existsSync(join(proj, `${B}.jsonl`))).toBe(false);
    expect(existsSync(join(proj, `${OTHER}.jsonl`))).toBe(true);
  });
  it('remembers every session a chat used', () => {
    const chat = chats.create('explore', null);
    chats.addSession(chat.id, A);
    chats.addSession(chat.id, A);
    chats.update(chat.id, { session_id: B }); // the current session counts even before it's added
    expect(chats.sessions(chat.id).sort()).toEqual([A, B].sort());
  });
});
