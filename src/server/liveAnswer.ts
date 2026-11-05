// The answer a chat is giving right now, as the events streamed so far. Whoever opens the chat while it runs (after
// leaving it, a reload, another device) gets every event from the first, then follows along live, so the page
// rebuilds exactly what the sender sees: no gaps, no duplicates. The log ends with the answer's 'done'; by then the
// answer is saved, and the chat loads it like any other.
type Event = Record<string, unknown>;
type Sub = (e: Event) => void;
interface Log { events: Event[]; subs: Set<Sub>; done: boolean }
const logs = new Map<string, Log>();
const DONE: Event = { t: 'done' };

export function startLive(chatId: string): (e: Event) => void {
  endLive(chatId);   // a log left open by an answer that failed to start ends now
  const log: Log = { events: [], subs: new Set(), done: false };
  logs.set(chatId, log);
  return (e) => {
    if (log.done) return;
    log.events.push(e);
    for (const s of log.subs) s(e);
    if (e.t === 'done') { log.done = true; endLive(chatId, log); }
  };
}

export function endLive(chatId: string, only?: Log) {
  const log = logs.get(chatId);
  if (!log || (only && log !== only)) return;
  logs.delete(chatId);
  if (!log.done) { log.done = true; for (const s of log.subs) s(DONE); }
  log.subs.clear();
}

// Replays what happened so far, then calls fn for each new event until 'done'. With no answer running, just 'done'.
// Returns the unsubscribe.
export function followLive(chatId: string, fn: Sub): () => void {
  const log = logs.get(chatId);
  if (!log) { fn(DONE); return () => {}; }
  for (const e of log.events) fn(e);
  log.subs.add(fn);
  return () => log.subs.delete(fn);
}

// How many pages are following this chat's answer right now (tests check that a page that leaves stops following).
export function followers(chatId: string): number {
  return logs.get(chatId)?.subs.size ?? 0;
}
