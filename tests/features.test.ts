import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../src/server/db.ts';

const { table } = vi.hoisted(() => ({ table: vi.fn() }));
vi.mock('../src/server/sn.ts', () => ({ table }));
const { searchFeatures, clearFeatureCache } = await import('../src/server/features.ts');

const inst: Instance = { id: 'i1', name: 'dev', url: 'https://dev1.service-now.com', client_id: '', login_user: '', status: 'active', created_at: 0, kind: 'pdi', full_permissions: 0, auth: 'client_credentials', auth_user: null, profile: null };
const plugin = (p: Record<string, string>) => ({ active: 'inactive', block_install: 'false', requires: '', indicators: '', ...p });
const app = (a: Record<string, string>) => ({ block_install: 'false', indicators: '', dependencies: '', ...a });

function data(d: { plugins?: any[]; remote?: any[]; installed?: string[]; storeAppFails?: boolean; scopes?: string[] }) {
  table.mockImplementation(async (_i: Instance, name: string, query: string) => {
    if (name === 'v_plugin') return query.startsWith('idIN') ? (d.plugins ?? []).filter((p) => query.slice(4).split(',').includes(p.id)) : d.plugins ?? [];
    if (name === 'sys_remote_app') return d.remote ?? [];
    if (name === 'sys_scope' && query.startsWith('sys_class_name=sys_store_app')) { if (d.storeAppFails) throw new Error('403'); return (d.installed ?? []).map((scope) => ({ scope })); }
    if (name === 'sys_scope') return (d.scopes ?? []).map((scope) => ({ scope }));
    return [];
  });
}
const pluginQuery = () => table.mock.calls.find((c) => c[1] === 'v_plugin')?.[2] as string;

beforeEach(() => { table.mockReset(); clearFeatureCache(); });

describe('feature search keywords', () => {
  it('drops filler and weak words when stronger ones are left', async () => {
    data({});
    await searchFeatures(inst, 'service catalog request fulfillment with flow designer');
    const q = pluginQuery();
    for (const w of ['catalog', 'request', 'fulfillment', 'flow', 'designer']) expect(q).toContain(`nameLIKE${w}`);
    expect(q).not.toContain('LIKEservice');
    expect(q).not.toContain('LIKEwith');
  });

  it('keeps weak words when nothing more specific is left', async () => {
    data({});
    await searchFeatures(inst, 'service management');
    expect(pluginQuery()).toContain('nameLIKEservice');
  });

  it('strips query operators from the search', async () => {
    data({});
    await searchFeatures(inst, 'catalog^ORactive=true');
    expect(pluginQuery()).not.toContain('active=true');
  });

  it('searches nothing for a question with no real words', async () => {
    data({});
    expect(await searchFeatures(inst, 'how can I turn on the plugin')).toEqual([]);
    expect(table).not.toHaveBeenCalled();
  });
});

describe('feature ranking and status', () => {
  it('ranks a whole-phrase name match first, then name hits over description hits', async () => {
    data({ plugins: [
      plugin({ id: 'a', name: 'Workspace tools', description: 'agent workspace for incidents' }),
      plugin({ id: 'b', name: 'Agent Workspace', description: '' }),
      plugin({ id: 'c', name: 'Agent chat', description: '' }),
    ] });
    const out = await searchFeatures(inst, 'agent workspace');
    expect(out.map((f) => f.id)).toEqual(['b', 'a', 'c']);
  });

  it('puts usable features before blocked ones at the same score', async () => {
    data({ plugins: [
      plugin({ id: 'x', name: 'Catalog A', block_install: 'true', indicators: JSON.stringify([{ message: 'Needs a license' }]) }),
      plugin({ id: 'y', name: 'Catalog B' }),
      plugin({ id: 'z', name: 'Catalog C', active: 'active' }),
    ] });
    const out = await searchFeatures(inst, 'catalog');
    expect(out.map((f) => [f.id, f.status])).toEqual([['y', 'ready'], ['z', 'on'], ['x', 'blocked']]);
    expect(out[2].why).toBe('Needs a license');
  });

  it('reports plugin prerequisites and whether they are on', async () => {
    data({ plugins: [
      plugin({ id: 'com.snc.catalog_flow', name: 'Catalog flows', requires: 'com.glide.hub, com.missing' }),
      plugin({ id: 'com.glide.hub', name: 'Flow hub', active: 'active' }),
    ] });
    const [first] = await searchFeatures(inst, 'catalog flows');
    expect(first.requires).toEqual([{ id: 'com.glide.hub', name: 'Flow hub', on: true }, { id: 'com.missing', name: 'com.missing', on: null }]);
  });

  it('marks Store apps on, available, blocked or unavailable on developer instances', async () => {
    data({
      remote: [
        app({ sys_id: '1', name: 'Vendor risk', scope: 'sn_vdr' }),
        app({ sys_id: '2', name: 'Vendor portal', scope: 'sn_vp', block_install: 'true', indicators: JSON.stringify([{ tooltip: 'Unavailable on developer instances' }]) }),
        app({ sys_id: '3', name: 'Vendor billing', scope: 'sn_vb', block_install: 'true' }),
        app({ sys_id: '4', name: 'Vendor manager', scope: 'sn_vm', price_type: 'paid' }),
      ],
      installed: ['sn_vdr'],
    });
    const out = await searchFeatures(inst, 'vendor');
    const status = Object.fromEntries(out.map((f) => [f.scope, f.status]));
    expect(status).toEqual({ sn_vdr: 'on', sn_vp: 'pdi_unavailable', sn_vb: 'blocked', sn_vm: 'store' });
    expect(out.find((f) => f.scope === 'sn_vm')!.paid).toBe(true);
  });

  it('falls back to the scope table when the account cannot read installed Store apps', async () => {
    data({ remote: [app({ sys_id: '1', name: 'Vendor risk', scope: 'sn_vdr' })], storeAppFails: true, scopes: ['sn_vdr'] });
    expect((await searchFeatures(inst, 'vendor'))[0].status).toBe('on');
  });

  it('answers a repeated search from the cache until it is cleared', async () => {
    data({ plugins: [plugin({ id: 'a', name: 'Catalog' })] });
    await searchFeatures(inst, 'Catalog');
    const calls = table.mock.calls.length;
    await searchFeatures(inst, ' catalog ');
    expect(table.mock.calls.length).toBe(calls);
    clearFeatureCache();
    await searchFeatures(inst, 'catalog');
    expect(table.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe('plain feature lines', () => {
  it('says what a well-known product does and why you would turn it on', async () => {
    const { plainLine } = await import('../src/server/features.ts');
    expect(plainLine('Performance Analytics - Premium', 'com.snc.pa.premium')).toMatch(/^Scores and trends .* Turn it on/);
  });
  it('otherwise uses the first sentence of the description, without markup', async () => {
    const { plainLine } = await import('../src/server/features.ts');
    expect(plainLine('Loaner Thing', '<p>Lets people borrow equipment and return it on time.</p> More details follow here.')).toBe('Lets people borrow equipment and return it on time.');
    expect(plainLine('X', '')).toBe('');
    expect(plainLine('X', 'a'.repeat(300)).length).toBeLessThanOrEqual(180);
  });
});

describe('when the instance refuses a check', () => {
  it('says so, instead of reporting nothing installed or nothing found', async () => {
    table.mockImplementation(async (_i: Instance, name: string) => {
      if (name === 'v_plugin') throw new Error('403 Forbidden');
      if (name === 'sys_remote_app') return [app({ sys_id: 'r1', name: 'Vendor Risk', scope: 'sn_vdr_risk' })];
      if (name === 'sys_scope') throw new Error('403 Forbidden');
      return [];
    });
    const { findFeatures } = await import('../src/server/features.ts');
    const r = await findFeatures(inst, 'vendor risk');
    expect(r.problems.join(' ')).toMatch(/Couldn't read plugins \(v_plugin\): 403/);
    expect(r.problems.join(' ')).toMatch(/install state is unknown/);
    expect(r.features).toHaveLength(1);
    expect(r.features[0].status).toBe('unknown');
  });
  it('asks again next time instead of caching a failed search', async () => {
    let calls = 0;
    table.mockImplementation(async (_i: Instance, name: string) => { if (name === 'v_plugin') { calls++; throw new Error('timeout'); } return []; });
    const { findFeatures } = await import('../src/server/features.ts');
    await findFeatures(inst, 'catalog');
    await findFeatures(inst, 'catalog');
    expect(calls).toBe(2);
  });
});
