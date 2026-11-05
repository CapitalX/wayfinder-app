// How much each step of an answer carries: the prompt, the chat so far and the tool results, as the model counted it.
// Past a step size the chat gets slow and expensive, so the answer that first crosses each step says so once.
export const CONTEXT_STEPS = [100_000, 150_000];

// Tokens the model read for one call: fresh input plus what came from or went into the prompt cache.
export const contextTokens = (u: { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined) =>
  u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0;

export function contextNotice(peak: number, before: number): string | null {
  const step = [...CONTEXT_STEPS].reverse().find((s) => peak >= s);
  if (!step || before >= step) return null;
  return `This chat is getting long: each step now reads about ${Math.round(peak / 1000)}k tokens, so answers are slower and cost more. A fresh chat is quicker for new work.`;
}
