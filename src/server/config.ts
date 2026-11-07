import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, mkdirSync, statSync } from 'node:fs';

const home = homedir();

// Settings come from WAYFINDER_<NAME>; the older SNW_<NAME> still works.
export const envVar = (name: string): string | undefined => process.env[`WAYFINDER_${name}`] ?? process.env[`SNW_${name}`];

export const PORT = Number(envVar('PORT') ?? 8797);
export const HOST = envVar('HOST') ?? '127.0.0.1';

// Chats and backups live with the app; secrets live in a mode-600 file under ~/.config.
export const DATA_DIR = envVar('DATA_DIR') ?? join(home, 'wayfinder-data');
export const CONFIG_DIR = envVar('CONFIG_DIR') ?? join(home, '.config', 'wayfinder');
export const SECRETS_FILE = join(CONFIG_DIR, 'secrets.json');
export const DB_FILE = join(DATA_DIR, 'workbench.db');
export const BACKUP_DIR = join(DATA_DIR, 'backups');
// The agent runs with this as its working directory; it has no file tools, so it stays empty.
export const AGENT_CWD = join(DATA_DIR, 'agent-cwd');

// Optional ServiceNow docs MCP server (any server with search_docs/get_doc/ask tools). It wins over the local index
// when its token file exists; with neither, answers fall back to docs.servicenow.com through the web allowlist.
export const SNDOCS_URL = process.env.SNDOCS_URL ?? 'http://127.0.0.1:8790/mcp';
export const SNDOCS_TOKEN_FILE = process.env.SNDOCS_TOKEN_FILE ?? join(home, '.config', 'sndocs', 'token');
// The local docs index (`wayfinder docs setup`): used when no docs server is set up. Built from ServiceNow's public
// docs repository, one branch per release family.
export const DOCS_DIR = join(DATA_DIR, 'docs');
export const DOCS_REPO = envVar('DOCS_REPO') ?? 'https://github.com/ServiceNow/ServiceNowDocs.git';

// Build mode: each generated app is a ServiceNow SDK (Fluent) project in its own folder here.
// The folder's node_modules points at the app's own copy of the SDK, so every app resolves it.
export const APPS_DIR = join(DATA_DIR, 'apps');

export const DEFAULT_ALLOWLIST = ['servicenow.com', 'developer.servicenow.com'];

// The data and config folders hold chats, instance data and keys: owner only (0700). Created that way, and tightened
// on every start in case an older version (or a umask) left them open. Folders inside them inherit the protection.
export function ownerOnly(dir: string, log: (m: string) => void = console.log) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const mode = statSync(dir).mode & 0o777;
    if (mode & 0o077) { chmodSync(dir, 0o700); log(`Made ${dir} private to you (was ${mode.toString(8)}, now 700).`); }
  } catch (e) {
    log(`Couldn't make ${dir} private (${(e as Error).message}); check its permissions.`);
  }
}

for (const dir of [DATA_DIR, CONFIG_DIR]) ownerOnly(dir);
for (const dir of [BACKUP_DIR, AGENT_CWD, APPS_DIR]) mkdirSync(dir, { recursive: true });
