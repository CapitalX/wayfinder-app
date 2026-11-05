import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, chats, conventions, instances, jobs, type Instance } from '../src/server/db.ts';
import { mergeDuplicates, reconnect, removeInstance } from '../src/server/instanceRows.ts';
import { secrets } from '../src/server/secrets.ts';
import { testSignIn } from '../src/server/sn.ts';
import { bus } from '../src/server/events.ts';

// One row per instance address: reconnecting updates the instance, retired ones can be removed, and leftovers from
// a first connect attempt are tidied on start.
const URL_A = 'https://dev12345.service-now.com', URL_B = 'https://dev67890.service-now.com';
const add = (url: string, client = 'client-1', name = url.slice(8, 16)) => {
  const i = instances.create({ name, url, client_id: client, login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
  secrets.setClientSecret(i.id, `${client}-secret`);
  return i;
};
const quiet = () => {};
const lastAudit = () => audit.recent()[0] as { instance_id: string; decision: string };

// A fresh active instance retires the rest; marking those removed leaves each test a clean address book.
beforeEach(() => {
  const fresh = add('https://dev00000.service-now.com', 'reset');
  for (const i of instances.list()) if (i.id !== fresh.id) instances.markRemoved(i.id);
});

describe('connecting an address that is already here', () => {
  it('finds it by address, active first, never a removed one', () => {
    const old = add(URL_A, 'old');
    add(URL_B);
    expect(instances.byUrl(URL_A).map((i) => i.id)).toEqual([old.id]);
    instances.markRemoved(old.id);
    expect(instances.byUrl(URL_A)).toEqual([]);
  });

  it('updates that instance with the new sign-in instead of adding a second one', () => {
    const old = add(URL_A, 'old-client');
    const chat = chats.create('explore', old.id, null);
    instances.update(old.id, { profile: JSON.stringify({ user: 'someone' }) });
    add(URL_B); // old is now retired
    const before = instances.list().length;
    const r = reconnect(instances.get(old.id)!, { client_id: 'new-client', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    secrets.setClientSecret(r.id, 'new-secret');
    expect(r.id).toBe(old.id);
    expect(instances.list().length).toBe(before);
    expect(r.client_id).toBe('new-client');
    expect(r.status).toBe('active');
    expect(r.profile).toBeNull(); // access is checked again for the new sign-in
    expect(secrets.clientSecret(r.id)).toBe('new-secret');
    expect(instances.active()?.id).toBe(old.id);
    expect(chats.get(chat.id)?.instance_id).toBe(old.id); // its chats stay with it
    expect(lastAudit().decision).toContain('reconnected the same address');
  });

  it('drops the old sign-in even when the new one has no secret yet (sign in as me)', () => {
    const old = add(URL_A, 'old-client');
    secrets.setPassword(old.id, 'pw');
    const r = reconnect(old, { client_id: 'oauth-client', login_user: 'admin', kind: 'pdi', auth: 'oauth_user', auth_user: null });
    expect(secrets.clientSecret(r.id)).toBeUndefined();
    expect(secrets.password(r.id)).toBeUndefined();
    expect(r.auth).toBe('oauth_user');
  });

  it('switching from username and password clears the stored user name', () => {
    const old = instances.create({ name: 'x', url: URL_A, client_id: '', login_user: 'me', kind: 'pdi', auth: 'basic', auth_user: 'me' });
    const r = reconnect(old, { client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    expect(r.auth_user).toBeNull();
  });
});

describe('removing a retired instance', () => {
  let retired: Instance, active: Instance, chatId: string;
  beforeEach(() => {
    retired = add(URL_A, 'old');
    chatId = chats.create('explore', retired.id, null).id;
    chats.update(chatId, { auto_mode: 'auto' as never, auto_until: Date.now() + 60_000 });
    conventions.propose(retired.id, []);
    active = add(URL_B);
  });

  it('never removes the instance in use', () => {
    const r = removeInstance(active.id, false);
    expect(r).toEqual({ ok: false, error: "The instance in use can't be removed. Make another one active first." });
    expect(instances.get(active.id)?.status).toBe('active');
    expect(secrets.clientSecret(active.id)).toBe('client-1-secret');
  });

  it('deletes its sign-in, keeps its chats readable and labelled, and audits it', () => {
    const r = removeInstance(retired.id, false);
    expect(r).toEqual({ ok: true, chats: 'kept', count: 1 });
    const row = instances.get(retired.id)!;
    expect(row.status).toBe('removed');
    expect(row.url).toBe(URL_A); // the label its chats show
    expect(row.client_id).toBe('');
    expect(secrets.clientSecret(retired.id)).toBeUndefined();
    expect(conventions.get(retired.id)).toBeUndefined();
    expect(chats.get(chatId)?.instance_id).toBe(retired.id);
    expect(chats.get(chatId)?.auto_mode).toBe('ask');
    expect(lastAudit()).toMatchObject({ instance_id: retired.id, decision: expect.stringContaining('1 chat(s) kept, read-only') });
  });

  it('deletes its chats only when asked', () => {
    expect(removeInstance(retired.id, true)).toEqual({ ok: true, chats: 'deleted', count: 1 });
    expect(chats.get(chatId)).toBeUndefined();
    expect(lastAudit().decision).toContain('1 chat(s) deleted');
  });

  it('a removed instance is gone for good: not removable twice, and its address can be connected fresh', () => {
    removeInstance(retired.id, false);
    expect(removeInstance(retired.id, false)).toEqual({ ok: false, error: 'That instance is already gone.' });
    expect(instances.byUrl(URL_A)).toEqual([]);
  });
});

describe('tidying duplicates on start', () => {
  it('deletes retired copies of the active address that nothing refers to, with their sign-in', () => {
    const first = add(URL_A, 'first-attempt');
    const used = add(URL_A, 'used-once');
    chats.create('explore', used.id, null);
    const withJob = add(URL_A, 'with-job');
    jobs.add({ instance_id: withJob.id, chat_id: null, kind: 'plugin', target: 'x', progress_id: 'p' });
    const other = add(URL_B, 'other-address');
    const live = add(URL_A, 'current');
    expect(mergeDuplicates(quiet)).toBe(1);
    expect(instances.get(first.id)).toBeUndefined();
    expect(secrets.clientSecret(first.id)).toBeUndefined();
    expect(instances.get(used.id)?.status).toBe('retired'); // has a chat: the user decides
    expect(instances.get(withJob.id)?.status).toBe('retired'); // has history
    expect(instances.get(other.id)?.status).toBe('retired'); // a different address
    expect(instances.active()?.id).toBe(live.id);
    expect(lastAudit()).toMatchObject({ instance_id: live.id, decision: expect.stringContaining('tidied 1 unused duplicate') });
    expect(mergeDuplicates(quiet)).toBe(0); // nothing left to do
  });
});

describe('removing while something is installing', () => {
  it('waits until the install finishes', () => {
    const old = add(URL_A, 'old');
    add(URL_B, 'new');
    const job = jobs.add({ instance_id: old.id, chat_id: null, kind: 'plugin', target: 'com.example', progress_id: 'p1' });
    expect(removeInstance(old.id, false)).toMatchObject({ ok: false, error: expect.stringMatching(/still running/) });
    jobs.update(job.id, { status: 'successful', finished_at: Date.now() });
    expect(removeInstance(old.id, false)).toMatchObject({ ok: true });
  });
});

describe('a new sign-in is checked before it is saved', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, body = '{}', type = 'application/json') => vi.stubGlobal('fetch', vi.fn(async (u: string) =>
    String(u).endsWith('/oauth_token.do') ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 }) : new Response(body, { status, headers: { 'Content-Type': type } })));
  it('passes when the instance answers, even with a 403 (the sign-in works, the account just can\'t read that)', async () => {
    answer(200, '{"result":[]}'); await expect(testSignIn(URL_A, { auth: 'basic', username: 'a', password: 'b' })).resolves.toBeUndefined();
    answer(403); await expect(testSignIn(URL_A, { auth: 'client_credentials', client_id: 'c', client_secret: 's' })).resolves.toBeUndefined();
  });
  it('fails on a refusal or a sleeping PDI, and never saves anything', async () => {
    const before = JSON.stringify(instances.list());
    answer(401); await expect(testSignIn(URL_A, { auth: 'basic', username: 'a', password: 'b' })).rejects.toMatchObject({ kind: 'auth' });
    answer(200, '<html>Your instance is hibernating. developer.servicenow.com</html>', 'text/html'); await expect(testSignIn(URL_A, { auth: 'basic', username: 'a', password: 'b' })).rejects.toMatchObject({ kind: 'hibernating' });
    expect(JSON.stringify(instances.list())).toBe(before);
  });
  it('refuses http before sending anything', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    await expect(testSignIn('http://dev12345.service-now.com', { auth: 'basic', username: 'a', password: 'b' })).rejects.toThrow(/https/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('full permissions storage', () => {
  it('announces permission changes without refreshing instance readers during reconnect or access checks', () => {
    const inst = add(URL_A);
    const changed = vi.fn();
    bus.on('change', changed);
    try {
      reconnect(inst, { client_id: 'new-client', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
      instances.update(inst.id, { profile: JSON.stringify({ userId: 'new-user' }) });
      instances.update(inst.id, {});
      expect(changed).not.toHaveBeenCalled();
      instances.update(inst.id, { full_permissions: 1 });
      expect(changed).toHaveBeenCalledExactlyOnceWith({ topic: 'instance', instance_id: inst.id });
      changed.mockClear();
      instances.update(inst.id, { full_permissions: 1 });
      expect(changed).not.toHaveBeenCalled();
      instances.update(inst.id, { full_permissions: 0 });
      expect(changed).toHaveBeenCalledExactlyOnceWith({ topic: 'instance', instance_id: inst.id });
      for (const reset of [{ kind: 'other' as const }, { url: URL_B }]) {
        instances.update(inst.id, { kind: 'pdi', full_permissions: 1 });
        changed.mockClear();
        instances.update(inst.id, reset);
        expect(instances.get(inst.id)?.full_permissions).toBe(0);
        expect(changed).toHaveBeenCalledExactlyOnceWith({ topic: 'instance', instance_id: inst.id });
      }
    } finally { bus.off('change', changed); }
  });
  it('starts off and persists only on PDIs', () => {
    const inst = add(URL_A);
    expect(inst.full_permissions).toBe(0);
    instances.update(inst.id, { full_permissions: 1 });
    expect(instances.get(inst.id)?.full_permissions).toBe(1);
    instances.update(inst.id, { kind: 'other' });
    expect(instances.get(inst.id)?.full_permissions).toBe(0);
    expect(() => instances.update(inst.id, { full_permissions: 1 })).toThrow('personal developer instances');
    instances.update(inst.id, { kind: 'pdi' });
    expect(instances.get(inst.id)?.full_permissions).toBe(0);
    expect(() => instances.update(inst.id, { kind: 'other', full_permissions: 1 })).toThrow('personal developer instances');
    expect(instances.get(inst.id)?.kind).toBe('pdi');
  });
  it('drops authority when the address changes, even to another PDI', () => {
    const inst = add(URL_A);
    instances.update(inst.id, { full_permissions: 1 });
    instances.update(inst.id, { url: URL_B });
    expect(instances.get(inst.id)?.full_permissions).toBe(0);
  });
  it('rejects invalid stored flags', () => {
    const inst = add(URL_A);
    expect(() => instances.update(inst.id, { full_permissions: 2 })).toThrow('on or off');
  });
});
