import { ChildProcess, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/server/sandbox.ts', async (original) => {
  const sandbox = await original<typeof import('../src/server/sandbox.ts')>();
  return { ...sandbox, spawnGroup: vi.fn(sandbox.spawnGroup) };
});
const { spawnGroup } = await import('../src/server/sandbox.ts');
const { spawnGroup: realSpawn } = await vi.importActual<typeof import('../src/server/sandbox.ts')>('../src/server/sandbox.ts');
const { runBuild, buildState, SANDBOX, UNSANDBOXED } = await import('../src/server/buildTools.ts');
const { approvedBuild, recordBuild } = await import('../src/server/buildUpload.ts');
const { APPS_DIR, DATA_DIR, SDK_BIN } = await import('../src/server/config.ts');
const { apps } = await import('../src/server/db.ts');

const previousCommit = 'a'.repeat(40);
const git = (dir: string, args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
function setup(options: { buildFails?: boolean; packFails?: boolean; checkpointFails?: 'add' | 'commit'; invalidPackage?: boolean; dirty?: boolean } = {}) {
  const app = apps.add({ project_id: null, chat_id: null, instance_id: null, name: 'Loans', scope: 'x_acme_' + Math.random().toString(16).slice(2, 8), scope_id: 'b'.repeat(32), spec: '{}' });
  const dir = join(APPS_DIR, app.scope), target = join(dir, 'target');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.vscode'));
  writeFileSync(join(dir, '.vscode', 'extensions.json'), '{"recommendations":["servicenow.fluent-language-extension"]}');
  mkdirSync(target);
  writeFileSync(join(dir, '.gitignore'), 'target/\nnode_modules/\n');
  writeFileSync(join(dir, 'now.config.json'), JSON.stringify({ scope: app.scope, scopeId: app.scope_id }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'loans', version: '1.0.0' }));
  writeFileSync(join(dir, 'src', 'deleted.ts'), 'old source');
  git(dir, ['init', '-q']);
  git(dir, ['add', '--', '.gitignore', 'now.config.json', 'package.json', 'src/deleted.ts']);
  git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial source']);
  rmSync(join(dir, 'src', 'deleted.ts'));
  writeFileSync(join(dir, 'src', 'new.ts'), 'new source');
  const packageInfo = { scope: app.scope, scopeId: app.scope_id, version: '1.0.0', store: false, flows: [], actions: [] };
  writeFileSync(join(target, 'wayfinder.zip'), 'previous package');
  writeFileSync(join(target, 'wayfinder.json'), JSON.stringify(packageInfo));
  recordBuild(app, target, previousCommit);
  apps.update(app.id, { status: 'built' });
  vi.mocked(spawnGroup).mockImplementation((cmd, args, opts) => {
    const sdk = args.includes(SDK_BIN), pack = args.includes('-e');
    const gitAt = args.indexOf('git'), gitArgs = gitAt < 0 ? [] : args.slice(gitAt + 1);
    const failCheckpoint = options.checkpointFails && gitArgs.includes(options.checkpointFails);
    if (!sdk && !pack && !failCheckpoint) return realSpawn(cmd, args, opts);
    const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      let code = 0, out = '';
      if (sdk) {
        expect(existsSync(target)).toBe(false);
        expect(apps.get(app.id)?.status).toBe('build_failed');
        expect(() => approvedBuild(app, previousCommit)).toThrow();
        code = options.buildFails ? 1 : 0;
        out = code ? 'Compiler failed' : 'Build completed successfully';
      } else if (pack) {
        code = options.packFails ? 1 : 0;
        out = code ? 'Packaging failed' : 'Package ready';
        mkdirSync(target);
        mkdirSync(join(dir, '@types'), { recursive: true });
        writeFileSync(join(dir, '@types', 'app.d.ts'), 'declare const app: string;');
        writeFileSync(join(target, 'wayfinder.zip'), 'new package');
        writeFileSync(join(target, 'wayfinder.json'), JSON.stringify({ ...packageInfo, ...(options.invalidPackage ? { scope: 'x_other_app' } : {}) }));
        if (options.dirty) writeFileSync(join(dir, 'unrelated.txt'), 'must stay untracked');
      } else { code = 1; out = 'Checkpoint failed'; }
      child.stdout.write(out);
      child.emit('close', code);
    });
    return child;
  });
  return { app, dir, artifact: join(DATA_DIR, 'build-output', app.id) };
}
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawnGroup).mockReset(); });

describe('runBuild', () => {
  it.each(['buildFails', 'packFails'] as const)('invalidates the old artifact and leaves a failed build after %s', async failure => {
    const { app, artifact } = setup({ [failure]: true });
    const result = await runBuild(app);
    expect(result).toMatchObject({ ok: false, output: expect.stringContaining(failure === 'packFails' ? 'Packaging failed' : 'Compiler failed') });
    expect(apps.get(app.id)).toMatchObject({ status: 'build_failed', last_output: expect.stringContaining(result.output!) });
    expect(existsSync(artifact)).toBe(false);
    const commands = vi.mocked(spawnGroup).mock.calls.map(([, args]) => args);
    expect(commands.some(args => args.includes('add') || args.includes('commit'))).toBe(false);
    if (failure === 'buildFails') expect(commands.some(args => args.includes('-e'))).toBe(false);
  });

  it.each(['add', 'commit'] as const)('refuses to record a package when git %s fails', async checkpointFails => {
    const { app, artifact } = setup({ checkpointFails });
    await expect(runBuild(app)).rejects.toThrow(/Could not checkpoint/);
    expect(apps.get(app.id)?.status).toBe('build_failed');
    expect(existsSync(artifact)).toBe(false);
    if (checkpointFails === 'add') expect(vi.mocked(spawnGroup).mock.calls.some(([, args]) => args.includes('commit'))).toBe(false);
  });

  it('leaves unrelated files untracked and refuses a dirty checkpoint', async () => {
    const { app, dir, artifact } = setup({ dirty: true });
    await expect(runBuild(app)).rejects.toThrow(/Could not checkpoint/);
    expect(git(dir, ['status', '--porcelain'])).toBe('?? unrelated.txt');
    expect(apps.get(app.id)?.status).toBe('build_failed');
    expect(existsSync(artifact)).toBe(false);
  });

  it('keeps the app failed when recording the package fails validation', async () => {
    const { app, artifact } = setup({ invalidPackage: true });
    await expect(runBuild(app)).rejects.toThrow(/scope does not match/);
    expect(apps.get(app.id)?.status).toBe('build_failed');
    expect(existsSync(artifact)).toBe(false);
  });

  it('checkpoints explicit app paths and records the artifact before marking the app built', async () => {
    const { app, dir, artifact } = setup();
    const update = apps.update.bind(apps);
    const statuses: string[] = [];
    vi.spyOn(apps, 'update').mockImplementation((id, patch) => {
      if (patch.status) statuses.push(patch.status);
      if (patch.status === 'built') {
        const receipt = JSON.parse(readFileSync(join(artifact, 'receipt.json'), 'utf8'));
        expect(receipt.commit).toBe(git(dir, ['rev-parse', 'HEAD']));
        expect(approvedBuild(app, receipt.commit).bytes.toString()).toBe('new package');
      }
      return update(id, patch);
    });
    expect(SANDBOX).toBe(false);
    expect(await runBuild(app)).toMatchObject({ ok: true, sandboxed: false, warning: UNSANDBOXED });
    expect(statuses).toEqual(['build_failed', 'built']);
    expect(apps.get(app.id)?.status).toBe('built');
    expect(await buildState(app)).toEqual({ commit: git(dir, ['rev-parse', 'HEAD']), clean: true });
    expect(git(dir, ['ls-files']).split('\n')).toEqual(['.gitignore', '.vscode/extensions.json', '@types/app.d.ts', 'now.config.json', 'package.json', 'src/new.ts']);
    const add = vi.mocked(spawnGroup).mock.calls.find(([, args]) => args.includes('add'))!;
    expect(add[1].slice(add[1].indexOf('git') + 1)).toEqual(['add', '--', 'src', '@types', 'now.config.json', 'package.json', '.gitignore', '.vscode/extensions.json']);
  });
});
