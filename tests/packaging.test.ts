import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The installers, the `wayfinder` command and the release packing. No network: releases are served from a folder
// (file:// URLs), and nothing here installs packages or starts a server.
const CLI = 'packaging/wayfinder';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('scripts parse', () => {
  it.each([[CLI, 'bash'], ['packaging/pack.sh', 'bash'], ['packaging/test/linux-install.sh', 'bash'], ['packaging/install.sh', 'sh']])('%s', (file, shell) => {
    expect(spawnSync(shell, ['-n', file]).status).toBe(0);
  });
  it('install.sh is plain sh (it arrives through `curl | sh`)', () => {
    const src = readFileSync('packaging/install.sh', 'utf8');
    expect(src.startsWith('#!/bin/sh')).toBe(true);
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/\[\[ |^\s*(function|local|declare) |<<<|\$\{[A-Za-z_]+,,/m);
  });
});

describe('what the installers run', () => {
  const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  // What runs, without comments and without the text it prints (messages may show commands for you to run).
  const runs = (f: string) => code(f).replace(/"(?:[^"\\]|\\.)*"/g, '""');
  it('nothing downloaded is piped into a shell, and nothing runs with sudo', () => {
    for (const f of ['packaging/install.sh', 'packaging/wayfinder', 'packaging/install.ps1']) {
      expect(runs(f)).not.toMatch(/\|\s*(\w+=\S*\s+)*(sudo\b|(ba|z)?sh\b)/); // also `| VAR=x bash`
      expect(runs(f)).not.toMatch(/\bsudo\b/);
    }
  });
  it("nvm's installer is checked against a pinned checksum before it runs", () => {
    const src = code('packaging/install.sh');
    expect(src).toMatch(/NVM_SHA256=[0-9a-f]{64}/);
    expect(src.indexOf('"$NVM_SHA256"')).toBeLessThan(src.indexOf('bash "$tmp/nvm-install.sh"'));
  });
  it('install.ps1 checks install.sh against its published checksum inside WSL before running it', () => {
    const ps1 = readFileSync('packaging/install.ps1', 'utf8');
    const fetch = /^\$Fetch = '((?:[^']|'')*)'$/m.exec(ps1)![1].replace(/''/g, "'");
    expect(ps1).toMatch(/^\$Fetch \| & wsl\.exe @Distro -e sh -s -- \$Base \$Version$/m);
    const rel = mkdtempSync(join(tmpdir(), 'wf-ps1-')), dl = join(rel, 'latest', 'download');
    mkdirSync(dl, { recursive: true });
    const script = 'echo "install.sh ran with base $WAYFINDER_DOWNLOAD_BASE"\n';
    writeFileSync(join(dl, 'install.sh'), script);
    const run = () => spawnSync('sh', ['-s', '--', `file://${rel}`], { input: `${fetch}\r\n`, encoding: 'utf8' }); // PowerShell adds CRLF
    writeFileSync(join(dl, 'SHA256SUMS'), `${sha('other')}  wayfinder-1.0.0.tgz\n${sha(script)}  install.sh\n`);
    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`install.sh ran with base file://${rel}\n`);
    writeFileSync(join(dl, 'install.sh'), `${script}echo tampered\n`);
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('install.sh does not match its published checksum; nothing was run');
  });
  it('the login token never goes on a command line', () => {
    expect(code('packaging/wayfinder')).not.toMatch(/-H\s+"Authorization/);
  });
});

describe('wayfinder update and running answers', () => {
  // busy_count + wait_idle on their own, with the real json helper and a fake curl: the count comes from a file and
  // each check sees one fewer (STUCK: never finishes); REPLY=error|odd|down picks a bad answer.
  const waitIdle = (busy: number, env: Record<string, string> = {}) => {
    const src = readFileSync(CLI, 'utf8');
    const fns = [/^json\(\) \{.*\}$/m, /^busy_count\(\) \{[\s\S]*?^\}$/m, /^wait_idle\(\) \{[\s\S]*?^\}$/m].map((re) => re.exec(src)![0]).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'wf-idle-'));
    writeFileSync(join(dir, 'busy'), String(busy));
    const stubs = `say() { echo "$*"; }\ntoken() { echo tok; }\nNODE=${JSON.stringify(process.execPath)}; URL=http://127.0.0.1:1\n` +
      `curl() { cat >/dev/null; n=$(cat "${dir}/busy"); echo "$n" >> "${dir}/checks"\n` +
      `  case "\${REPLY_KIND:-}" in error) printf 'oops\\n500'; return 0 ;; odd) printf '{}\\n200'; return 0 ;; down) return 7 ;; esac\n` +
      `  printf '{"answering":%s}\\n200' "$n"; [ "$n" -gt 0 ] && [ -z "\${STUCK:-}" ] && echo $((n-1)) > "${dir}/busy"; return 0; }\n`;
    const r = spawnSync('bash', ['-c', `${stubs}${fns}\nwait_idle; echo done`], { encoding: 'utf8', env: { PATH: process.env.PATH, WAYFINDER_UPDATE_POLL: '0', ...env } });
    return { out: r.stdout + r.stderr, checks: readFileSync(join(dir, 'checks'), 'utf8').trim().split('\n') };
  };
  it('waits for Pip to finish before it restarts', () => {
    const { out, checks } = waitIdle(2);
    expect(checks).toEqual(['2', '1', '0']);
    expect(out).toBe('Waiting for Pip to finish 2 answer(s) before restarting…\ndone\n');
  });
  it('goes ahead when the answers outlast the wait, and says so', () => {
    const { out } = waitIdle(1, { STUCK: '1', WAYFINDER_UPDATE_WAIT: '0' });
    expect(out).toContain('restarting anyway');
    expect(out.trim().endsWith('done')).toBe(true);
  });
  it('a reply it cannot read counts as busy until the wait runs out', () => {
    for (const kind of ['error', 'odd']) {
      // Each check starts node to read the reply: on a slow runner only a couple fit in the wait, so ask for more than one.
      // Polling 0.2 s apart, not flat out, so the checks don't starve the other test workers.
      const { out, checks } = waitIdle(0, { REPLY_KIND: kind, WAYFINDER_UPDATE_WAIT: '2', WAYFINDER_UPDATE_POLL: '0.2' });
      expect(checks.length, kind).toBeGreaterThan(1);
      expect(out).toContain("couldn't say whether Pip is answering");
      expect(out).toContain('restarting anyway');
    }
  }, 15_000);   // two 2 s waits: over the 5 s default on a slow or busy runner
  it('nothing listening means nothing to wait for', () => {
    const { out, checks } = waitIdle(3, { REPLY_KIND: 'down' });
    expect(checks).toEqual(['3']);
    expect(out).toBe('done\n');
  });
  it('waits, then holds new answers, before it switches versions; lets them go once the new one runs or it goes back', () => {
    const src = readFileSync(CLI, 'utf8');
    const update = /^cmd_update\(\) \{[\s\S]*?^\}$/m.exec(src)![0];
    expect(update.indexOf('[ -n "$was_running" ] && ! quiet')).toBeLessThan(update.indexOf('link_current "$l"'));
    expect(update.indexOf('die "couldn\'t hold new answers')).toBeLessThan(update.indexOf('link_current "$l"'));
    expect(update.match(/release_answers/g)).toHaveLength(3);
  });
  it('holds new answers only once none are running, and waits again for one that slipped in before the hold', () => {
    const src = readFileSync(CLI, 'utf8');
    const fns = [/^json\(\) \{.*\}$/m, /^busy_count\(\) \{[\s\S]*?^\}$/m, /^wait_idle\(\) \{[\s\S]*?^\}$/m, /^hold_answers\(\) .*$/m, /^release_answers\(\) .*$/m, /^quiet\(\) \{[\s\S]*?^\}$/m].map((re) => re.exec(src)![0]).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'wf-quiet-'));
    // Each check notes the count and whether answers were held; the second check sees one answer that just started.
    const stubs = `say() { echo "$*"; }\ntoken() { echo tok; }\nNODE=${JSON.stringify(process.execPath)}; URL=http://127.0.0.1:1; DATA=${JSON.stringify(dir)}\n` +
      `curl() { cat >/dev/null; k=$(cat "${dir}/k" 2>/dev/null || echo 0); echo $((k+1)) > "${dir}/k"; n=0; [ "$k" = 1 ] && n=1\n` +
      `  echo "$n $([ -f "${dir}/updating.json" ] && echo held || echo open)" >> "${dir}/checks"; printf '{"answering":%s}\\n200' "$n"; return 0; }\n`;
    const r = spawnSync('bash', ['-c', `${stubs}${fns}\nquiet; [ -f "${dir}/updating.json" ] && echo held`], { encoding: 'utf8', env: { PATH: process.env.PATH, WAYFINDER_UPDATE_POLL: '0' } });
    expect(readFileSync(join(dir, 'checks'), 'utf8').trim().split('\n')).toEqual(['0 open', '1 held', '0 open', '0 held']);
    expect(r.stdout.trim()).toBe('held');
    expect(JSON.parse(readFileSync(join(dir, 'updating.json'), 'utf8')).until).toBeGreaterThan(Date.now());
  });
  it('fails when the hold cannot be written, so the update stops before it switches versions', () => {
    const src = readFileSync(CLI, 'utf8');
    const fns = [/^json\(\) \{.*\}$/m, /^busy_count\(\) \{[\s\S]*?^\}$/m, /^wait_idle\(\) \{[\s\S]*?^\}$/m, /^hold_answers\(\) .*$/m, /^release_answers\(\) .*$/m, /^quiet\(\) \{[\s\S]*?^\}$/m].map((re) => re.exec(src)![0]).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'wf-quiet-'));
    mkdirSync(join(dir, 'updating.json'));   // the hold file can't be written
    const stubs = `say() { echo "$*"; }\ntoken() { echo tok; }\nNODE=${JSON.stringify(process.execPath)}; URL=http://127.0.0.1:1; DATA=${JSON.stringify(dir)}\n` +
      `curl() { cat >/dev/null; printf '{"answering":0}\\n200'; return 0; }\n`;
    const r = spawnSync('bash', ['-c', `${stubs}${fns}\nquiet && echo went-ahead || echo stopped`], { encoding: 'utf8', env: { PATH: process.env.PATH, WAYFINDER_UPDATE_POLL: '0' } });
    expect(r.stdout.trim().split('\n').at(-1)).toBe('stopped');
  });
});

describe('the wayfinder command', () => {
  // A fake install: <root>/<version>/ with the command and package.json, `current` pointing at it, and a release
  // folder laid out like GitHub's (latest/download/…, download/v<version>/…).
  function setup(latest: string, tgz = Buffer.from('not really a package'), published = sha(tgz)) {
    const dir = mkdtempSync(join(tmpdir(), 'wf-cli-'));
    const root = join(dir, 'share'), app = join(root, '1.0.0'), rel = join(dir, 'rel');
    mkdirSync(join(app, 'packaging'), { recursive: true });
    cpSync(CLI, join(app, 'packaging', 'wayfinder'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    symlinkSync('1.0.0', join(root, 'current'));
    for (const d of [join(rel, 'latest', 'download'), join(rel, 'download', `v${latest}`)]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SHA256SUMS'), `${published}  wayfinder-${latest}.tgz\n`);
      writeFileSync(join(d, `wayfinder-${latest}.tgz`), tgz);
    }
    const run = (...args: string[]) => spawnSync('bash', [join(root, 'current', 'packaging', 'wayfinder'), ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: dir, WAYFINDER_NODE: process.execPath, WAYFINDER_INSTALL_DIR: root,
        WAYFINDER_DOWNLOAD_BASE: `file://${rel}`, WAYFINDER_DATA_DIR: join(dir, 'data'), WAYFINDER_CONFIG_DIR: join(dir, 'config'),
        WAYFINDER_PORT: '1', // nothing answers there
      },
    });
    return { dir, root, run };
  }

  it('a service run without a terminal logs into the private data folder', () => {
    const { dir, run } = setup('1.0.0');
    const r = run('start', '--foreground'); // no tsx in the fake install, so the server exits at once; the log shows where output went
    expect(r.stdout).toBe('');
    expect(readFileSync(join(dir, 'data', 'wayfinder.log'), 'utf8').length).toBeGreaterThan(0);
    expect(execFileSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', join(dir, 'data')] : ['-c', '%a', join(dir, 'data')], { encoding: 'utf8' }).trim()).toBe('700');
    expect(readFileSync('packaging/homebrew/wayfinder.rb.tmpl', 'utf8')).not.toMatch(/^\s*(error_)?log_path\s/m);
  });

  it('lists every command in its help', () => {
    const out = execFileSync('bash', [CLI, 'help'], { encoding: 'utf8' });
    for (const c of ['start', 'stop', 'status', 'open', 'token', 'update', 'doctor', 'version', 'logs']) expect(out).toMatch(new RegExp(`^  ${c}\\b`, 'm'));
  });

  it('reads the latest version from the release checksums', () => {
    const { run } = setup('1.2.3');
    expect(run('version').stdout).toBe('wayfinder 1.0.0\nlatest release: 1.2.3\n');
    expect(run('update', '--check').stdout).toContain('Update available: 1.0.0 → 1.2.3');
  });

  it('says so when it is up to date', () => {
    const { run } = setup('1.0.0');
    const r = run('update');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Wayfinder 1.0.0 is up to date');
  });

  it('refuses a download that does not match its checksum, and changes nothing', () => {
    const { root, run } = setup('1.2.3', Buffer.from('tampered'), sha('the real package'));
    const r = run('update');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("wayfinder-1.2.3.tgz doesn't match its published checksum; nothing was changed");
    expect(readlinkSync(join(root, 'current'))).toBe('1.0.0');
    expect(existsSync(join(root, '1.2.3'))).toBe(false);
  });

  it('skips a release that already failed here, unless forced', () => {
    const { root, run } = setup('1.2.3', Buffer.from('tampered'), sha('the real package'));
    writeFileSync(join(root, '.failed'), '1.2.3\n');
    const r = run('update');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Skipping 1.2.3: it failed its checks here before');
    expect(run('update', '--force').stderr).toContain("doesn't match its published checksum"); // --force tries again
  });

  it('leaves copies it did not install to their own update method', () => {
    const r = spawnSync('bash', [CLI, 'update'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'wf-home-')), WAYFINDER_NODE: process.execPath } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("wasn't installed by install.sh");
    const brew = spawnSync('bash', [CLI, 'update'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir(), WAYFINDER_NODE: process.execPath, WAYFINDER_MANAGED_BY: 'homebrew' } });
    expect(brew.stderr).toContain('brew upgrade wayfinder');
  });

  it('doctor flags data and settings folders that others can read', () => {
    const { dir, run } = setup('1.0.0');
    mkdirSync(join(dir, 'data'), { mode: 0o775 }); mkdirSync(join(dir, 'config'), { mode: 0o700 });
    execFileSync('chmod', ['775', join(dir, 'data')]);
    const out = run('doctor').stdout;
    expect(out).toMatch(/FAIL {2}data folder .* is open to others \(775\)/);
    expect(out).toMatch(/→ chmod 700/);
    expect(out).toMatch(/ok {4}settings folder .* \(private, 700\)/);
  });
});

describe('release installs', () => {
  // Installs skip devDependencies, so whatever the server (and the smoke test) imports must be a dependency.
  it('every package the server imports is a runtime dependency', () => {
    const deps = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies);
    const files = [...readdirSync('src/server', { recursive: true }).map((f) => join('src/server', String(f))).filter((f) => f.endsWith('.ts')), 'ops/smoke.ts'];
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/^(?:import|export|\})[^\n'"]*?\bfrom\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        used.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
    expect(used.size).toBeGreaterThan(3);
    expect([...used].filter((p) => !deps.includes(p))).toEqual([]);
    expect(deps).toContain('tsx'); // the server runs through tsx
  });
});

describe('release packing', () => {
  it.skipIf(!existsSync('dist/web/index.html'))('packs the app, installers and formula with the repo filled in', () => {
    const out = mkdtempSync(join(tmpdir(), 'wf-pack-'));
    execFileSync('bash', ['packaging/pack.sh', 'example-owner/wayfinder', out], { stdio: 'pipe' });
    const tgz = join(out, `wayfinder-${version}.tgz`);
    const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n');
    expect(files).toContain(`wayfinder-${version}/src/server/main.ts`);
    expect(files).toContain(`wayfinder-${version}/src/server/instanceTools.ts`);
    expect(files).toContain(`wayfinder-${version}/src/server/instanceReads.ts`);
    expect(files).not.toContain(`wayfinder-${version}/src/server/nowaikitReads.ts`);
    expect(files).toContain(`wayfinder-${version}/dist/web/index.html`);
    expect(files).toContain(`wayfinder-${version}/ops/smoke.ts`);
    expect(files).toContain(`wayfinder-${version}/package-lock.json`);
    expect(files.some((f) => f.includes('node_modules') || f.includes('/tests/') || f.includes('.github'))).toBe(false);
    const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain(`${sha(readFileSync(tgz))}  wayfinder-${version}.tgz`);
    for (const f of ['install.sh', 'install.ps1']) {
      const body = readFileSync(join(out, f), 'utf8');
      expect(body).toContain('example-owner/wayfinder');
      expect(body).not.toContain('CapitalX/wayfinder-app');
      expect(sums).toContain(`${sha(body)}  ${f}`);
    }
    const formula = readFileSync(join(out, 'homebrew', 'wayfinder.rb'), 'utf8');
    expect(formula).toContain(`url "https://github.com/example-owner/wayfinder/releases/download/v${version}/wayfinder-${version}.tgz"`);
    expect(formula).toContain(`sha256 "${sha(readFileSync(tgz))}"`);
    expect(formula).not.toMatch(/@[A-Z0-9_]+@/);
    const cli = execFileSync('tar', ['-xzOf', tgz, `wayfinder-${version}/packaging/wayfinder`], { encoding: 'utf8' });
    expect(cli).toContain('WAYFINDER_REPO:-example-owner/wayfinder}');
  });
});

describe('release workflow', () => {
  const wf = readFileSync('.github/workflows/release.yml', 'utf8');
  it('parses as YAML without duplicate mapping keys', () => {
    const parsed = spawnSync(process.execPath, ['node_modules/js-yaml/bin/js-yaml.js'], { input: wf, encoding: 'utf8' });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
  });
  it('runs only in the public repo, on hosted Linux', () => {
    expect(wf).toContain("if: ${{ !github.event.repository.private && (github.ref_type == 'tag' || startsWith(github.event.head_commit.message, 'release ')) }}");
    expect(wf).toContain('runs-on: ubuntu-latest');
    expect(wf).not.toMatch(/macos|windows/i);
  });
  it('releases the release step\'s merge on main or a tag, never interpolating either into a script', () => {
    expect(wf).toMatch(/push:\n\s+branches: \[main\]\n\s+tags:/);
    expect(wf).toContain('echo "TAG=v$v" >> "$GITHUB_ENV"');
    expect(wf).toContain('gh release create "$TAG" --target "$GITHUB_SHA"');
    expect(wf).toContain('already released');
    for (const run of wf.split(/\n\s*run: [|]?/).slice(1)) expect(run.split(/\n\s{6}- /)[0]).not.toMatch(/\$\{\{\s*github\./);
  });
  it('only releases a commit that is on main, before anything is built or published', () => {
    expect(wf).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(wf.indexOf('--is-ancestor')).toBeLessThan(wf.indexOf('npm ci'));
  });
  it('builds from a clean install (no npm cache) and keeps the tap token out of URLs and arguments', () => {
    expect(wf).not.toMatch(/cache:\s*npm/);
    expect(wf).not.toMatch(/https:\/\/[^"\s]*\$\{?TAP_TOKEN/);
    expect(wf).toContain('echo "password=$TAP_TOKEN"');
  });
  it('pins its actions and keeps the tap token out of the logs', () => {
    for (const m of wf.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    // only the credential helper may print it, and that goes to git through a pipe, not to the log
    expect(wf.split('\n').filter((l) => /echo [^\n]*\$\{?TAP_TOKEN/.test(l) && !l.includes('credential.helper='))).toEqual([]);
  });
});

describe('install review fixes', () => {
  it('install.sh only runs once it has fully arrived: everything is in main(), called on the last line', () => {
    const src = readFileSync('packaging/install.sh', 'utf8');
    expect(src.trimEnd().split('\n').pop()).toBe('main "$@"');
    // Cut off anywhere inside main, it runs nothing: sh reads the unfinished function and stops with a syntax error.
    const start = src.indexOf('\nmain() {');
    const home = mkdtempSync(join(tmpdir(), 'wf-cut-'));
    for (const frac of [0.3, 0.6, 0.95]) {
      const cut = join(home, `cut-${frac}.sh`);
      writeFileSync(cut, src.slice(0, start + Math.floor((src.length - start) * frac)));
      const r = spawnSync('sh', [cut, '--yes'], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(readdirSync(home).every((f) => f.startsWith('cut-'))).toBe(true);
  });

  it('wayfinder update judges a release with the short smoke profile', () => {
    expect(readFileSync(CLI, 'utf8')).toMatch(/smoke\(\) \{[^\n]*WAYFINDER_SMOKE=update[^\n]*ops\/smoke\.ts/);
  });

  it('the short profile checks health, version and the board only (no instance, speed record or feature search)', async () => {
    const { createServer } = await import('node:http');
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/about' ? { version } : { id: 'x1' }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const run = await new Promise<{ code: number | null; out: string }>((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const c = spawn(process.execPath, ['--import', 'tsx', 'ops/smoke.ts'], { env: { PATH: process.env.PATH, WAYFINDER_URL: `http://127.0.0.1:${port}`, WAYFINDER_TOKEN: 'test', WAYFINDER_SMOKE: 'update' } });
        let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
        c.on('exit', (code) => resolve({ code, out }));
      });
    });
    srv.close();
    expect(run.out).toContain('all checks passed');
    expect(run.code).toBe(0);
    const paths = seen.map((s) => s.split(' ')[1].split('?')[0]);
    expect(paths).toEqual(expect.arrayContaining(['/api/session', '/api/about', '/api/board']));
    for (const p of ['/api/status', '/api/events', '/api/features', '/api/perf', '/api/memories']) expect(paths).not.toContain(p);
  }, 30_000);

  it('the systemd units quote their paths, and the daily update uses WAYFINDER_BIN_DIR', () => {
    const src = readFileSync(CLI, 'utf8');
    expect(src).toContain('BIN_DIR="${WAYFINDER_BIN_DIR:-$HOME/.local/bin}"');
    expect(src).toContain('ExecStart=$(unit_quote "$BIN_DIR/wayfinder") update');
    expect(src).not.toContain('$HOME/.local/bin/wayfinder update');
    const fns = src.split('\n').filter((l) => /^unit_(quote|path)\(\)/.test(l)).join('\n');
    const q = (fn: string, v: string) => execFileSync('bash', ['-c', `${fns}\n${fn} "$1"`, '_', v], { encoding: 'utf8' });
    expect(q('unit_quote', '/home/a b/node')).toBe('"/home/a b/node"');
    expect(q('unit_quote', 'say "hi" \\ 100%')).toBe('"say \\"hi\\" \\\\ 100%%"');
    expect(q('unit_path', '/home/50%/wf')).toBe('/home/50%%/wf');
  });

  it('install.ps1 takes an optional -Version, checks it, and hands it to install.sh', () => {
    const src = readFileSync('packaging/install.ps1', 'utf8');
    expect(src).toMatch(/^param\(\[string\]\$Version = \$env:WAYFINDER_VERSION\)$/m);
    expect(src).toContain("$Version -notmatch '^\\d+\\.\\d+\\.\\d+$'");
    expect(src).toContain('sh -s -- $Base $Version');
    expect(src).toContain('sh "$t/install.sh" --version "$2"');
    expect(src.trimEnd().endsWith('} $Version')).toBe(true);
  });
});

describe('CI workflows', () => {
  it('pass GitHub context to scripts through env, never interpolated into run', () => {
    for (const f of readdirSync('.github/workflows')) {
      for (const line of readFileSync(`.github/workflows/${f}`, 'utf8').split('\n').filter((l) => /^\s*(- )?run: /.test(l))) expect(line, f).not.toMatch(/\$\{\{/);
    }
  });
});
