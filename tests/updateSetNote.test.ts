import { beforeEach, describe, expect, it, vi } from 'vitest';

const { table, sn } = vi.hoisted(() => ({ table: vi.fn(), sn: vi.fn() }));
vi.mock('../src/server/sn.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/sn.ts')>()), table, sn }));
const { appendNote } = await import('../src/server/facts.ts');
const inst = { id: 'i', url: 'https://dev12345.service-now.com' } as any;
const SET = 'b'.repeat(32);
const rows = (set: Record<string, unknown> | null, max?: number) => table.mockImplementation(async (_i: unknown, t: string) =>
  t === 'sys_update_set' ? (set ? [set] : []) : t === 'sys_dictionary' ? (max ? [{ max_length: String(max) }] : []) : []);

beforeEach(() => { table.mockReset(); sn.mockReset(); sn.mockResolvedValue({ result: {} }); });

describe('writing the note', () => {
  it('appends to the description, never replaces it', async () => {
    rows({ sys_id: SET, name: 'Loans', description: 'Team notes.', state: 'in progress' }, 1000);
    expect(await appendNote(inst, SET, '[Wayfinder] N')).toEqual({ name: 'Loans' });
    expect(sn).toHaveBeenCalledWith(inst, `/api/now/table/sys_update_set/${SET}`, { method: 'PATCH', body: { description: 'Team notes.\n\n[Wayfinder] N' } });
  });

  it('refuses when it would not fit, or the set is finished, and writes nothing', async () => {
    rows({ sys_id: SET, name: 'Loans', description: 'x'.repeat(95), state: 'in progress' }, 100);
    await expect(appendNote(inst, SET, 'note')).rejects.toThrow(/has room for 100 characters/);
    rows({ sys_id: SET, name: 'Loans', description: '', state: 'complete' }, 1000);
    await expect(appendNote(inst, SET, 'note')).rejects.toThrow(/no longer in progress/);
    rows(null);
    await expect(appendNote(inst, SET, 'note')).rejects.toThrow(/not found/);
    expect(sn).not.toHaveBeenCalled();
  });

  it('assumes 4000 characters when the field length is unknown', async () => {
    rows({ sys_id: SET, name: 'Loans', description: 'x'.repeat(3990), state: 'in progress' });
    await expect(appendNote(inst, SET, 'a longer note')).rejects.toThrow(/room for 4000/);
  });
});
