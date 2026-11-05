import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Runs ops/auto-deploy.sh for real in a throwaway checkout, with fake systemctl, npm, npx and curl on PATH.
// The checkout runs 1.0.0; origin/main has 1.0.1. Builds go to <root>/builds. FAKE_* env vars pick what goes wrong.
// The checkout, its origin and the stubs are made once (beforeAll) and copied for each test, which is far cheaper
// than git init and three commits per test.
let template = '', root = '', work = '', data = '', bin = '';
const places = (r: string) => { root = r; work = join(r, 'work'); data = join(r, 'data'); bin = join(r, 'bin'); };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
const commit = (version: string) => {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ version }));
  git(work, 'commit', '-qam', version);
};
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'autodeploy-template-'));
  places(template);
  mkdirSync(join(work, 'ops'), { recursive: true }); mkdirSync(join(work, 'node_modules')); mkdirSync(bin);
  copyFileSync(join(import.meta.dirname, '../ops/auto-deploy.sh'), join(work, 'ops/auto-deploy.sh'));
  writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 't');
  git(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
  writeFileSync(join(work, 'package.json'), '{}'); git(work, 'add', '.');
  commit('1.0.0'); commit('1.0.1');
  git(work, 'push', '-q', 'origin', 'main'); git(work, 'reset', '-q', '--hard', 'HEAD~1');

  const version = `$(node -p "require('./package.json').version")`;
  stub('flock', 'exit 0');
  // FAKE_BUS_CALLS: how many bus checks succeed before the bus goes missing (unset = always there).
  stub('systemctl', `
case "$*" in
  *show-environment*) [ -z "\${FAKE_BUS_CALLS:-}" ] && exit 0
    n=$(cat "$FAKE_DIR/bus" 2>/dev/null || echo 0); echo $((n+1)) > "$FAKE_DIR/bus"; [ "$n" -lt "$FAKE_BUS_CALLS" ] ;;
  *restart*) echo "restart while $(cat "$FAKE_DIR/busy" 2>/dev/null || echo 0) answering, new answers $([ -f "$WAYFINDER_DATA_DIR/updating.json" ] && echo held || echo open)" >> "$FAKE_DIR/restarts"
    [ -z "\${FAKE_BUS_CALLS:-}" ] && exit 0; echo "Failed to connect to bus: No such file or directory" >&2; exit 1 ;;
  *) exit 0 ;;
esac`);
  // FAKE_BUILD_FAILS: the version whose build fails. Every npm call notes the folder it ran in.
  stub('npm', `echo "$PWD $*" >> "$FAKE_DIR/npm"; [ "$*" = "run -s build" ] && [ "${version}" = "\${FAKE_BUILD_FAILS:-}" ] && { echo "TS2322 nope"; exit 1; }; exit 0`);
  stub('npx', `
case "$*" in
  *token.ts*) echo tok ;;
  *smoke.ts*) [ "${version}" = "\${FAKE_SMOKE_FAILS:-}" ] && { echo "speed budget missed"; exit 1; }; echo smoke ok ;;
esac`);
  // FAKE_DIR/busy: answers running now; each check after the first sees one fewer (FAKE_STUCK: they never finish).
  // FAKE_BUSY_REPLY: 'error' (a 500 with no count), 'odd' (200 without a count), 'down' (nothing listening).
  stub('curl', `case "$*" in
  *api/about*) echo "{\\"version\\":\\"\${FAKE_RUNNING:-}\\"}" ;;
  *api/busy*) cat >/dev/null; n=$(cat "$FAKE_DIR/busy" 2>/dev/null || echo 0); echo "$n" >> "$FAKE_DIR/checks"
    case "\${FAKE_BUSY_REPLY:-}" in
      error) printf 'oops\\n500'; exit 0 ;;
      odd) printf '{"answering":"lots"}\\n200'; exit 0 ;;
      down) exit 7 ;;
    esac
    # FAKE_SLIP: an answer starts right after the first idle check (the one before the hold is taken).
    [ -n "\${FAKE_SLIP:-}" ] && [ "$(wc -l < "$FAKE_DIR/checks")" -eq 2 ] && { printf '{"answering":1}\\n200'; exit 0; }
    printf '{"answering":%s}\\n200' "$n"
    [ "$n" -gt 0 ] && [ -z "\${FAKE_STUCK:-}" ] && echo $((n-1)) > "$FAKE_DIR/busy"; exit 0 ;;
esac`);
  stub('notify', 'echo "$1 | $2" >> "$FAKE_DIR/pings"');
});
beforeEach(() => {
  places(mkdtempSync(join(tmpdir(), 'autodeploy-')));
  cpSync(template, root, { recursive: true });
  git(work, 'remote', 'set-url', 'origin', join(root, 'origin.git'));
});

const run = (env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [join(work, 'ops/auto-deploy.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WAYFINDER_DATA_DIR: data, WAYFINDER_BUILDS_DIR: join(root, 'builds'), XDG_CONFIG_HOME: join(root, 'config'), SNW_DATA_DIR: '', WAYFINDER_PORT: '', SNW_PORT: '', FAKE_DIR: root, WAYFINDER_NOTIFY: join(bin, 'notify'), XDG_RUNTIME_DIR: join(root, 'run'), ...env },
  });
  expect(r.status, r.stderr.toString()).toBe(0);
};
const head = () => JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version;   // the source checkout
const current = () => join(root, 'builds', 'current');
const runningDir = () => (existsSync(current()) ? readlinkSync(current()) : work);
const running = () => JSON.parse(readFileSync(join(runningDir(), 'package.json'), 'utf8')).version;   // what the service runs
const builds = () => readdirSync(join(root, 'builds')).filter((d) => d !== 'current').sort();
const log = () => readFileSync(join(data, 'deploy.log'), 'utf8');
const status = () => JSON.parse(readFileSync(join(data, 'deploy-status.json'), 'utf8'));
const lines = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8').trim().split('\n') : []);
const pings = () => (existsSync(join(root, 'pings')) ? readFileSync(join(root, 'pings'), 'utf8').trim().split('\n') : []);

const push = (version: string) => { git(work, 'checkout', '-q', 'main'); commit(version); git(work, 'push', '-q', 'origin', 'main'); git(work, 'reset', '-q', '--hard', 'HEAD~1'); };

// Real git worktrees and several deploys per test: slower than the 5 s default under a full parallel run.
describe('auto-deploy', { timeout: 30_000 }, () => {
  it('builds the new commit in its own folder, switches the service to it, holds new answers only around the restart, and sends no ping', () => {
    run();
    expect(running()).toBe('1.0.1');
    expect(realpathSync(runningDir())).not.toBe(realpathSync(work));
    const ranIn = lines('npm').map((l) => realpathSync(l.split(' ')[0]));
    expect(ranIn).not.toContain(realpathSync(work));   // nothing installed or built where the app ran
    expect(ranIn).toContain(realpathSync(runningDir()));
    expect(head()).toBe('1.0.1');   // the source checkout follows once the new build runs
    expect(readFileSync(join(root, 'config/systemd/user/wayfinder.service.d/50-wayfinder-builds.conf'), 'utf8'))
      .toBe(`[Service]\nWorkingDirectory=${join(realpathSync(join(root, 'builds')), 'current')}\n`);
    expect(log()).toContain('the service now runs from');
    expect(status()).toMatchObject({ ok: true, message: 'deployed' });
    expect(pings()).toEqual([]);
    expect(lines('restarts')).toEqual(['restart while 0 answering, new answers held']);
    expect(existsSync(join(data, 'updating.json'))).toBe(false);   // released once the new server is up
  });

  it('waits for running answers to finish before the restart, then deploys', () => {
    writeFileSync(join(root, 'busy'), '2');
    run({ WAYFINDER_DEPLOY_POLL: '0' });
    expect(running()).toBe('1.0.1');
    expect(lines('checks').slice(0, 3)).toEqual(['2', '1', '0']);
    expect(lines('restarts')).toEqual(['restart while 0 answering, new answers held']);
    expect(log()).toContain('restarts the app: 2 answer(s) running');
    expect(status()).toMatchObject({ ok: true, message: 'deployed' });
  });

  it('an answer that starts between the idle check and the hold is waited for too', () => {
    run({ WAYFINDER_DEPLOY_POLL: '0', FAKE_SLIP: '1' });
    expect(lines('checks')).toEqual(['0', '0', '0', '0']);   // idle, held but one slipped in, idle again, held and quiet
    expect(lines('restarts')).toEqual(['restart while 0 answering, new answers held']);
  });

  it('when answers outlast the wait, restarts anyway and says so', () => {
    writeFileSync(join(root, 'busy'), '1');
    run({ WAYFINDER_DEPLOY_POLL: '0', WAYFINDER_DEPLOY_WAIT: '0', FAKE_STUCK: '1' });
    expect(running()).toBe('1.0.1');
    expect(log()).toContain('1 answer(s) running after 0 s; restarting anyway');
    expect(lines('restarts')).toEqual(['restart while 1 answering, new answers held']);
  });

  it('an error or a reply without a count is not "idle": it keeps waiting, and only the wait running out lets it go', () => {
    for (const [reply, next] of [['error', '1.0.2'], ['odd', '']]) {
      // 2: at least one whole second. Polling 0.2 s apart, not flat out: each check starts node, which would starve the other test workers.
      run({ WAYFINDER_DEPLOY_POLL: '0.2', WAYFINDER_DEPLOY_WAIT: '2', FAKE_BUSY_REPLY: reply });
      expect(lines('checks').length, reply).toBeGreaterThan(2);   // asked again and again, not taken as 0
      expect(log()).toContain("the app couldn't say whether answers are running after 2 s; restarting anyway");
      if (next) { push(next); writeFileSync(join(root, 'checks'), ''); }
    }
  });

  it('with nothing listening on the port, there is no answer to cut off, so it deploys without waiting', () => {
    run({ WAYFINDER_DEPLOY_POLL: '0', FAKE_BUSY_REPLY: 'down' });
    expect(running()).toBe('1.0.1');
    expect(log()).not.toContain('waiting');
  });

  it('a build that fails changes nothing that runs: no switch, no restart, one ping', () => {
    run({ FAKE_BUILD_FAILS: '1.0.1' });
    run({ FAKE_BUILD_FAILS: '1.0.1' });
    expect(running()).toBe('1.0.0');
    expect(head()).toBe('1.0.0');
    expect(lines('restarts')).toEqual([]);
    expect(log()).toContain('FAILED at build: build failed; nothing changed, still running');
    expect(log()).toContain('    TS2322 nope');
    expect(status()).toMatchObject({ ok: false, message: expect.stringContaining('still running') });
    expect(pings()).toHaveLength(1);
  });

  it('with no user bus, leaves the running build alone, says why, and pings once per commit', () => {
    run({ FAKE_BUS_CALLS: '0', FAKE_RUNNING: '1.0.0' });
    run({ FAKE_BUS_CALLS: '0', FAKE_RUNNING: '1.0.0' });
    expect(running()).toBe('1.0.0');
    expect(log()).toContain("can't reach the user manager");
    expect(log()).toContain('sudo systemctl restart user@');
    expect(status().message).toContain('still running 1.0.0');
    expect(pings()).toHaveLength(1);
  });

  it('a smoke test that fails switches back to the build that ran before, restarts it, and pings once', () => {
    run({ FAKE_SMOKE_FAILS: '1.0.1' });
    run({ FAKE_SMOKE_FAILS: '1.0.1' });
    expect(running()).toBe('1.0.0');
    expect(realpathSync(runningDir())).toBe(realpathSync(work));   // the checkout it ran from before the first switch
    expect(head()).toBe('1.0.0');
    expect(log()).toContain('FAILED at smoke: smoke test failed');
    expect(log()).toContain('    speed budget missed');
    expect(status()).toMatchObject({ ok: false, message: expect.stringContaining('failed at smoke and was rolled back') });
    expect(pings()).toHaveLength(1);
    expect(pings()[0]).toContain('rolled back');
    expect(existsSync(join(data, 'updating.json'))).toBe(false);
  });

  it('keeps the running build and the one before it, and never removes the checkout', () => {
    run();
    push('1.0.2'); run();
    expect(running()).toBe('1.0.2');
    expect(builds()).toHaveLength(2);
    push('1.0.3'); run();
    expect(running()).toBe('1.0.3');
    expect(builds()).toHaveLength(2);   // 1.0.1 removed
    expect(builds().map((d) => JSON.parse(readFileSync(join(root, 'builds', d, 'package.json'), 'utf8')).version).sort()).toEqual(['1.0.2', '1.0.3']);
    expect(existsSync(join(work, 'package.json'))).toBe(true);
    expect(existsSync(current())).toBe(true);
  });

  it('never discards anything in the checkout: with local changes it stays put, and the new build runs anyway', () => {
    writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '1.0.0', local: 'edit' }));
    run();
    expect(running()).toBe('1.0.1');
    expect(JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'))).toEqual({ version: '1.0.0', local: 'edit' });
    expect(log()).toContain('the checkout has local changes, so it stays where it is');
    run();   // nothing new to deploy: it goes by what runs, not by where the checkout is
    expect(lines('restarts')).toHaveLength(1);
  });

  it('refuses a builds folder that is home, the checkout or a folder holding it (or a link to one), and deletes nothing', () => {
    const home = join(root, 'home'); mkdirSync(home);   // a stand-in: a broken guard must not reach the real one
    symlinkSync(home, join(root, 'to-home')); symlinkSync(work, join(root, 'to-work')); symlinkSync(root, join(root, 'to-root'));
    for (const dir of [root, work, home, join(root, 'to-home'), join(root, 'to-work'), join(root, 'to-root')]) {
      run({ WAYFINDER_BUILDS_DIR: dir, HOME: home });
      expect(log()).toContain('not deploying: WAYFINDER_BUILDS_DIR');
      expect(running()).toBe('1.0.0');
    }
    expect(existsSync(join(work, 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'data'))).toBe(true);
    expect(lines('restarts')).toEqual([]);
  });

  it('cleans up only builds it made, never anything else in the builds folder', () => {
    mkdirSync(join(root, 'builds', 'notes'), { recursive: true }); writeFileSync(join(root, 'builds', 'notes', 'keep.txt'), 'x');
    mkdirSync(join(root, 'builds', 'deadbeef0000'));   // looks like a build, but this script didn't make it
    run(); push('1.0.2'); run(); push('1.0.3'); run();
    expect(existsSync(join(root, 'builds', 'notes', 'keep.txt'))).toBe(true);
    expect(existsSync(join(root, 'builds', 'deadbeef0000'))).toBe(true);
    expect(builds().filter((d) => /^[0-9a-f]{12}$/.test(d) && d !== 'deadbeef0000')).toHaveLength(2);
  });

  it('a folder named after the new commit that it did not make is left alone: the deploy stops, nothing changes', () => {
    const sha12 = git(work, 'ls-remote', 'origin', 'main').slice(0, 12);
    mkdirSync(join(root, 'builds', sha12), { recursive: true }); writeFileSync(join(root, 'builds', sha12, 'keep.txt'), 'x');
    run();
    expect(readFileSync(join(root, 'builds', sha12, 'keep.txt'), 'utf8')).toBe('x');
    expect(running()).toBe('1.0.0');
    expect(lines('restarts')).toEqual([]);
    expect(log()).toContain("isn't a build this script made");
  });

  it('when it cannot hold new answers for the restart, it stops: no switch, no restart, one ping', () => {
    mkdirSync(join(data, 'updating.json'), { recursive: true });   // the hold file can't be written
    run();
    expect(running()).toBe('1.0.0');
    expect(lines('restarts')).toEqual([]);
    expect(log()).toContain("couldn't write");
    expect(status()).toMatchObject({ ok: false, message: expect.stringContaining("couldn't hold new answers") });
    expect(pings()).toHaveLength(1);
  });

  it('when the bus goes away mid-update, reports "not restarted, still running" instead of "both failed"', () => {
    run({ FAKE_BUS_CALLS: '1', FAKE_RUNNING: '1.0.0' });
    expect(running()).toBe('1.0.0');
    expect(log()).toContain('Failed to connect to bus');
    expect(log()).toContain('not restarted, still running 1.0.0');
    expect(status().message).toContain('not restarted');
    expect(status().message).not.toContain('both failed');
    expect(pings()).toHaveLength(1);
  });
});
