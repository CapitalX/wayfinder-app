import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Doctor and the standalone sheet check can read the choice without initializing the app's data or secrets.
export const SDK_DIR = join(process.env.WAYFINDER_DATA_DIR ?? process.env.SNW_DATA_DIR ?? join(homedir(), 'wayfinder-data'), 'sdk');
export const BUNDLED_SDK = join(process.cwd(), 'node_modules');
export const sdkVersionAt = (path: string): string => {
  try { return JSON.parse(readFileSync(join(path, '@servicenow/sdk/package.json'), 'utf8')).version; } catch { return 'unknown'; }
};
export const validVersion = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export const compareVersions = (a: string, b: string) => {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
};
export interface SdkChoice { version: string; path: string }
interface Selection extends SdkChoice { previous?: SdkChoice }
export const installedRoot = (version: string) => join(SDK_DIR, version, 'node_modules');
export const bundledSdk = (): SdkChoice => ({ version: sdkVersionAt(BUNDLED_SDK), path: BUNDLED_SDK });
export function completeSdk(choice: SdkChoice): boolean {
  try {
    return validVersion(choice.version) && choice.path === installedRoot(choice.version)
      && !lstatSync(join(SDK_DIR, choice.version)).isSymbolicLink()
      && !lstatSync(choice.path).isSymbolicLink()
      && sdkVersionAt(choice.path) === choice.version
      && JSON.parse(readFileSync(join(choice.path, '@servicenow/sdk-api/package.json'), 'utf8')).version === choice.version
      && existsSync(join(choice.path, '@servicenow/sdk/bin/index.js'))
      && existsSync(join(choice.path, '.bin/now-sdk'));
  } catch { return false; }
}
function selection(): Selection | null {
  try { return JSON.parse(readFileSync(join(SDK_DIR, 'active.json'), 'utf8')); } catch { return null; }
}

// A single choice for the CLI, module resolution, sheet checks and doctor. Reading never removes a running SDK.
export function sdkRoot(): SdkChoice & { source: 'bundled' | 'updated in app'; previous?: SdkChoice; warning?: string } {
  const bundled = bundledSdk(), saved = selection();
  if (!saved) return { ...bundled, source: 'bundled', ...(existsSync(join(SDK_DIR, 'active.json')) ? { warning: 'Saved SDK choice is unreadable; using the bundled SDK.' } : {}) };
  if (validVersion(saved.version) && compareVersions(bundled.version, saved.version) >= 0) return { ...bundled, source: 'bundled' };
  if (!validVersion(saved.version) || !completeSdk(saved)) return { ...bundled, source: 'bundled', warning: 'Updated SDK is missing or incomplete; using the bundled SDK.' };
  const previous = saved.previous;
  return { version: saved.version, path: saved.path, source: 'updated in app',
    ...(previous && ((previous.path === bundled.path && previous.version === bundled.version) || completeSdk(previous)) ? { previous } : {}) };
}
export const SDK_BIN = (root = sdkRoot().path) => root === BUNDLED_SDK && process.env.NOW_SDK_BIN ? process.env.NOW_SDK_BIN : join(root, '.bin/now-sdk');

let users = 0;
const idle: (() => void)[] = [];
export function holdSdk(): () => void {
  users++;
  let released = false;
  return () => { if (released) return; released = true; if (--users === 0) idle.splice(0).forEach((f) => f()); };
}
export function sdkWhenIdle<T>(action: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => { try { resolve(action()); } catch (e) { reject(e); } };
    if (users) idle.push(run); else run();
  });
}
function pruneSdk(keep: string[]) {
  if (!existsSync(SDK_DIR)) return;
  for (const name of readdirSync(SDK_DIR)) if (validVersion(name) && !keep.includes(name)) rmSync(join(SDK_DIR, name), { recursive: true, force: true });
}
export function activateSdk(choice: SdkChoice) {
  if (users) throw new Error('Wait for running SDK commands to finish.');
  const current = sdkRoot();
  if (choice.path !== BUNDLED_SDK && !completeSdk(choice)) throw new Error('That SDK is incomplete. Download it again.');
  mkdirSync(SDK_DIR, { recursive: true });
  const next: Selection = { ...choice, previous: { version: current.version, path: current.path } };
  writeFileSync(join(SDK_DIR, 'active.json.tmp'), JSON.stringify(next));
  renameSync(join(SDK_DIR, 'active.json.tmp'), join(SDK_DIR, 'active.json'));
  pruneSdk([choice.version, current.version]);
}
// Called before accepting builds after a Wayfinder upgrade. Bundled SDKs take over once they catch up.
export function reconcileSdk() {
  const saved = selection(), bundled = bundledSdk();
  if (saved && validVersion(saved.version) && compareVersions(bundled.version, saved.version) >= 0) {
    rmSync(join(SDK_DIR, 'active.json'), { force: true });
    pruneSdk([]);
  } else if (!existsSync(join(SDK_DIR, '.install.lock'))) {
    const current = sdkRoot();
    pruneSdk([current.version, current.previous?.version ?? '']);
  }
}
