// One chat writes to an instance at a time. The account's current update set and application are a single setting per
// instance, shared by every chat, so a write sets its own chat's place and holds the instance until the call returns.
// The same chat may hold it more than once (the model can send several calls together); other chats wait their turn.

const owners = new Map<string, { chatId: string; n: number; free: Promise<void>; done: () => void }>();
const held = new Map<string, { chatId: string; release: () => void }>(); // tool call id → its hold
const MAX_HOLD_MS = 10 * 60_000; // a call whose result never comes back can't hold the instance forever

export async function lockInstance(instanceId: string, chatId: string, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    const o = owners.get(instanceId);
    if (!o) break;
    if (o.chatId === chatId) { o.n++; return once(instanceId); }
    if (signal?.aborted) throw new Error('stopped');
    await new Promise<void>((resolve, reject) => {
      o.free.then(resolve);
      signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
  }
  let done!: () => void;
  const free = new Promise<void>((r) => { done = r; });
  owners.set(instanceId, { chatId, n: 1, free, done });
  return once(instanceId);
}

function once(instanceId: string): () => void {
  let released = false;
  const timer = setTimeout(() => release(), MAX_HOLD_MS);
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    const o = owners.get(instanceId);
    if (!o || --o.n > 0) return;
    owners.delete(instanceId);
    o.done();
  };
  return release;
}

// The hold lasts until the tool call's result (or failure) arrives, or the answer ends.
export const holdFor = (toolUseId: string, chatId: string, release: () => void) => held.set(toolUseId, { chatId, release });
export function releaseCall(toolUseId: string) { held.get(toolUseId)?.release(); held.delete(toolUseId); }
export function releaseChat(chatId: string) { for (const [id, h] of held) if (h.chatId === chatId) releaseCall(id); }
export const instanceBusy = (instanceId: string) => owners.get(instanceId)?.chatId ?? null;
