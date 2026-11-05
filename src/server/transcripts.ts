import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The Agent SDK keeps its own copy of each conversation (a transcript per session, under ~/.claude/projects/<folder>/),
// which includes what the tools read from the instance. Deleting a chat in Wayfinder deletes those too, by exact
// session id, so nothing of it is left behind on this machine. Claude Code also removes transcripts older than its
// cleanup period (30 days by default).
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function clearTranscripts(sessionIds: (string | null | undefined)[], claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): number {
  const ids = [...new Set(sessionIds.filter((s): s is string => !!s && SESSION.test(s)))];
  const root = join(claudeHome, 'projects');
  if (!ids.length || !existsSync(root)) return 0;
  let removed = 0;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const id of ids) {
      for (const p of [join(root, dir.name, `${id}.jsonl`), join(root, dir.name, id)]) {
        if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); removed++; }
      }
    }
  }
  return removed;
}
