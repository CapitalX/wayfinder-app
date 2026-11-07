import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRETS_FILE } from '../src/server/config.ts';
import { clearKey, secrets } from '../src/server/secrets.ts';
import { keychain } from '../src/server/keychain.ts';

describe('secrets file cache', () => {
  it('sees its own writes straight away', () => {
    const before = secrets.appToken();
    const after = secrets.rotateAppToken();
    expect(after).not.toBe(before);
    expect(secrets.appToken()).toBe(after);
    secrets.setPassword('i1', 'not-a-real-password');
    expect(secrets.password('i1')).toBe('not-a-real-password');
  });

  it('picks up an edit made outside the app', () => {
    secrets.appToken();
    const store = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
    store.appToken = 'edited-by-hand-token-value';
    writeFileSync(SECRETS_FILE, JSON.stringify(store));
    const later = new Date(Date.now() + 5000);
    utimesSync(SECRETS_FILE, later, later);
    expect(secrets.appToken()).toBe('edited-by-hand-token-value');
  });

  it('a caller changing what it got back never changes the cache', () => {
    secrets.setClientSecret('i2', 'one');
    const token = secrets.appToken();
    secrets.setClientSecret('i3', 'two');
    expect(secrets.clientSecret('i2')).toBe('one');
    expect(secrets.appToken()).toBe(token);
  });
});

describe('sealed secrets authentication tags', () => {
  beforeEach(() => {
    clearKey();
    vi.spyOn(keychain, 'on').mockReturnValue(true);
    vi.spyOn(keychain, 'key').mockReturnValue('ab'.repeat(32));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearKey();
    writeFileSync(SECRETS_FILE, JSON.stringify({ appToken: 'reset-token', clientSecrets: {} }));
  });

  it.each([0, 4, 8, 12, 13, 14, 15, 17])('refuses a %i-byte tag and still opens the original', (length) => {
    secrets.setPassword('i1', 'not-a-real-password');
    const raw = readFileSync(SECRETS_FILE, 'utf8');
    const sealed = JSON.parse(raw);
    const tag = Buffer.from(sealed.tag, 'base64');
    expect(tag.length).toBe(16);
    sealed.tag = Buffer.concat([tag, Buffer.alloc(1)]).subarray(0, length).toString('base64');
    writeFileSync(SECRETS_FILE, JSON.stringify(sealed));
    clearKey();
    expect(() => secrets.password('i1')).toThrow(/sealed with a different key/);
    writeFileSync(SECRETS_FILE, raw);
    clearKey();
    expect(secrets.password('i1')).toBe('not-a-real-password');
  });
});
