import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxBackend, SandboxSpec } from '../src/server/sandbox/index.ts';

// Each real backend runs these same probes. No case ever reads a real SSH key or writes in a real home.
export function sandboxEscapeSuite(backend: SandboxBackend, usable: boolean) {
  describe.skipIf(!usable)(`build sandbox (${backend.name})`, () => {
    let root: string, home: string, data: string, config: string, app: string;
    let spec: SandboxSpec;
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'wf-escape-')));
      home = join(root, 'home'); data = join(root, 'data'); config = join(root, 'config');
      app = join(data, 'apps', 'x_test_iso');
      for (const dir of [join(home, '.ssh'), config, app]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, '.ssh', 'probe'), 'fake-ssh-probe');
      writeFileSync(join(config, 'secrets.json'), '{"appToken":"server-secret"}');
      writeFileSync(join(data, 'workbench.db.probe'), 'data-probe');
      spec = { cmd: process.execPath, args: [], cwd: app, write: [app], net: false, env: {},
        host: { PATH: process.env.PATH, HOME: home }, hide: [homedir(), home, data, config],
        checkout: process.cwd(), nodeDir: dirname(dirname(realpathSync(process.execPath))),
        nodeModules: { source: join(process.cwd(), 'node_modules'), target: join(data, 'apps', 'node_modules') },
      };
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const run = (script: string, net = false) => {
      const c = backend.wrap({ ...spec, args: ['-e', script], net });
      const result = spawnSync(c.cmd, c.args, { cwd: app, env: c.env, encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const read = (path: string) => run(`try { require('node:fs').readFileSync(${JSON.stringify(path)}); console.log('READ-ALLOWED'); }
      catch { console.log('READ-BLOCKED'); }`);

    it('cannot read the secrets file', () => {
      expect(readFileSync(join(config, 'secrets.json'), 'utf8')).toContain('server-secret');
      expect(read(join(config, 'secrets.json'))).toBe('READ-BLOCKED');
    });

    it('cannot read SSH files in a fake home', () => {
      expect(readFileSync(join(home, '.ssh', 'probe'), 'utf8')).toBe('fake-ssh-probe');
      expect(read(join(home, '.ssh', 'probe'))).toBe('READ-BLOCKED');
    });

    it('hides the data and Wayfinder checkout', () => {
      expect(read(join(data, 'workbench.db.probe'))).toBe('READ-BLOCKED');
      expect(read(join(spec.checkout, 'package.json'))).toBe('READ-BLOCKED');
    });

    it.each(['home', 'data', 'config', 'system'])('cannot persist a write outside the app (%s)', folder => {
      const dir = { home, data, config, system: '/usr' }[folder]!;
      const target = join(dir, `wf-escape-${root.split('/').at(-1)}`);
      expect(existsSync(target)).toBe(false);
      // Hidden folders may accept an overlay write; it must disappear when the sandbox exits.
      run(`try { require('node:fs').writeFileSync(${JSON.stringify(target)}, 'escape'); } catch {} console.log('done');`);
      expect(existsSync(target)).toBe(false);
    });

    it('cannot reach a listening host socket without network permission', async () => {
      const server = createServer(socket => socket.destroy());
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No probe port');
        const script = `const socket = require('node:net').connect(${address.port}, '127.0.0.1');
          socket.setTimeout(1000);
          socket.on('connect', () => { console.log('NET-OK'); socket.destroy(); });
          socket.on('error', () => console.log('NET-BLOCKED'));
          socket.on('timeout', () => { console.log('NET-BLOCKED'); socket.destroy(); });`;
        expect(run(script, true)).toBe('NET-OK');
        expect(run(script)).toBe('NET-BLOCKED');
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });

    it("cannot see the server's processes", () => {
      expect(existsSync(`/proc/${process.pid}/cmdline`)).toBe(true);
      expect(read(`/proc/${process.pid}/cmdline`)).toBe('READ-BLOCKED');
    });

    it("cannot read the server's environment", () => {
      expect(existsSync(`/proc/${process.pid}/environ`)).toBe(true);
      expect(read(`/proc/${process.pid}/environ`)).toBe('READ-BLOCKED');
      expect(run('console.log(Object.keys(process.env).join(","))')).not.toMatch(/ANTHROPIC|WAYFINDER|SNW_/);
    });

    it('can persist a write inside the app', () => {
      const target = join(app, 'ok');
      expect(run(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'app-write'); console.log('wrote-app');`)).toBe('wrote-app');
      expect(readFileSync(target, 'utf8')).toBe('app-write');
    });
  });
}
