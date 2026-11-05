import { chatChecks, type CheckKind } from './db.ts';

// Docs first, out-of-the-box first, enforced: in a chat, Pip's build tools (plan, write, build, install) refuse until
// app. A check counts only once its tool has come back with a result (agent.ts calls noteToolResult); a refused,
// failed or cancelled call never opens the gate. policy.ts asks missingChecks before a gated tool.

export const GATED = new Set(['mcp__build__propose_app', 'mcp__build__write_app_file', 'mcp__build__write_app_files', 'mcp__build__build_app', 'mcp__build__install_app']);
const OOB = new Set(['mcp__pdi__check_features', 'mcp__pdi__find_store_app', 'mcp__pdi__list_plugins']);

// Which check a tool call counts as, if any. A docs lookup is the docs tool, or a page of the public docs site
// (what Pip reads when no docs are set up).
export function checkKind(tool: string, input: Record<string, unknown>): CheckKind | null {
  if (/^mcp__sndocs__(search_docs|get_doc|ask|browse|whats_changed)$/.test(tool)) return 'docs';
  if (OOB.has(tool)) return 'oob';
  if (tool === 'WebFetch') {
    try {
      const u = new URL(String(input.url ?? ''));
      const host = u.hostname.toLowerCase();
      if (host === 'docs.servicenow.com' || ((host === 'servicenow.com' || host === 'www.servicenow.com') && u.pathname.startsWith('/docs'))) return 'docs';
    } catch { /* not a URL */ }
  }
  return null;
}

// A finished tool call: a docs lookup or plugin/Store check that returned a real result (no error, not empty, not
// an "Error:" text) counts for the chat. Returns the check it counted as, if any.
export function noteToolResult(chatId: string, tool: string, input: unknown, isError: boolean, text: string): CheckKind | null {
  const kind = checkKind(tool, (input ?? {}) as Record<string, unknown>);
  if (!kind || isError || !text.trim() || /^\s*error\b/i.test(text)) return null;
  chatChecks.record(chatId, kind, tool);
  return kind;
}

// What's still missing in this chat. The plugin/Store check needs the instance's tools, so it's only required when
// the chat's instance is connected.
export function missingChecks(chatId: string, instanceConnected: boolean): CheckKind[] {
  const done = chatChecks.get(chatId);
  return (['docs', 'oob'] as const).filter((k) => !done.has(k) && (k === 'docs' || instanceConnected));
}

export function gateMessage(missing: CheckKind[]): string {
  const need = missing.map((k) => k === 'docs'
    ? 'look it up in the ServiceNow docs (sndocs search_docs, or a docs.servicenow.com page)'
    : 'check for an existing plugin or Store app that already does it (pdi check_features with the key nouns)');
  return `Not yet: before planning, building or installing an app, this chat must ${need.join(' and ')}. Do that now, tell the user what you found in a line, and then continue (offer the out-of-the-box option first if one fits).`;
}
