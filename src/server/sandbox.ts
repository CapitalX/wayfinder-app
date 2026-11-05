import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

// The pieces of the build runner that decide what a generated-code process gets: its environment, its limits, how
// it's stopped, and which files it may touch. Kept here, free of app state, so each rule has a test.

// Only these variables ever reach a build, git or install process. The model key, the app token and anything else
// in Wayfinder's own environment never do; installs add only the instance sign-in the approval named.
const BASE_ENV = { NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' };
const PASSABLE = /^(SN_SDK_[A-Z_]+|NODE_OPTIONS|GIT_[A-Z_]+)$/;

export function childEnv(extra: Record<string, string> = {}, host: { PATH?: string; HOME?: string } = {}, sandboxed = true): Record<string, string> {
  const passed = Object.fromEntries(Object.entries(extra).filter(([k]) => PASSABLE.test(k)));
  const dropped = Object.keys(extra).filter((k) => !PASSABLE.test(k));
  if (dropped.length) throw new Error(`Refusing to pass ${dropped.join(', ')} to a build process.`);
  return {
    ...BASE_ENV,
    // The SDK's node gets a heap cap so a runaway build fails instead of exhausting the host.
    NODE_OPTIONS: '--max-old-space-size=2048',
    ...passed,
    PATH: sandboxed ? '/usr/local/bin:/usr/bin:/bin' : host.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: sandboxed ? '/tmp/home' : host.HOME ?? '/tmp',
  };
}

// Per-process limits applied by the shell before the real command starts: CPU seconds, largest file written and open
// files. Memory is capped through NODE_OPTIONS above (an address-space limit breaks node, which reserves far more
// than it uses). A process can't raise these once set.
export const LIMITS = { cpuSeconds: 900, fileBlocks512: 2 * 1024 * 1024, openFiles: 4096 };
export function limited(cmd: string, args: string[]): { cmd: string; args: string[] } {
  const l = LIMITS;
  // One limit per ulimit call: dash (Debian/Ubuntu's /bin/sh) takes only one option at a time.
  return { cmd: '/bin/sh', args: ['-c', `ulimit -t ${l.cpuSeconds} && ulimit -f ${l.fileBlocks512} && ulimit -n ${l.openFiles} || exit 97; exec "$0" "$@"`, cmd, ...args] };
}

// Starts a process in its own process group, so stopping it also stops everything it started.
export function spawnGroup(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }): ChildProcess {
  return spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
}

// SIGTERM to the whole group, then SIGKILL if anything is still there after the grace period.
export function stopGroup(child: ChildProcess, graceMs = 5000) {
  const pid = child.pid;
  if (!pid) return;
  const signal = (s: NodeJS.Signals) => { try { process.kill(-pid, s); } catch { /* already gone */ } };
  signal('SIGTERM');
  const t = setTimeout(() => signal('SIGKILL'), graceMs);
  t.unref();
  child.once('close', () => { clearTimeout(t); signal('SIGKILL'); });
}

// A file path an app tool may use. It must resolve inside the app folder after following symlinks; no part of it may
// be a symlink (a build could plant one to reach outside); .git and the build's own output are off limits.
export function insideApp(root: string, rel: string, opts: { srcOnly?: boolean } = {}): string {
  if (!rel || isAbsolute(rel)) throw new Error('Use a path relative to the app folder.');
  const clean = normalize(rel).replace(/^(\.\/)+/, '');
  if (clean === '..' || clean.startsWith('..' + sep) || clean.startsWith('../')) throw new Error('Path is outside the app.');
  const parts = clean.split(/[\\/]/);
  if (parts.includes('.git')) throw new Error('The app\'s git history is not readable or writable here.');
  if (opts.srcOnly && (parts[0] !== 'src' || clean.startsWith('src/fluent/generated/')))
    throw new Error('Paths must be inside src/ (and not src/fluent/generated/, which the build writes).');
  const realRoot = realpathSync(root);
  let walk = realRoot;
  for (const p of parts) {
    walk = join(walk, p);
    if (!existsSync(walk) && !isLink(walk)) break; // the rest doesn't exist yet: nothing to follow
    if (isLink(walk)) throw new Error(`${relative(realRoot, walk)} is a symlink; app files can't be links.`);
  }
  const full = join(realRoot, clean);
  const parent = existsSync(dirname(full)) ? realpathSync(dirname(full)) : dirname(full);
  if (parent !== realRoot && !parent.startsWith(realRoot + sep)) throw new Error('Path is outside the app.');
  return full;
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
