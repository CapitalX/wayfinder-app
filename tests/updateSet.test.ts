import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny fake of the two tables use_update_set touches.
type Row = Record<string, string>;
let prefs: Row[] = [];
let sets: Row[] = [];
const scopes: Row[] = [{ sys_id: 'global', name: 'Global', scope: 'global' }, { sys_id: 'app1', name: 'Loans', scope: 'x_acme_loan' }];
let sticky = false; // the instance ignores changes to apps.current_app
let filesUnderCurrent = false; // a new set lands in the account's current app, as ServiceNow does
let setStuck = false; // the set's application can't be changed
const order: string[] = [];
const where = (q: string) => (r: Row) => q.split('^').every((c) => { const [k, v] = c.split('='); return k === 'state' || r[k] === v; });
const snTable = vi.fn(async (_i: unknown, name: string, q: string) => (name === 'sys_user_preference' ? prefs : name === 'sys_update_set' ? sets : scopes).filter(where(q)));
const snCall = vi.fn(async (_i: unknown, path: string, init: { method?: string; body?: any } = {}) => {
  const id = path.split('/').pop()!;
  order.push(`${init.method ?? 'GET'} ${path.includes('sys_update_set') ? 'set' : init.body?.name ?? 'pref'}`);
  if (path.includes('sys_update_set') && init.method === 'PATCH') { const r = sets.find((s) => s.sys_id === id)!; if (!setStuck) r.application = init.body.application; return {}; }
  if (path.includes('sys_user_preference') && init.method === 'PATCH') { const r = prefs.find((p) => p.sys_id === id)!; if (!(sticky && r.name === 'apps.current_app')) r.value = init.body.value; return {}; }
  if (path.includes('sys_user_preference') && init.method === 'POST') { prefs.push({ sys_id: `p${prefs.length}`, ...init.body }); return {}; }
  if (path.includes('sys_update_set') && init.method === 'POST') { const r = { sys_id: 'new', ...init.body, ...(filesUnderCurrent ? { application: current()[0] ?? 'mcp_runner' } : {}) }; sets.push(r); return { result: { ...r } }; }
  return {};
});
vi.mock('../src/server/sn.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/sn.ts')>()), table: snTable, sn: snCall }));

const { useUpdateSet } = await import('../src/server/facts.ts');
const { instances } = await import('../src/server/db.ts');
const created = instances.create({ name: 'dev', url: 'https://dev12345.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
instances.update(created.id, { profile: JSON.stringify({ user: 'admin', userId: 'me', roles: ['admin'], admin: true, cicd: true, reads: {}, denied: [], checkedAt: 0 }) });
const inst = instances.get(created.id)!;
const current = () => prefs.filter((p) => p.name === 'apps.current_app').map((p) => p.value);

beforeEach(() => {
  sticky = false; filesUnderCurrent = false; setStuck = false; order.length = 0;
  sets = [{ sys_id: 's1', name: 'Loans work', application: 'app1', state: 'in progress' }, { sys_id: 's2', name: 'Old global', application: '', state: 'in progress' }];
  prefs = [{ sys_id: 'a', user: 'me', name: 'apps.current_app', value: 'mcp_runner' }];
});

describe('use_update_set switches the current application too', () => {
  it('switches to the set\'s app and says which', async () => {
    const r = await useUpdateSet(inst, { name: 'Loans work', scope: 'x_acme_loan' });
    expect(current()).toEqual(['app1']);
    expect(r).toMatchObject({ name: 'Loans work', application: 'Loans (x_acme_loan)' });
    expect(r).not.toHaveProperty('warning');
  });

  it('a set with no application means global, not "leave it as it was"', async () => {
    const r = await useUpdateSet(inst, { sys_id: 's2' });
    expect(current()).toEqual(['global']);
    expect(r.application).toBe('Global (global)');
  });

  it('sets every duplicate preference row', async () => {
    prefs.push({ sys_id: 'b', user: 'me', name: 'apps.current_app', value: 'mcp_runner' });
    await useUpdateSet(inst, { name: 'Loans work', scope: 'x_acme_loan' });
    expect(current()).toEqual(['app1', 'app1']);
  });

  it('creates the preference when the account has none', async () => {
    prefs = [];
    await useUpdateSet(inst, { name: 'Loans work', scope: 'x_acme_loan' });
    expect(current()).toEqual(['app1']);
  });

  it('warns when the switch did not take', async () => {
    sticky = true;
    const r = await useUpdateSet(inst, { name: 'Loans work', scope: 'x_acme_loan' });
    expect(r.warning).toMatch(/did not switch to Loans \(x_acme_loan\)/);
  });
});

describe('a new set lands in the app that was picked', () => {
  it('switches the current app before creating the set', async () => {
    filesUnderCurrent = true;
    const r = await useUpdateSet(inst, { name: 'Fresh work', scope: 'global' });
    expect(order.indexOf('PATCH pref')).toBeLessThan(order.indexOf('POST set'));
    expect(sets.find((s) => s.sys_id === 'new')?.application).toBe('global');
    expect(r).toMatchObject({ app_id: 'global', application: 'Global (global)' });
  });

  it('moves a set ServiceNow filed under another app', async () => {
    sticky = true; filesUnderCurrent = true; // the switch doesn't take, so the set lands in mcp_runner
    await useUpdateSet(inst, { name: 'Fresh work', scope: 'x_acme_loan' }).catch(() => {});
    expect(sets.find((s) => s.sys_id === 'new')?.application).toBe('app1');
  });

  it('refuses when the set stays in the wrong app', async () => {
    sticky = true; filesUnderCurrent = true; setStuck = true;
    await expect(useUpdateSet(inst, { name: 'Fresh work', scope: 'global' })).rejects.toThrow(/another application/);
  });
});
