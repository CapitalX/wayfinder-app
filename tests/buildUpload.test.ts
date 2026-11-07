import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnGroup } = vi.hoisted(() => ({ spawnGroup: vi.fn(() => { throw new Error('Install must not spawn a child'); }) }));
vi.mock('../src/server/sandbox.ts', async (original) => ({ ...await original<typeof import('../src/server/sandbox.ts')>(), spawnGroup }));
vi.mock('../src/server/followup.ts', () => ({ afterInstall: vi.fn() }));
const { approvedBuild, readBuildFile, recordBuild, discardBuild } = await import('../src/server/buildUpload.ts');
const { startInstall, cancelInstall } = await import('../src/server/buildTools.ts');
const { APPS_DIR, DATA_DIR } = await import('../src/server/config.ts');
const { apps, chats, instances, jobs } = await import('../src/server/db.ts');
const { secrets } = await import('../src/server/secrets.ts');

const commit = 'a'.repeat(40);
const scopeId = 'b'.repeat(32);
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'wf-upload-')));
function setup(auth: 'basic' | 'client_credentials' = 'basic') {
  const inst = instances.create({ name: 'dev', url: 'https://dev12345.service-now.com', client_id: 'client', login_user: 'admin', kind: 'pdi', auth, auth_user: 'admin' });
  secrets.setPassword(inst.id, 'test-only-password'); secrets.setClientSecret(inst.id, 'test-only-secret');
  const chat = chats.create('build', inst.id, null);
  const app = apps.add({ project_id: null, chat_id: chat.id, instance_id: inst.id, name: 'Loans', scope: 'x_acme_' + inst.id.slice(0, 6), scope_id: scopeId, spec: JSON.stringify({ tables: [], tests: [] }) });
  apps.update(app.id, { status: 'built' });
  const output = temp();
  writeFileSync(join(output, 'wayfinder.zip'), 'built-package');
  writeFileSync(join(output, 'wayfinder.json'), JSON.stringify({ scope: app.scope, scopeId, version: '1.0.0', store: false, flows: [scopeId], actions: [] }));
  recordBuild(app, output, commit);
  const dir = join(realpathSync(DATA_DIR), 'build-output', app.id);
  return { inst, chat, app, output, dir };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function instanceFetch(options: { hang?: string; status?: string; synchronous?: boolean; emptySessionToken?: boolean; mfa?: boolean } = {}) {
  let uploads = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (options.hang && url.includes(options.hang)) return new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
    if (url.includes('sysparm_type=view_form.login')) return new Response(JSON.stringify({ status: options.mfa ? 'mfa_code_required' : 'success' }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'JSESSIONID=test-session; Secure; HttpOnly' } });
    if (url.includes('sysparm_type=get_user')) return new Response('', { status: 401, headers: { ...(options.emptySessionToken ? {} : { 'x-usertoken-response': 'test-user-token' }) } });
    if (url.includes('oauth_token.do')) return json({ access_token: 'test-only-token', expires_in: 1800 });
    if (url.includes('sys_upgrade_history')) return json({ result: uploads ? [{ sys_id: 'new', upgrade_finished: 'now' }] : [] });
    if (url.includes('sys_scope')) return json({ result: [] });
    if (url.includes('current_user')) return json({ result: { user_name: 'admin' } });
    if (url.includes('sys_user_session')) return json({ result: [{ csrf_token: 'test-csrf' }] });
    if (url.includes('sn_appclient_upload_processor')) { uploads++; return json(options.synchronous ? {} : { executionTracker: 'tracker', rollbackContext: 'rollback' }); }
    if (url.includes('/api/sn_cicd/progress/')) return json({ result: { status: options.status ?? '2', percent_complete: 100, status_message: 'Install result' } });
    if (url.includes('activate_flows')) return json({ result: {} });
    throw new Error('Unexpected request: ' + url);
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); spawnGroup.mockClear(); });

describe('build output boundary', () => {
  it('accepts ordinary package bytes and refuses absolute paths and traversal', () => {
    const { output } = setup();
    expect(readBuildFile(output, 'wayfinder.zip').toString()).toBe('built-package');
    expect(() => readBuildFile(output, '../outside.zip')).toThrow(/outside the build output/);
    expect(() => readBuildFile(output, join(output, 'wayfinder.zip'))).toThrow(/outside the build output/);
  });
  it('refuses links in the output, including linked directories and the root', () => {
    const { output } = setup();
    symlinkSync(join(output, 'wayfinder.zip'), join(output, 'link.zip'));
    symlinkSync(temp(), join(output, 'linked'));
    const rootLink = join(temp(), 'output'); symlinkSync(output, rootLink);
    for (const path of ['link.zip', 'linked/file.zip']) expect(() => readBuildFile(output, path)).toThrow(/symlink/);
    expect(() => readBuildFile(rootLink, 'wayfinder.zip')).toThrow(/symlink/);
  });
  it('refuses a stale commit, a changed package, and a changed recorded hash', () => {
    const { app, dir } = setup();
    expect(() => approvedBuild(app, 'c'.repeat(40))).toThrow(/approved commit or hash/);
    writeFileSync(join(dir, 'package.zip'), 'changed');
    expect(() => approvedBuild(app, commit)).toThrow(/approved commit or hash/);
    writeFileSync(join(dir, 'package.zip'), 'built-package');
    const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ ...receipt, hash: 'wrong' }));
    expect(() => approvedBuild(app, commit)).toThrow(/approved commit or hash/);
  });
  it('refuses an install without a successful recorded build or after invalidation', async () => {
    const { app, inst, chat } = setup();
    discardBuild(app);
    await expect(startInstall(inst, app, chat.id, commit)).rejects.toThrow();
    expect(spawnGroup).not.toHaveBeenCalled();
  });
});

describe('trusted install', () => {
  it.each(['commit', 'hash', 'symlink'])('refuses a changed %s before any network or child process', async change => {
    const { inst, app, chat, dir, output } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch');
    if (change === 'commit') {
      const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
      writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ ...receipt, commit: 'c'.repeat(40) }));
    } else if (change === 'hash') writeFileSync(join(dir, 'package.zip'), 'changed');
    else {
      rmSync(join(dir, 'package.zip'));
      symlinkSync(join(output, 'wayfinder.zip'), join(dir, 'package.zip'));
    }
    await expect(startInstall(inst, app, chat.id, commit)).rejects.toThrow(/approved commit or hash|symlink/);
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnGroup).not.toHaveBeenCalled();
  });
  it.each(['basic', 'client_credentials'] as const)('uploads only the approved snapshot with %s, without any child process', async auth => {
    const { inst, app, chat, output } = setup(auth);
    const fetch = instanceFetch();
    // Generated output can change or disappear after the snapshot; uploads never revisit the app folder.
    rmSync(output, { recursive: true });
    mkdirSync(join(APPS_DIR, app.scope), { recursive: true });
    writeFileSync(join(APPS_DIR, app.scope, 'now.config.js'), 'throw new Error("must never execute");');
    const release = vi.fn();
    const job = await startInstall(inst, app, chat.id, commit, release);
    await vi.waitFor(() => expect(jobs.get(job.id)).toMatchObject({ status: 'successful' }));
    expect(apps.get(app.id)?.installed_commit).toBe(commit);
    expect(spawnGroup).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    const upload = fetch.mock.calls.find(([url]) => String(url).includes('sn_appclient_upload_processor'))!;
    const form = upload[1]!.body as FormData;
    expect(await (form.get('attachFile') as Blob).text()).toBe('built-package');
    expect(form.get('sysparm_ck')).toBe(auth === 'basic' ? 'test-user-token' : 'test-csrf');
    expect(upload[1]!.headers).toMatchObject(auth === 'basic' ? { 'X-UserToken': 'test-user-token', Cookie: 'JSESSIONID=test-session' } : { Authorization: 'Bearer test-only-token' });
    if (auth === 'basic') {
      const login = fetch.mock.calls.find(([url]) => String(url).includes('view_form.login'))!;
      expect((login[1]!.body as URLSearchParams).get('user_password')).toBe('test-only-password');
      expect(JSON.stringify(upload[1]!.headers)).not.toContain('test-only-password');
    }
    expect(fetch.mock.calls.some(([url]) => String(url).includes('activate_flows'))).toBe(true);
  });
  it('uses the session CSRF lookup when the password handshake returns no user token', async () => {
    const { inst, app, chat } = setup(); const fetch = instanceFetch({ emptySessionToken: true });
    const job = await startInstall(inst, app, chat.id, commit);
    await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe('successful'));
    const upload = fetch.mock.calls.find(([url]) => String(url).includes('sn_appclient_upload_processor'))!;
    expect((upload[1]!.body as FormData).get('sysparm_ck')).toBe('test-csrf');
    expect(upload[1]!.headers).toMatchObject({ Cookie: 'JSESSIONID=test-session' });
  });
  it('refuses MFA without opening a terminal or uploading anything', async () => {
    const { inst, app, chat } = setup(); const fetch = instanceFetch({ mfa: true });
    const job = await startInstall(inst, app, chat.id, commit);
    await vi.waitFor(() => expect(jobs.get(job.id)).toMatchObject({ status: 'failed', message: expect.stringContaining('MFA') }));
    expect(fetch.mock.calls.some(([url]) => String(url).includes('sn_appclient_upload_processor'))).toBe(false);
    expect(spawnGroup).not.toHaveBeenCalled();
  });
  it('handles synchronous instances and tracker failures', async () => {
    const { inst, app, chat } = setup(); instanceFetch({ synchronous: true });
    const job = await startInstall(inst, app, chat.id, commit);
    await vi.waitFor(() => expect(jobs.get(job.id)).toMatchObject({ status: 'successful' }));
    vi.restoreAllMocks();
    const failed = setup(); instanceFetch({ status: '3' });
    const failure = await startInstall(failed.inst, failed.app, failed.chat.id, commit);
    await vi.waitFor(() => expect(jobs.get(failure.id)?.status).toBe('failed'));
    expect(apps.get(failed.app.id)?.installed_commit).toBeNull();
  });
  it.each(['sn_appclient_upload_processor', '/api/sn_cicd/progress/'])('cancels an in-flight %s request and releases the app', async hang => {
    const { inst, app, chat } = setup(); const fetch = instanceFetch({ hang }); const release = vi.fn();
    const job = await startInstall(inst, app, chat.id, commit, release);
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes(hang))).toBe(true));
    expect(cancelInstall(job.id)).toBe(true);
    await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe('cancelled'));
    expect(release).toHaveBeenCalledOnce();
    expect(cancelInstall(job.id)).toBe(false);
    expect(apps.get(app.id)?.status).toBe('install_failed');
  });
  it('stops an upload at the 15-minute deadline', async () => {
    const { inst, app, chat } = setup();
    instanceFetch({ hang: 'sn_appclient_upload_processor' });
    vi.useFakeTimers();
    const release = vi.fn();
    const job = await startInstall(inst, app, chat.id, commit, release);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(jobs.get(job.id)).toMatchObject({ status: 'failed', message: expect.stringContaining('15 minutes') });
    expect(release).toHaveBeenCalledOnce();
    expect(apps.get(app.id)?.status).toBe('install_failed');
  });
});
