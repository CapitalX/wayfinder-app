import { spawnSync } from 'node:child_process';
import { childEnv, limited } from '../sandbox.ts';

export interface SandboxSpec {
  cmd: string;
  args: string[];
  cwd: string;
  write: string[];
  read?: string[];
  net: boolean;
  env: Record<string, string>;
  host?: { PATH?: string; HOME?: string };
  hide: string[];
  checkout: string;
  nodeDir: string;
  nodeModules: { source: string; target: string };
}

export interface SandboxBackend {
  name: 'bubblewrap' | 'none';
  available(): { ok: true } | { ok: false; fix: string };
  wrap(spec: SandboxSpec): { cmd: string; args: string[]; env: Record<string, string> };
}

export const bubblewrap: SandboxBackend = {
  name: 'bubblewrap',
  available: () => spawnSync('bwrap', ['--version']).status === 0 ? { ok: true } : {
    ok: false, fix: 'Builds run in a bubblewrap sandbox on Linux, and bwrap is not installed (sudo apt install bubblewrap).',
  },
  wrap(spec) {
    const env = childEnv(spec.env, spec.host, true);
    const lim = limited(spec.cmd, spec.args);
    const bw = [
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      ...spec.hide.flatMap(d => ['--tmpfs', d]),
      // Only the checkout's node_modules are mapped back in, read-only.
      ...(spec.checkout !== '/' && !spec.hide.some(d => spec.checkout.startsWith(d + '/')) ? ['--tmpfs', spec.checkout] : []),
      '--ro-bind', spec.nodeDir, spec.nodeDir,
      '--ro-bind', spec.nodeModules.source, spec.nodeModules.target,
      ...(spec.read ?? []).flatMap(d => ['--ro-bind', d, d]),
      ...spec.write.flatMap(d => ['--bind', d, d]),
      '--unshare-all', ...(spec.net ? ['--share-net'] : []),
      '--die-with-parent', '--new-session', '--chdir', spec.cwd, '--clearenv',
      ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]),
      lim.cmd, ...lim.args,
    ];
    return { cmd: 'bwrap', args: bw, env: {} };
  },
};

export const none: SandboxBackend = {
  name: 'none',
  available: () => ({ ok: true }),
  wrap: spec => ({ ...limited(spec.cmd, spec.args), env: childEnv(spec.env, spec.host, false) }),
};

export function activeBackend(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SandboxBackend {
  return platform === 'linux' && (env.WAYFINDER_SANDBOX ?? env.SNW_SANDBOX) !== 'off' ? bubblewrap : none;
}
