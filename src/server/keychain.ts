import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { envVar } from './config.ts';

// The key that seals the secrets file (secrets.ts) lives in the computer's own credential store: the macOS Keychain
// (the `security` tool), or the Windows Credential Manager when Wayfinder runs in WSL (PowerShell's PasswordVault,
// through powershell.exe). A copy of the file is then useless without this computer's store. Linux without either
// keeps the plain mode-600 file. WAYFINDER_KEYCHAIN=off stops sealing; the key is still read, so a sealed file is
// opened and written back plain on the next start.
// The key is one 64-character hex string: it travels to the tools on stdin (never in arguments, which other processes
// can see) and needs no quoting. The secrets themselves never leave the file.
export type Kind = 'macos' | 'windows';
const SERVICE = 'wayfinder-secrets-key', ACCOUNT = 'wayfinder';
const HEX = /^[0-9a-f]{64}$/;

export type Exec = (cmd: string, args: string[], input: string) => string;
const exec: Exec = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });

const isWsl = () => { try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; } };
const PS = (body: string) => `[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null\n$v = New-Object Windows.Security.Credentials.PasswordVault\n${body}\n`;
const POWERSHELL = ['-NoProfile', '-NonInteractive', '-Command', '-'];

export const keychain = {
  kind(): Kind | null {
    if (process.platform === 'darwin') return 'macos';
    if (process.platform === 'linux' && isWsl()) return 'windows';
    return null;
  },
  // The stored key, '' when the store has none yet, null when the store can't be reached (locked, no powershell.exe,
  // a session without a desktop).
  read(kind: Kind | null, run: Exec = exec): string | null {
    try {
      if (kind === 'macos') return check(run('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'], ''));
      if (kind === 'windows') return check(run('powershell.exe', POWERSHELL, PS(`try { $v.Retrieve('${ACCOUNT}', '${SERVICE}').Password } catch { }`)));
      return null;
    } catch (e) {
      // 44 is errSecItemNotFound: the store answered, there is no key yet.
      return kind === 'macos' && (e as { status?: number }).status === 44 ? '' : null;
    }
  },
  // Stores a key and reads it back; false when the store didn't keep it.
  write(hex: string, kind: Kind | null, run: Exec = exec): boolean {
    if (!HEX.test(hex)) return false;
    try {
      if (kind === 'macos') run('security', ['-i'], `add-generic-password -a ${ACCOUNT} -s ${SERVICE} -w ${hex} -U\n`);
      else if (kind === 'windows') run('powershell.exe', POWERSHELL, PS(`$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${ACCOUNT}', '${SERVICE}', '${hex}')))`));
      else return false;
    } catch { return false; }
    return keychain.read(kind, run) === hex;
  },
  // Sealing is on unless switched off; the key is still read while off, so a sealed file can be opened.
  on: () => envVar('KEYCHAIN') !== 'off',
  // The stored key, or a new one when `create`. null means there is no store or it can't be reached; '' means the
  // store is reachable but holds no key (and none was asked for).
  key(create: boolean): string | null {
    const kind = keychain.kind();
    if (!kind) return null;
    const stored = keychain.read(kind);
    if (stored || stored === null || !create) return stored;
    const fresh = randomBytes(32).toString('hex');
    return keychain.write(fresh, kind) ? fresh : null;
  },
};

// A key as the tool printed it, or '' when there is none (an empty answer, or something that isn't a key of ours).
const check = (out: string) => (HEX.test(out.trim()) ? out.trim() : '');
