import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// What a build process can reach inside bubblewrap. Linux only, and only where bwrap can make namespaces; elsewhere
// these are skipped (they run in CI-like containers: see docs/RUNBOOK.md, "Testing the build sandbox").
const usable = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true']).status === 0;

const { run } = await import('../src/server/buildTools.ts');
const { APPS_DIR, CONFIG_DIR, DATA_DIR } = await import('../src/server/config.ts');

describe.skipIf(!usable)('build sandbox (bubblewrap)', () => {
  const appDir = join(APPS_DIR, 'x_test_iso');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'secrets.json'), '{"appToken":"server-secret"}');
  writeFileSync(join(DATA_DIR, 'workbench.db.probe'), 'data');
  const sh = (script: string, net = false) => run('/bin/sh', ['-c', script], { cwd: appDir, write: [appDir], net }, true);

  it('hides the secrets file, the data folder, home and the Wayfinder checkout', async () => {
    const r = await sh(`cat ${CONFIG_DIR}/secrets.json; ls -A ${DATA_DIR} ${homedir()} ${process.cwd()} 2>&1; echo done`);
    expect(r.out).not.toContain('server-secret');
    expect(r.out).not.toContain('workbench.db.probe');
    expect(r.out).not.toContain('package.json');
    expect(r.out).toContain('done');
  });
  it("can't see the server's processes or their environment", async () => {
    const r = await sh(`cat /proc/${process.pid}/environ 2>&1; ls /proc | grep -c '^[0-9]'`);
    expect(r.out).not.toMatch(/ANTHROPIC|PATH=/);
    expect(Number(r.out.trim().split('\n').at(-1))).toBeLessThan(10);
  });
  it('has no network unless it is an install', async () => {
    const r = await sh(`${process.execPath} -e "fetch('http://1.1.1.1').then(()=>console.log('NET-OK'),e=>console.log('NET-FAIL',e.cause?.code??e.message))"`);
    expect(r.out).toContain('NET-FAIL');
  });
  it('changes only its own app folder on the real disk', async () => {
    // Hidden folders are empty in-memory overlays inside the sandbox: a write there succeeds but vanishes with it.
    const r = await sh(`touch ${appDir}/ok && echo wrote-app; touch ${DATA_DIR}/escape ${CONFIG_DIR}/escape ${homedir()}/escape 2>&1; touch /usr/escape 2>&1 || echo blocked-root`);
    expect(r.out).toContain('wrote-app');
    expect(r.out).toContain('blocked-root');
    expect(existsSync(join(appDir, 'ok'))).toBe(true);
    for (const d of [DATA_DIR, CONFIG_DIR, homedir()]) expect(existsSync(join(d, 'escape'))).toBe(false);
  });
});
