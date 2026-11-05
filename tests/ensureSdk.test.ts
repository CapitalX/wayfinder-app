import { mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Auto-deploy runs each version from its own folder and removes old ones, so the apps' node_modules link must follow
// the build that's running, not stay on the folder it was first made for.
describe('the apps folder SDK link', () => {
  it('is made, and moved to the running build when it points at another (or a removed) one', async () => {
    const { APPS_DIR } = await import('../src/server/config.ts');
    const { ensureSdk } = await import('../src/server/buildTools.ts');
    const link = join(APPS_DIR, 'node_modules'), want = join(process.cwd(), 'node_modules');
    ensureSdk();
    expect(readlinkSync(link)).toBe(want);
    rmSync(link); mkdirSync(APPS_DIR, { recursive: true });
    symlinkSync('/nonexistent/wayfinder-builds/0123456789ab/node_modules', link, 'dir');
    ensureSdk();
    expect(readlinkSync(link)).toBe(want);
  });
});
