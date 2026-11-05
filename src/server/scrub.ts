import { SECRET_VALUE } from './db.ts';

// What Pip reads from the instance never carries a credential: tool results are masked before the model sees them
// (agent.ts, PostToolUse) and before they're shown or saved. Logs like sys_outbound_http_log hold request headers and
// bodies, so this matters most when debugging integrations.

const MASK = '[masked]';
// Field and parameter names whose value is the secret itself. Narrower than the audit log's key list: names like
// credential_alias or token_url point at a secret without being one, and Pip needs them to debug.
const KEY = /^(?:[\w.-]*[_.-])?(?:pass(?:word|wd)?\d?|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|auth(?:orization)?|cookie|set-cookie|private_key|signature)$/i;
const HEADER = /^(\s*(?:proxy-)?(?:authorization|cookie|set-cookie|x-[\w-]*(?:token|key|secret|auth)[\w-]*)\s*:\s*).+$/gim;
const PARAM = /([?&;\s,{(]|^)([\w.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|signature|sig))=([^&\s"'<>]+)/gi;
const XML = /<((?:[\w-]+:)?(?:password|passwd|secret|client_secret|token|access_token|apikey|api_key|authorization))(\s[^>]*)?>([^<]+)<\/\1>/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const KEYISH = /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

function scrubString(s: string): string {
  return s
    .replace(HEADER, `$1${MASK}`)
    .replace(new RegExp(SECRET_VALUE.source, 'g'), MASK)
    .replace(JWT, MASK)
    .replace(KEYISH, MASK)
    .replace(XML, (_m, tag, attrs = '') => `<${tag}${attrs}>${MASK}</${tag}>`)
    .replace(PARAM, (_m, pre, key) => `${pre}${key}=${MASK}`);
}

function scrubValue(v: unknown, depth = 0): unknown {
  if (depth >= 12) return MASK;
  if (typeof v === 'string') return scrubText(v, depth + 1);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  if (v && typeof v === 'object') {
    // A ServiceNow field can come back as { value, display_value }: the whole field is the secret, so all of it goes.
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, KEY.test(k) && x !== null && x !== '' ? MASK : scrubValue(x, depth + 1)]));
  }
  return v;
}

// Text that is JSON is masked field by field (a password field, a header map); anything else line by line.
export function scrubText(s: string, depth = 0): string {
  if (depth >= 12) return MASK;
  const t = s.trimStart();
  // MCP content blocks already add four levels before their JSON text is reached.
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      const out = scrubValue(parsed, depth);
      const again = JSON.stringify(out, null, /\n\s/.test(s) ? 2 : undefined);
      return again === JSON.stringify(parsed, null, /\n\s/.test(s) ? 2 : undefined) ? s : again;
    } catch { /* not JSON after all */ }
  }
  return scrubString(s);
}

// Any tool result shape (MCP content blocks, plain objects, strings). Returns the same value when nothing was masked,
// so the hook can tell whether it needs to rewrite anything.
export function scrub<T>(v: T): T {
  const out = scrubValue(v);
  return JSON.stringify(out) === JSON.stringify(v) ? v : (out as T);
}

// Tables that hold credentials themselves. Instance tools refuse reads and writes; the records that use them
// (REST messages, aliases) stay readable.
export const CREDENTIAL_TABLES = new Set([
  'sys_user_token', 'oauth_credential', 'oauth_entity', 'oauth_entity_profile', 'discovery_credentials', 'sys_auth_profile_basic',
  'basic_auth_credentials', 'api_key_credentials', 'sys_certificate', 'sys_user_password_history',
]);
