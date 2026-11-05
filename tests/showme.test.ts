import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../src/server/db.ts';

const { sn, table } = vi.hoisted(() => ({ sn: vi.fn(), table: vi.fn() }));
vi.mock('../src/server/sn.ts', () => ({ sn, table }));
const { showForm, showRecord } = await import('../src/server/showme.ts');

let n = 0;
// A fresh instance id per test, so the 10-minute label cache never carries over.
const inst = (): Instance => ({ id: `i${++n}`, name: 'dev', url: 'https://dev12345.service-now.com', client_id: '', login_user: '', status: 'active', created_at: 0, kind: 'pdi', full_permissions: 0, auth: 'client_credentials', auth_user: null, profile: null });
const v = (value: string, display = value) => ({ value, display_value: display });

const record = {
  sys_id: v('abc'), number: v('INC0010009'), caller_id: v('u1', 'Beth Anglin'), state: v('1', 'New'), priority: v('4', '4 - Low'),
  short_description: v('Email is down'), description: v('Since this morning'), assigned_to: v(''), sys_updated_on: v('2026-10-07'),
};

type El = { element: string; type: string };
function instance(sections: { sys_id: string; caption: string; position: string; elements: El[] }[]) {
  sn.mockImplementation(async (_i: Instance, path: string) => {
    if (path.startsWith('/api/now/table/incident/')) return { result: record };
    throw new Error(`unexpected ${path}`);
  });
  table.mockImplementation(async (_i: Instance, name: string, query: string) => {
    if (name === 'sys_db_object') return query === 'name=incident' ? [{ name: 'incident', label: 'Incident', 'super_class.name': 'task' }] : query === 'name=task' ? [{ name: 'task', label: 'Task', 'super_class.name': '' }] : [];
    if (name === 'sys_documentation') return [
      { name: 'task', element: 'number', label: 'Number' }, { name: 'task', element: 'state', label: 'State' },
      { name: 'incident', element: 'state', label: 'Incident state' }, { name: 'incident', element: 'caller_id', label: 'Caller' },
    ];
    if (name === 'sys_ui_section') return sections.map(({ elements: _e, ...s }) => s);
    if (name === 'sys_ui_element') return sections.find((s) => query.startsWith(`sys_ui_section=${s.sys_id}^`))?.elements ?? [];
    return [];
  });
}
const f = (element: string, type = '') => ({ element, type });
const names = (fields?: { name: string }[]) => fields?.map((x) => x.name);

beforeEach(() => { sn.mockReset(); table.mockReset(); });

describe('showForm layout', () => {
  it('puts fields before .split in the left column when there is no .begin_split', async () => {
    instance([{ sys_id: 's1', caption: '', position: '0', elements: [f('number'), f('caller_id'), f('', '.split'), f('state'), f('priority'), f('', '.end_split'), f('short_description'), f('description')] }]);
    const snap = await showForm(inst(), 'incident', 'abc');
    const [sec] = snap.sections!;
    expect(sec.caption).toBe('Incident');
    expect(sec.top).toBeUndefined();
    expect(sec.columns.map(names)).toEqual([['number', 'caller_id'], ['state', 'priority']]);
    expect(names(sec.full)).toEqual(['short_description', 'description']);
  });

  it('keeps fields before .begin_split full width on top', async () => {
    instance([{ sys_id: 's1', caption: '', position: '0', elements: [f('short_description'), f('', '.begin_split'), f('number'), f('', '.split'), f('state'), f('', '.end_split'), f('description')] }]);
    const [sec] = (await showForm(inst(), 'incident', 'abc')).sections!;
    expect(names(sec.top)).toEqual(['short_description']);
    expect(sec.columns.map(names)).toEqual([['number'], ['state']]);
    expect(names(sec.full)).toEqual(['description']);
  });

  it('skips formatters, related lists and fields the record lacks', async () => {
    instance([{ sys_id: 's1', caption: '', position: '0', elements: [f('number'), f('activity.xml', 'formatter'), f('task_sla', 'list'), f('u_missing'), f('state')] }]);
    const [sec] = (await showForm(inst(), 'incident', 'abc')).sections!;
    expect(names(sec.top)).toEqual(['number', 'state']);
  });

  it('shows the main section first, then captioned sections by position', async () => {
    instance([
      { sys_id: 's3', caption: 'Notes', position: '2', elements: [f('description')] },
      { sys_id: 's2', caption: 'Related', position: '1', elements: [f('priority')] },
      { sys_id: 's1', caption: '', position: '5', elements: [f('number')] },
    ]);
    const snap = await showForm(inst(), 'incident', 'abc');
    expect(snap.sections!.map((s) => s.caption)).toEqual(['Incident', 'Related', 'Notes']);
  });

  it('uses the closest table label (incident overrides task) and display values', async () => {
    instance([{ sys_id: 's1', caption: '', position: '0', elements: [f('number'), f('state'), f('caller_id')] }]);
    const snap = await showForm(inst(), 'incident', 'abc');
    expect(snap.sections![0].top).toEqual([
      { name: 'number', label: 'Number', value: 'INC0010009', display: 'INC0010009' },
      { name: 'state', label: 'Incident state', value: '1', display: 'New' },
      { name: 'caller_id', label: 'Caller', value: 'u1', display: 'Beth Anglin' },
    ]);
    expect(snap.title).toBe('INC0010009');
    expect(snap.link).toBe('https://dev12345.service-now.com/incident.do?sys_id=abc');
    expect(snap.instance).toBe('dev12345');
  });

  it('falls back to the filled fields when there is no form layout', async () => {
    instance([]);
    const snap = await showForm(inst(), 'incident', 'abc');
    expect(snap.kind).toBe('record');
    expect(snap.omitted).toContain('no form layout found, so this shows the filled fields');
    // Empty and system fields stay out.
    expect(names(snap.fields)).not.toContain('assigned_to');
    expect(names(snap.fields)).not.toContain('sys_updated_on');
    expect(names(snap.fields)).toContain('short_description');
  });
});

describe('showRecord', () => {
  it('shows only the asked-for fields that exist', async () => {
    instance([]);
    const snap = await showRecord(inst(), 'incident', 'abc', ['priority', 'nope', 'number']);
    expect(names(snap.fields)).toEqual(['priority', 'number']);
  });
});
