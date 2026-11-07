import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { childEnv, insideApp, LIMITS } = await import('../src/server/sandbox.ts');
const { run } = await import('../src/server/buildTools.ts');
const { none } = await import('../src/server/sandbox/index.ts');

const tmp = () => mkdtempSync(join(tmpdir(), 'wf-sandbox-'));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn: () => boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return fn(); };

describe('childEnv', () => {
  it('passes only the base variables', () => {
    const env = childEnv();
    expect(Object.keys(env).sort()).toEqual(['CI', 'FORCE_COLOR', 'HOME', 'NODE_OPTIONS', 'NO_COLOR', 'PATH']);
    expect(env.HOME).toBe('/tmp/home');
  });
  it.each(['SN_SDK_USER_PWD', 'SN_SDK_SESSION_BEARER_TOKEN'])('refuses instance credentials: %s', (key) => {
    expect(() => childEnv({ [key]: 'test-only' })).toThrow(/Refusing to pass/);
  });
  it('refuses anything else, such as a model key', () => {
    expect(() => childEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toThrow(/Refusing to pass ANTHROPIC_API_KEY/);
  });
});

describe('run (without bubblewrap)', () => {
  it("never hands the server's own secrets to the process", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    process.env.WAYFINDER_APP_TOKEN_TEST = 'nope';
    const r = await run('/usr/bin/env', [], { cwd: tmp() }, none);
    delete process.env.ANTHROPIC_API_KEY; delete process.env.WAYFINDER_APP_TOKEN_TEST;
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/ANTHROPIC|sk-ant|WAYFINDER_APP_TOKEN_TEST/);
    expect(r.out).toMatch(/NODE_OPTIONS=--max-old-space-size=2048/);
  });
  it('applies CPU, file-size and open-file limits', async () => {
    const r = await run('/bin/sh', ['-c', 'ulimit -t; ulimit -f; ulimit -n'], { cwd: tmp() }, none);
    expect(r.out.trim().split(/\s+/)).toEqual([String(LIMITS.cpuSeconds), String(LIMITS.fileBlocks512), String(LIMITS.openFiles)]);
  });
  it('stops the whole process group on timeout, including children that ignore SIGTERM', async () => {
    const dir = tmp();
    const script = `(trap '' TERM; exec sleep 300) & echo $! > ${dir}/stubborn; sleep 300 & echo $! > ${dir}/plain; wait`;
    const r = await run('/bin/sh', ['-c', script], { cwd: dir, timeoutMs: 600 }, none);
    expect(r.out).toMatch(/timed out/);
    const plain = Number(readFileSync(join(dir, 'plain'), 'utf8'));
    const stubborn = Number(readFileSync(join(dir, 'stubborn'), 'utf8'));
    expect(await until(() => !alive(plain), 2000)).toBe(true);
    expect(await until(() => !alive(stubborn), 8000)).toBe(true);
  }, 15_000);
});

describe('insideApp', () => {
  const app = () => {
    const root = tmp();
    mkdirSync(join(root, 'src', 'fluent'), { recursive: true });
    writeFileSync(join(root, 'src', 'fluent', 'tables.now.ts'), '');
    mkdirSync(join(root, '.git'));
    return root;
  };
  it('allows files in the app, existing or new', () => {
    const root = app();
    expect(insideApp(root, 'src/fluent/tables.now.ts', { srcOnly: true })).toMatch(/src\/fluent\/tables\.now\.ts$/);
    expect(insideApp(root, 'src/new/dir/file.ts', { srcOnly: true })).toMatch(/src\/new\/dir\/file\.ts$/);
    expect(insideApp(root, 'now.config.json')).toMatch(/now\.config\.json$/);
  });
  it.each([
    ['../outside.ts', /outside the app/],
    ['src/../../outside.ts', /outside the app/],
    ['/etc/passwd', /relative/],
    ['.git/config', /git history/],
    ['src/.git/x', /git history/],
  ])('refuses %s', (p, err) => expect(() => insideApp(app(), p)).toThrow(err));
  it('keeps writes out of the build output and outside src', () => {
    expect(() => insideApp(app(), 'src/fluent/generated/x.ts', { srcOnly: true })).toThrow(/inside src/);
    expect(() => insideApp(app(), 'package.json', { srcOnly: true })).toThrow(/inside src/);
  });
  it('refuses symlinks anywhere on the path, so a planted link cannot reach outside', () => {
    const root = app();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.json'), '{}');
    symlinkSync(outside, join(root, 'src', 'escape'));
    symlinkSync(join(outside, 'secret.json'), join(root, 'src', 'fluent', 'link.ts'));
    expect(() => insideApp(root, 'src/escape/secret.json')).toThrow(/symlink/);
    expect(() => insideApp(root, 'src/escape/new.ts', { srcOnly: true })).toThrow(/symlink/);
    expect(() => insideApp(root, 'src/fluent/link.ts', { srcOnly: true })).toThrow(/symlink/);
  });
});
