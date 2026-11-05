import { describe, expect, it, vi } from 'vitest';

// Claude is replaced by an answer that starts a step and then waits, like a long build, until it's stopped.
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ options }: { options: { abortController: AbortController } }) => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' };
    yield { type: 'assistant', parent_tool_use_id: null, message: { usage: {}, content: [{ type: 'text', text: 'Writing the script include.' }] } };
    await new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  })(),
}));

const lastAnswer = async (chatId: string) => {
  const { messages } = await import('../src/server/db.ts');
  return messages.list(chatId).filter((m) => m.role === 'assistant').at(-1)!.blocks;
};

describe('a restart while Pip is answering', () => {
  it('counts the running answer, and on shutdown keeps what it did and says it was cut off, with Continue', async () => {
    const { chats } = await import('../src/server/db.ts');
    const { answering, runChat, stopAllForRestart, CUT_OFF } = await import('../src/server/agent.ts');
    const chat = chats.create('build', null);
    const events: any[] = [];
    const run = runChat(chat.id, 'Plan approved. Build it.', (e) => events.push(e));
    await vi.waitFor(() => expect(answering()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));   // into the long step
    expect(chats.cutOff()).toEqual([chat.id]);

    await stopAllForRestart(5_000);
    await run;
    expect(answering()).toBe(0);
    const blocks = await lastAnswer(chat.id);
    expect(blocks.some((b: any) => b.type === 'text' && b.text.includes('Writing the script include.'))).toBe(true);
    expect(blocks.find((b: any) => b.type === 'notice')).toMatchObject({ level: 'warn', action: 'continue', text: expect.stringContaining(CUT_OFF) });
    expect(events.find((e) => e.t === 'notice' && e.action)).toMatchObject({ level: 'warn', action: 'continue' });
    expect(chats.cutOff()).toEqual([]);   // it saved, so the next start adds nothing
  });

  it('an answer the process never got to save gets the note at the next start, once', async () => {
    const { chats, messages } = await import('../src/server/db.ts');
    const { noteCutOff, CUT_OFF } = await import('../src/server/agent.ts');
    const chat = chats.create('build', null);
    messages.add(chat.id, 'user', [{ type: 'text', text: 'Plan approved. Build it.' }]);
    chats.setAnswering(chat.id, Date.now());   // killed mid-answer: the mark is still there
    noteCutOff();
    noteCutOff();
    const notes = messages.list(chat.id).filter((m) => m.role === 'assistant');
    expect(notes).toHaveLength(1);
    expect(notes[0].blocks[0]).toMatchObject({ type: 'notice', level: 'warn', action: 'continue', text: expect.stringContaining(CUT_OFF) });
    expect(chats.cutOff()).toEqual([]);
  });
});
