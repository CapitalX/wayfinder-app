import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECRETS_FILE } from '../src/server/config.ts';
import { secrets } from '../src/server/secrets.ts';

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
