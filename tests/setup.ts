import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts reads these when it's first imported, so every test file opens its own empty database and secrets
// file instead of touching ~/wayfinder-data.
// Anything inherited from the shell (WAYFINDER_* wins over SNW_*) is dropped first, so tests never reach real data.
for (const k of Object.keys(process.env)) if (k.startsWith('WAYFINDER_') || k.startsWith('SNW_')) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'wayfinder-test-'));
process.env.WAYFINDER_DATA_DIR = join(dir, 'data');
process.env.WAYFINDER_CONFIG_DIR = join(dir, 'config');
process.env.WAYFINDER_SANDBOX = 'off';
// Never the real Keychain or Credential Manager: tests that cover sealing stand in for the store themselves.
process.env.WAYFINDER_KEYCHAIN = 'off';
// No docs server either: a real token file on this machine would change which docs source tests see.
process.env.SNDOCS_TOKEN_FILE = join(dir, 'no-sndocs-token');

// SDK callers are mocked; a placeholder lets the same tests exercise API-key-only builds.
process.env.ANTHROPIC_API_KEY = 'test-only-not-a-real-key';

// No test reaches Claude: small jobs (titles, summaries, lessons) answer nothing unless a test sets its own runner.
const { setSmallJobRunner } = await import('../src/server/smallJob.ts');
setSmallJobRunner(async () => ({ text: '', cost: null }));
