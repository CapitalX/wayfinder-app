// Compiles every example in the Fluent cheat sheet as one app with the installed ServiceNow SDK, and checks the
// sheet says which SDK it was verified on. Run in CI and after any SDK upgrade: npm run check:fluent
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBuild } from '../src/server/fluent.ts';
import { readSheet, sameMinor, scaffold, sdkVersion, sheetFiles, sheetVersion } from '../src/server/fluentCheck.ts';

const sheet = readSheet();
const files = sheetFiles(sheet);
const installed = sdkVersion();
const dir = scaffold(join(tmpdir(), 'wayfinder'), join(process.cwd(), 'node_modules'), files);
const res = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'now-sdk'), ['build'], { cwd: dir, encoding: 'utf8' });
const out = `${res.stdout}${res.stderr}`;
const { errors } = parseBuild(out);
const ok = res.status === 0 && /Build completed successfully/i.test(out);
console.log(`${files.length} example files, SDK ${installed} (sheet says ${sheetVersion(sheet) ?? 'nothing'})`);
for (const e of errors) console.log(`  ${e.file}:${e.line ?? ''} ${e.code ?? ''} ${e.message}`);
rmSync(dir, { recursive: true, force: true });
if (!ok) { console.error('FAIL: the cheat sheet examples no longer build. Fix the sheet (and re-verify) before shipping.'); process.exit(1); }
if (!sameMinor(sheetVersion(sheet), installed)) { console.error(`FAIL: the examples build, but update the sheet's header to SDK ${installed} so it says what it was verified on.`); process.exit(1); }
console.log('PASS: every cheat sheet example builds.');
