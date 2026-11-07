import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { instances } from '../src/server/db.ts';
import { sdkSettings } from '../src/server/sdkSettings.ts';
import { checkSdkUpdate, sdkDecision, startSdkInstall } from '../src/server/sdkUpdates.ts';

vi.mock('../src/server/sdkUpdates.ts', () => ({
  sdkState: (admin: boolean) => ({ admin, version: '4.14.0' }),
  checkSdkUpdate: vi.fn(), sdkDecision: vi.fn(),
  startSdkInstall: vi.fn(() => ({ done: Promise.resolve({ version: '4.15.0', state: 'done', errors: [] }) })),
}));
const app = new Hono().route('/api/sdk', sdkSettings);
const request = (action: string, version = '4.15.0') => app.request('/api/sdk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, version }) });
let id: string;
beforeEach(() => {
  for (const inst of instances.list()) instances.markRemoved(inst.id);
  const inst = instances.create({ name: 'Test instance', url: 'https://dev12345.service-now.com', client_id: '', login_user: '', kind: 'pdi', auth: 'client_credentials', auth_user: null });
  id = inst.id; instances.activate(id); vi.clearAllMocks();
});
describe('SDK admin routes (under the existing app-token, same-origin JSON middleware)', () => {
  it.each([false, null, undefined])('denies every action when admin is %s', async (admin) => {
    instances.update(id, { profile: JSON.stringify({ admin }) });
    for (const action of ['check', 'install', 'keep', 'use', 'back']) expect((await request(action)).status).toBe(403);
    expect(checkSdkUpdate).not.toHaveBeenCalled();
    expect(startSdkInstall).not.toHaveBeenCalled(); expect(sdkDecision).not.toHaveBeenCalled();
    expect(await (await app.request('/api/sdk')).json()).toMatchObject({ admin: false, version: '4.14.0' });
  });
  it('denies unknown, absent or inactive instance access', async () => {
    expect((await request('install')).status).toBe(403);
    instances.update(id, { profile: JSON.stringify({ admin: true }) });
    const other = instances.create({ name: 'Other', url: 'https://dev12346.service-now.com', client_id: '', login_user: '', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    instances.activate(other.id);
    expect((await request('use')).status).toBe(403);
    instances.markRemoved(id); expect((await request('back')).status).toBe(403);
  });
  it('permits a confirmed admin, validates the action, and returns progress immediately', async () => {
    instances.update(id, { profile: JSON.stringify({ admin: true }) });
    expect((await request('check')).status).toBe(200); expect(checkSdkUpdate).toHaveBeenCalledOnce();
    expect((await request('install')).status).toBe(200); expect(startSdkInstall).toHaveBeenCalledWith('4.15.0', expect.any(Function));
    expect((await request('use')).status).toBe(200); expect(sdkDecision).toHaveBeenCalledWith('use', '4.15.0', expect.any(Function));
    expect((await request('invalid')).status).toBe(400);
    expect((await app.request('/api/sdk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    vi.mocked(startSdkInstall).mockImplementationOnce(() => { throw new Error('An SDK update is already running.'); });
    expect((await request('install')).status).toBe(409);
  });
});
