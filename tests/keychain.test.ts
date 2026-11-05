import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECRETS_FILE } from '../src/server/config.ts';
import { keychain, type Exec } from '../src/server/keychain.ts';
import { clearKey, secrets } from '../src/server/secrets.ts';

const KEY = 'ab'.repeat(32), OTHER = 'cd'.repeat(32);
const onDisk = () => JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
const stub = (key: string | null, on = true) => { vi.spyOn(keychain, 'on').mockReturnValue(on); return vi.spyOn(keychain, 'key').mockReturnValue(key); };
// Each test leaves a plain file behind, so the next one starts from a known state whatever key it used.
afterEach(() => { vi.restoreAllMocks(); clearKey(); writeFileSync(SECRETS_FILE, JSON.stringify({ appToken: 'reset-token', clientSecrets: {} })); });

describe('the secrets file and the credential store', () => {
  it('seals the file with the stored key and reads it back, nothing in the clear on disk', () => {
    stub(KEY);
    secrets.setPassword('i1', 'not-a-real-password');
    const raw = readFileSync(SECRETS_FILE, 'utf8');
    expect(onDisk().sealed).toBe('aes-256-gcm');
    expect(raw).not.toContain('not-a-real-password');
    expect(raw).not.toContain('appToken');
    clearKey();
    expect(secrets.password('i1')).toBe('not-a-real-password');
  });
  it('seals a plain file on its first read where a store is available, keeping every value', () => {
    stub(null);
    secrets.setPassword('i2', 'plain-value');
    const token = secrets.appToken();
    expect(onDisk().passwords.i2).toBe('plain-value');
    vi.restoreAllMocks(); clearKey(); stub(KEY);
    expect(secrets.password('i2')).toBe('plain-value');
    expect(onDisk().sealed).toBe('aes-256-gcm');
    expect(secrets.appToken()).toBe(token);
  });
  it('writes a sealed file back plain once sealing is off but the key can still be read', () => {
    stub(KEY);
    secrets.setPassword('i3', 'sealed-value');
    expect(onDisk().sealed).toBe('aes-256-gcm');
    vi.restoreAllMocks(); clearKey(); stub(KEY, false);
    expect(secrets.password('i3')).toBe('sealed-value');
    expect(onDisk().passwords.i3).toBe('sealed-value');
  });
  it('says plainly when the store is out of reach or holds another key', () => {
    stub(KEY);
    secrets.setPassword('i4', 'v');
    vi.restoreAllMocks(); clearKey(); stub(null);
    expect(() => secrets.appToken()).toThrow(/can't be reached/);
    vi.restoreAllMocks(); clearKey(); stub(OTHER);
    expect(() => secrets.appToken()).toThrow(/different key/);
    vi.restoreAllMocks(); clearKey(); stub(KEY);
    expect(secrets.password('i4')).toBe('v');
  });
  it('stays plain when the store can\'t keep a key, and asks it only once', () => {
    const key = stub(null).mockImplementation((create) => (create ? null : ''));
    secrets.setPassword('i5', 'v');
    expect(onDisk().passwords.i5).toBe('v');
    secrets.password('i5'); secrets.setPassword('i6', 'w');
    expect(key.mock.calls).toEqual([[true]]);
  });
});

describe('talking to the store', () => {
  const calls: { cmd: string; args: string[]; input: string }[] = [];
  const fake = (answer: () => string): Exec => (cmd, args, input) => { calls.push({ cmd, args, input }); return answer(); };
  afterEach(() => { calls.length = 0; });

  it('macOS: reads with the security tool, treats "not found" as no key and anything else as unreachable', () => {
    expect(keychain.read('macos', fake(() => `${KEY}\n`))).toBe(KEY);
    expect(calls[0]).toMatchObject({ cmd: 'security', args: ['find-generic-password', '-a', 'wayfinder', '-s', 'wayfinder-secrets-key', '-w'] });
    expect(keychain.read('macos', fake(() => { throw Object.assign(new Error('not found'), { status: 44 }); }))).toBe('');
    expect(keychain.read('macos', fake(() => { throw Object.assign(new Error('locked'), { status: 36 }); }))).toBeNull();
    expect(keychain.read('macos', fake(() => 'garbage'))).toBe('');
  });
  it('macOS: writes the key on stdin, never in arguments, and confirms by reading back', () => {
    let stored = '';
    const run: Exec = (cmd, args, input) => { calls.push({ cmd, args, input }); if (args[0] === '-i') { stored = /-w ([0-9a-f]+)/.exec(input)![1]; return ''; } return stored; };
    expect(keychain.write(KEY, 'macos', run)).toBe(true);
    expect(calls[0].args).toEqual(['-i']);
    expect(calls[0].input).toContain(`add-generic-password -a wayfinder -s wayfinder-secrets-key -w ${KEY} -U`);
    expect(calls.every((c) => !c.args.join(' ').includes(KEY))).toBe(true);
    expect(keychain.write(KEY, 'macos', fake(() => ''))).toBe(false);
    expect(keychain.write('short', 'macos', fake(() => KEY))).toBe(false);
  });
  it('Windows (WSL): goes through PowerShell\'s PasswordVault, with the script on stdin', () => {
    expect(keychain.read('windows', fake(() => `${KEY}\r\n`))).toBe(KEY);
    expect(calls[0]).toMatchObject({ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '-'] });
    expect(calls[0].input).toContain("$v.Retrieve('wayfinder', 'wayfinder-secrets-key').Password");
    expect(keychain.read('windows', fake(() => ''))).toBe('');
    expect(keychain.read('windows', fake(() => { throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }); }))).toBeNull();
    let stored = '';
    const run: Exec = (cmd, args, input) => { calls.push({ cmd, args, input }); if (input.includes('$v.Add')) { stored = /'([0-9a-f]{64})'/.exec(input)![1]; return ''; } return stored; };
    expect(keychain.write(KEY, 'windows', run)).toBe(true);
    expect(calls.every((c) => !c.args.join(' ').includes(KEY))).toBe(true);
  });
  it('no store: nothing is read or written', () => {
    expect(keychain.read(null, fake(() => KEY))).toBeNull();
    expect(keychain.write(KEY, null, fake(() => KEY))).toBe(false);
    expect(calls).toEqual([]);
  });
});
