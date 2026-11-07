import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { activeBackend, bubblewrap, none, type SandboxSpec } from '../src/server/sandbox/index.ts';
import { childEnv, limited } from '../src/server/sandbox.ts';

vi.mock('node:child_process', async original => {
  const child = await original<typeof import('node:child_process')>();
  return { ...child, spawnSync: vi.fn(child.spawnSync) };
});

const spec: SandboxSpec = {
  cmd: '/opt/node/bin/node', args: ['build.js', 'argument with spaces'],
  cwd: '/var/lib/wayfinder/apps/x_test', write: ['/var/lib/wayfinder/apps/x_test', '/var/cache/sdk'], net: false,
  env: { GIT_CONFIG_GLOBAL: '/dev/null' }, host: { PATH: '/host/bin', HOME: '/home/builder' },
  hide: ['/home/builder', '/var/lib/wayfinder', '/etc/wayfinder'], checkout: '/opt/wayfinder', nodeDir: '/opt/node',
  nodeModules: { source: '/opt/wayfinder/node_modules', target: '/var/lib/wayfinder/apps/node_modules' },
};

describe('sandbox backends', () => {
  // Captured by calling the original buildTools.command(), before extracting any backend code.
  const golden = JSON.parse(readFileSync(new URL('./fixtures/sandbox-bubblewrap.json', import.meta.url), 'utf8'));
  it.each([false, true])('keeps the original bubblewrap command exactly (net=%s)', net => {
    expect(bubblewrap.wrap({ ...spec, net })).toEqual(golden[Number(net)]);
  });

  it('maps additional SDK paths read-only before writable app folders', () => {
    const root = '/var/lib/wayfinder/sdk/4.100.0/node_modules';
    const args = bubblewrap.wrap({ ...spec, read: [root] }).args;
    const at = args.indexOf(root);
    expect(args.slice(at - 1, at + 2)).toEqual(['--ro-bind', root, root]);
    expect(at).toBeLessThan(args.indexOf('--bind'));
  });

  it.each(['/home/builder/wayfinder', '/'])('does not overlay a checkout already hidden or at root (%s)', checkout => {
    const args = bubblewrap.wrap({ ...spec, checkout }).args;
    expect(args.some((arg, i) => arg === '--tmpfs' && args[i + 1] === checkout)).toBe(false);
  });

  it('keeps limits and the allowlisted host environment without isolation', () => {
    expect(none.available()).toEqual({ ok: true });
    expect(none.wrap(spec)).toEqual({ ...limited(spec.cmd, spec.args), env: childEnv(spec.env, spec.host, false) });
  });

  it.each([bubblewrap, none])('refuses credentials for $name', backend => {
    expect(() => backend.wrap({ ...spec, env: { ANTHROPIC_API_KEY: 'test-only' } })).toThrow(/Refusing to pass/);
  });

  it.each([0, 1, null])('keeps the bwrap availability probe and missing-install fix (status=%s)', status => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status } as ReturnType<typeof spawnSync>);
    expect(bubblewrap.available()).toEqual(status === 0 ? { ok: true } : {
      ok: false, fix: 'Builds run in a bubblewrap sandbox on Linux, and bwrap is not installed (sudo apt install bubblewrap).',
    });
    expect(spawnSync).toHaveBeenLastCalledWith('bwrap', ['--version']);
  });
});

describe('activeBackend', () => {
  it.each([
    ['linux', {}, 'bubblewrap'],
    ['linux', { WAYFINDER_SANDBOX: 'off' }, 'none'],
    ['linux', { SNW_SANDBOX: 'off' }, 'none'],
    ['linux', { WAYFINDER_SANDBOX: 'on', SNW_SANDBOX: 'off' }, 'bubblewrap'],
    ['darwin', {}, 'none'],
    ['win32', {}, 'none'],
  ] as const)('selects %s with %j → %s', (platform, env, name) => {
    expect(activeBackend(platform, env).name).toBe(name);
  });

  it('reports the none backend as unsandboxed in build and setup status', async () => {
    const { SANDBOX, UNSANDBOXED } = await import('../src/server/buildTools.ts');
    const { setupState } = await import('../src/server/setup.ts');
    expect(activeBackend()).toBe(none); // tests/setup.ts opts out on every OS.
    expect(SANDBOX).toBe(false);
    expect(UNSANDBOXED).toBe('This build ran without the bubblewrap sandbox (not Linux, or WAYFINDER_SANDBOX=off): the generated code could read files and use the network as the Wayfinder user. Tell the user once.');
    expect(setupState().extras.sandbox).toBe(false);
  });

  it('checks backend availability before preparing the SDK', async () => {
    const { ensureSdk } = await import('../src/server/buildTools.ts');
    const probe = vi.spyOn(none, 'available').mockReturnValue({ ok: false, fix: 'backend unavailable' });
    try { expect(ensureSdk).toThrow('backend unavailable'); } finally { probe.mockRestore(); }
  });

  it('passes the requested command and folder permissions through the backend', async () => {
    const { command } = await import('../src/server/buildTools.ts');
    const wrap = vi.fn(none.wrap);
    const opts = { cwd: spec.cwd, write: spec.write, net: spec.net, env: spec.env };
    const result = command(spec.cmd, spec.args, opts, { ...none, wrap });
    expect(wrap).toHaveBeenCalledWith(expect.objectContaining({ cmd: spec.cmd, args: spec.args, ...opts }));
    expect(result).toEqual(wrap.mock.results[0].value);
  });
});
