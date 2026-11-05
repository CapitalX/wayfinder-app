import { afterEach, describe, expect, it, vi } from 'vitest';
import { table } from '../src/server/sn.ts';
import { instances } from '../src/server/db.ts';
import { secrets } from '../src/server/secrets.ts';

const inst = instances.create({ name: 'dev', url: 'https://dev12345.service-now.com', client_id: '', login_user: 'admin', kind: 'pdi', auth: 'basic', auth_user: 'admin' });
const calls: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });
const stub = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify({ result: [] }), { status: 200 }); }));

describe('table() only builds Table API paths', () => {
  it('reads a plain table, with the field list encoded', async () => {
    secrets.setPassword(inst.id, 'not-a-real-password');
    stub();
    await table(inst, 'incident', 'active=true', 'number,short_description&sysparm_limit=99999', 5);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]);
    expect(u.pathname).toBe('/api/now/table/incident');
    expect(u.searchParams.get('sysparm_fields')).toBe('number,short_description&sysparm_limit=99999');
    expect(u.searchParams.get('sysparm_limit')).toBe('5');
  });

  it.each(['../../api/now/v1/x', 'incident/0123', 'incident?x=1', 'Incident', '', 'a'.repeat(81)])('refuses %j without a request', async (name) => {
    stub();
    await expect(table(inst, name, '', 'sys_id')).rejects.toThrow(/Not a table name/);
    expect(calls).toHaveLength(0);
  });
});
