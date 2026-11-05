import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SECRETS_FILE } from './config.ts';
import { keychain } from './keychain.ts';

// One mode-600 JSON file: the app login token, the status-only token and each instance's OAuth client secret.
// On a Mac, or in WSL with Windows, the file is sealed (AES-256-GCM) with a key kept in the computer's credential
// store (keychain.ts), so a copy of the file alone gives away nothing. A plain file is sealed on its first read there,
// and opened again when sealing is turned off.
interface SecretStore { appToken: string; statusToken?: string; clientSecrets: Record<string, string>; passwords?: Record<string, string>; refreshTokens?: Record<string, string>; anthropicKey?: string; toolServers?: Record<string, { env: Record<string, string>; headers: Record<string, string> }> }

// Every API request checks the app token, so the file is kept in memory and only read again when it changes on disk
// (a write from here, or an edit by hand). Each caller gets its own copy, so changing one never touches the cache.
let cache: { mtime: number; size: number; text: string; sealed: boolean } | null = null;

// The store's key is asked for once per process (undefined: not yet; '': none, and none created; null: no store).
// Sealing needs the key and the switch on; opening needs only the key. clearKey is for tests, which stand in for the store.
let known: string | null | undefined;
export const clearKey = () => { known = undefined; cache = null; };
function sealKey(create: boolean): string | null {
  const make = create && keychain.on();
  if (known === undefined || (known === '' && make)) known = keychain.key(make);
  return known && (!create || keychain.on()) ? known : null;
}
interface Sealed { sealed: 'aes-256-gcm'; iv: string; tag: string; data: string }
function seal(text: string, hex: string): Sealed {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { sealed: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
const STORE_NAME = () => (keychain.kind() === 'windows' ? 'Windows Credential Manager' : 'macOS Keychain');
function open(raw: string): { text: string; sealed: boolean } {
  const j = JSON.parse(raw) as Partial<Sealed>;
  if (j.sealed !== 'aes-256-gcm') return { text: raw, sealed: false };
  const hex = sealKey(false);
  if (!hex) throw new Error(`The secrets file is sealed with a key kept in the ${STORE_NAME()}, which can't be reached right now (locked, or a session without it). Unlock it and start again, or restore ${SECRETS_FILE} from a plain copy.`);
  try {
    const d = createDecipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), Buffer.from(String(j.iv), 'base64'));
    d.setAuthTag(Buffer.from(String(j.tag), 'base64'));
    return { text: Buffer.concat([d.update(Buffer.from(String(j.data), 'base64')), d.final()]).toString('utf8'), sealed: true };
  } catch {
    throw new Error(`The secrets file is sealed with a different key than the one in this computer's ${STORE_NAME()} (a copy from another machine?). Restore ${SECRETS_FILE} from a plain copy, or connect the instance again.`);
  }
}

function load(): SecretStore {
  if (!existsSync(SECRETS_FILE)) {
    const fresh: SecretStore = { appToken: randomBytes(24).toString('base64url'), clientSecrets: {} };
    save(fresh);
    return fresh;
  }
  const { mtimeMs, size } = statSync(SECRETS_FILE);
  if (!cache || cache.mtime !== mtimeMs || cache.size !== size) cache = { mtime: mtimeMs, size, ...open(readFileSync(SECRETS_FILE, 'utf8')) };
  const store = JSON.parse(cache.text);
  // A plain file where sealing is possible is sealed now; a sealed one is written back plain once sealing is off.
  if (cache.sealed !== !!sealKey(true)) save(store);
  return store;
}

function save(store: SecretStore) {
  const hex = sealKey(true);
  const text = JSON.stringify(store, null, 2);
  writeFileSync(SECRETS_FILE, hex ? JSON.stringify(seal(text, hex), null, 2) : text, { mode: 0o600 });
  chmodSync(SECRETS_FILE, 0o600);
  cache = null;
}

export const secrets = {
  toolServer: (key: string) => load().toolServers?.[key] ?? { env: {}, headers: {} },
  setToolServer(key: string, values: { env: Record<string, string>; headers: Record<string, string> } | null) {
    const s = load();
    s.toolServers ??= {};
    if (values) s.toolServers[key] = values; else delete s.toolServers[key];
    save(s);
  },
  appToken: () => load().appToken,
  rotateAppToken() {
    const s = load();
    s.appToken = randomBytes(24).toString('base64url');
    save(s);
    return s.appToken;
  },
  clientSecret: (instanceId: string) => load().clientSecrets[instanceId],
  setClientSecret(instanceId: string, secret: string) {
    const s = load();
    s.clientSecrets[instanceId] = secret;
    save(s);
  },
  // The saved Anthropic API key takes precedence over the environment.
  anthropicKey: () => load().anthropicKey,
  setAnthropicKey(k: string | null) { const s = load(); if (k) s.anthropicKey = k; else delete s.anthropicKey; save(s); },
  password: (instanceId: string) => load().passwords?.[instanceId],
  setPassword(instanceId: string, pw: string) { const s = load(); (s.passwords ??= {})[instanceId] = pw; save(s); },
  refreshToken: (instanceId: string) => load().refreshTokens?.[instanceId],
  // Drops everything stored for signing in to one instance (its secret, password and session).
  clearInstance(instanceId: string) { const s = load(); delete s.clientSecrets?.[instanceId]; delete s.passwords?.[instanceId]; delete s.refreshTokens?.[instanceId]; save(s); },
  setRefreshToken(instanceId: string, t: string) { const s = load(); (s.refreshTokens ??= {})[instanceId] = t; save(s); },
  // Read-only token for GET /api/status, for an external reminder watcher (phone pushes, dashboards).
  statusToken() {
    const s = load();
    if (!s.statusToken) {
      s.statusToken = randomBytes(24).toString('base64url');
      save(s);
    }
    return s.statusToken;
  },
};
