import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sn, table } = vi.hoisted(() => ({ sn: vi.fn(), table: vi.fn() }));
vi.mock('../src/server/sn.ts', async (orig) => ({ ...(await orig<typeof import('../src/server/sn.ts')>()), sn, table }));
const { instanceServer } = await import('../src/server/instanceTools.ts');
const { INSTANCE_READS, INSTANCE_WRITES } = await import('../src/server/instanceReads.ts');
const { settings, instances } = await import('../src/server/db.ts');
const { CREDENTIAL_TABLES } = await import('../src/server/scrub.ts');
const inst = instances.create({ name: 'Test', url: 'https://dev12345.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'basic', auth_user: 'admin' });
const id = 'a'.repeat(32);
const tools = (writes = true) => (instanceServer(inst, writes).instance as any)._registeredTools as Record<string, any>;
const registered = tools();
const call = (name: string, input: Record<string, unknown> = {}) => registered[name].handler(input);
const json = (result: any) => { expect(result.isError, result.content[0].text).not.toBe(true); return JSON.parse(result.content[0].text); };
const request = () => {
  const [instance, path, init] = sn.mock.calls.at(-1)!;
  expect(instance).toBe(inst);
  const url = new URL(path, inst.url);
  return { path: url.pathname, params: Object.fromEntries(url.searchParams), init };
};
beforeEach(() => { sn.mockReset(); table.mockReset(); settings.set({ writeEnabled: true, scriptingEnabled: true }); });

describe('instance REST tools', () => {
  it('lists exactly the classified tools and omits writes in read-only modes', () => {
    expect(new Set(Object.keys(registered))).toEqual(new Set([...INSTANCE_READS, ...INSTANCE_WRITES]));
    expect(new Set(Object.keys(tools(false)))).toEqual(INSTANCE_READS);
  });
  it('queries with encoded values, field selection, pagination, order and display values', async () => {
    sn.mockResolvedValue({ result: [{ sys_id: id, short_description: 'Printer down' }] });
    expect(json(await call('query_records', { table: 'incident', query: 'active=true^short_descriptionLIKEA&B', fields: ['sys_id', 'caller_id.name'], limit: 7, offset: 21, order: ['priority', '-sys_created_on'], display_value: 'all' }))).toEqual({ count: 1, records: [{ sys_id: id, short_description: 'Printer down' }] });
    expect(request()).toEqual({ path: '/api/now/table/incident', params: { sysparm_query: 'active=true^short_descriptionLIKEA&B^ORDERBYpriority^ORDERBYDESCsys_created_on', sysparm_fields: 'sys_id,caller_id.name', sysparm_limit: '7', sysparm_offset: '21', sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true' }, init: undefined });
  });
  it('uses bounded defaults', async () => {
    sn.mockResolvedValue({ result: [] });
    json(await call('query_records', { table: 'incident' }));
    expect(request().params).toMatchObject({ sysparm_query: '', sysparm_limit: '20', sysparm_offset: '0', sysparm_display_value: 'false' });
  });
  it('reads a single record', async () => {
    sn.mockResolvedValue({ result: { sys_id: id } });
    expect(json(await call('get_record', { table: 'incident', sys_id: id, fields: ['sys_id'] }))).toEqual({ count: 1, records: [{ sys_id: id }] });
    expect(request()).toEqual({ path: `/api/now/table/incident/${id}`, params: { sysparm_fields: 'sys_id', sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' }, init: undefined });
  });
  it('counts using the Aggregate API and refuses malformed counts', async () => {
    sn.mockResolvedValue({ result: { stats: { count: '1234' } } });
    expect(json(await call('count_records', { table: 'incident', query: 'active=true' }))).toEqual({ count: 1234 });
    expect(request()).toEqual({ path: '/api/now/stats/incident', params: { sysparm_query: 'active=true', sysparm_count: 'true' }, init: undefined });
    sn.mockResolvedValue({ result: {} });
    expect((await call('count_records', { table: 'incident' })).isError).toBe(true);
  });
  it('builds all aggregate operations and groupings', async () => {
    const records = [{ groupby_fields: [{ field: 'priority', value: '1' }], stats: { count: '3', sum: { reassignment_count: '9' } } }];
    sn.mockResolvedValue({ result: records });
    expect(json(await call('aggregate', { table: 'incident', query: 'active=true', group_by: ['priority', 'state'], sum: ['reassignment_count'], avg: ['reassignment_count'], min: ['reassignment_count'], max: ['reassignment_count'] }))).toEqual({ count: 1, records });
    expect(request()).toEqual({ path: '/api/now/stats/incident', params: { sysparm_query: 'active=true', sysparm_count: 'true', sysparm_display_value: 'false', sysparm_group_by: 'priority,state', sysparm_sum_fields: 'reassignment_count', sysparm_avg_fields: 'reassignment_count', sysparm_min_fields: 'reassignment_count', sysparm_max_fields: 'reassignment_count' }, init: undefined });
    sn.mockResolvedValue({ result: { stats: { count: '0' } } });
    expect(json(await call('aggregate', { table: 'incident' })).records).toEqual([{ stats: { count: '0' } }]);
    expect((await call('aggregate', { table: 'incident', count: false })).isError).toBe(true);
  });
  it.each([['create_record', 'POST'], ['update_record', 'PATCH'], ['delete_record', 'DELETE']])('%s sends precisely the approved record fields', async (name, method) => {
    sn.mockResolvedValue(method === 'DELETE' ? {} : { result: { sys_id: id } });
    const input = { table: 'incident', ...(method === 'POST' ? {} : { sys_id: id }), ...(method === 'DELETE' ? {} : { fields: { active: false, priority: 2, assigned_to: null } }) };
    const out = json(await call(name, input));
    expect(request()).toEqual({ path: `/api/now/table/incident${method === 'POST' ? '' : `/${id}`}`, params: {}, init: { method, ...(method === 'DELETE' ? {} : { body: input.fields }) } });
    expect(out).toEqual(method === 'DELETE' ? { deleted: true, table: 'incident', sys_id: id } : { count: 1, records: [{ sys_id: id }] });
  });
  it('asks for runner setup without making any request', async () => {
    const r = await call('run_script', { script: 'gs.info("hello");', why: 'Check output' });
    expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Offer setup_script_runner') }] });
    expect(sn).not.toHaveBeenCalled(); expect(table).not.toHaveBeenCalled();
  });
  it('returns HTTP failures as errors and masks secrets before returning or clipping', async () => {
    sn.mockRejectedValue(new Error('403 forbidden'));
    expect(await call('get_record', { table: 'incident', sys_id: id })).toMatchObject({ isError: true, content: [{ text: 'Error: 403 forbidden' }] });
    sn.mockResolvedValue({ result: [{ password: 'never-return-this', description: 'x'.repeat(9000) }] });
    const r = await call('query_records', { table: 'incident' });
    expect(r.content[0].text).toContain('[masked]');
    expect(r.content[0].text).not.toContain('never-return-this');
    expect(r.content[0].text).toContain('more characters');
  });
});

describe('inherited schema', () => {
  const child = { element: 'priority', column_label: 'Priority', 'internal_type.name': 'integer', reference: '', mandatory: 'true' };
  const parent = { element: 'caller_id', column_label: 'Caller', 'internal_type.name': 'reference', reference: 'sys_user', mandatory: 'true' };
  const prepare = () => {
    table.mockImplementation(async (_i, _t, q) => q === 'name=incident' ? [{ name: 'incident', 'super_class.name': 'task' }] : [{ name: 'task', 'super_class.name': '' }]);
    sn.mockImplementation(async (_i, path) => ({ result: new URL(path, inst.url).searchParams.get('sysparm_query')!.startsWith('name=incident^') ? [child] : [parent, { ...child, mandatory: 'false' }, { ...parent, element: 'description', mandatory: 'false' }] }));
  };
  it('follows the parent chain and keeps the nearest field definition', async () => {
    prepare();
    const r = json(await call('get_table_schema', { table: 'incident' }));
    expect(table.mock.calls).toEqual([[inst, 'sys_db_object', 'name=incident', 'name,super_class.name', 1], [inst, 'sys_db_object', 'name=task', 'name,super_class.name', 1]]);
    expect(r.count).toBe(3);
    expect(r.records).toContainEqual({ name: 'caller_id', label: 'Caller', type: 'reference', reference: 'sys_user', mandatory: true, inherited_from: 'task' });
    expect(r.records.find((f: any) => f.name === 'priority')).toMatchObject({ mandatory: true, type: 'integer' });
    expect(request().params).toEqual({ sysparm_query: 'name=task^elementISNOTEMPTY^ORDERBYsys_id', sysparm_fields: 'element,column_label,internal_type.name,reference,mandatory', sysparm_limit: '500', sysparm_offset: '0', sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true' });
    expect(sn.mock.calls.every((c) => !c[2])).toBe(true);
  });
  it('filters mandatory fields after inheritance', async () => {
    prepare();
    expect(json(await call('get_mandatory_fields', { table: 'incident' })).records.map((r: any) => r.name)).toEqual(['priority', 'caller_id']);
  });
  it('reads subsequent dictionary pages instead of silently losing inherited fields', async () => {
    table.mockResolvedValue([{ name: 'incident', 'super_class.name': '' }]);
    sn.mockResolvedValueOnce({ result: Array.from({ length: 500 }, (_, n) => ({ ...child, element: `field_${n}` })) }).mockResolvedValueOnce({ result: [parent] });
    const r = await call('get_table_schema', { table: 'incident' });
    expect(r.isError).not.toBe(true);
    expect(request().params.sysparm_offset).toBe('500');
    expect(sn).toHaveBeenCalledTimes(2);
  });
  it('fails clearly for missing definitions, cycles and inaccessible dictionary pages', async () => {
    table.mockResolvedValue([]);
    expect((await call('get_table_schema', { table: 'incident' })).isError).toBe(true);
    table.mockResolvedValue([{ 'super_class.name': 'incident' }]);
    expect((await call('get_table_schema', { table: 'incident' })).content[0].text).toContain('cyclic');
    prepare(); sn.mockRejectedValue(new Error('403 dictionary denied'));
    expect((await call('get_mandatory_fields', { table: 'incident' })).isError).toBe(true);
  });
});

describe('script source paging', () => {
  it('reads by name and by sys_id with inclusive line bounds and total line count', async () => {
    table.mockResolvedValue([{ sys_id: id, script: 'first\r\nsecond\r\nthird' }]);
    expect(json(await call('read_script', { table: 'sys_script_include', name: 'LoanUtils', from_line: 2, to_line: 2 }))).toEqual({ sys_id: id, field: 'script', total_lines: 3, from_line: 2, from_column: 1, to_line: 2, script: 'second', next_from_line: 3, next_from_column: 1 });
    expect(table).toHaveBeenLastCalledWith(inst, 'sys_script_include', 'name=LoanUtils', 'sys_id,script', 2);
    expect(json(await call('read_script', { table: 'sysauto_script', sys_id: id })).script).toBe('first\nsecond\nthird');
    expect(table).toHaveBeenLastCalledWith(inst, 'sysauto_script', `sys_id=${id}`, 'sys_id,script', 2);
  });
  it.each(['lines', 'one long line', 'escaped characters'])('reads a large source completely without clipping: %s', async (kind) => {
    const source = kind === 'lines' ? Array.from({ length: 2000 }, (_, i) => `var line${i} = "hello";`).join('\n') : kind === 'escaped characters' ? '\t"\\'.repeat(22000) : 'x'.repeat(67000);
    table.mockResolvedValue([{ sys_id: id, script: source }]);
    let from_line = 1, from_column = 1, reconstructed = '', previousLine = 0;
    for (let n = 0; n < 100; n++) {
      const result = await call('read_script', { table: 'sys_script_include', sys_id: id, from_line, from_column });
      expect(result.content[0].text.length).toBeLessThan(6000);
      const page = json(result);
      // Each default page includes the newline when it advances to another line.
      reconstructed += page.script;
      expect(page.total_lines).toBe(source.split('\n').length);
      if (!page.next_from_line) break;
      expect(page.next_from_line >= from_line).toBe(true);
      previousLine = from_line; from_line = page.next_from_line; from_column = page.next_from_column;
      expect(from_line > previousLine || from_column > 1).toBe(true);
    }
    expect(reconstructed).toBe(source);
  });
  it('rejects ambiguous or missing records, selectors and invalid ranges', async () => {
    table.mockResolvedValue([]);
    expect((await call('read_script', { table: 'sys_script', name: 'Missing' })).isError).toBe(true);
    table.mockResolvedValue([{ script: '' }, { script: '' }]);
    expect((await call('read_script', { table: 'sys_script', name: 'Duplicate' })).content[0].text).toContain('More than one');
    table.mockResolvedValue([{ sys_id: id, script: 'a\nb' }]);
    for (const input of [{}, { sys_id: id, name: 'Both' }, { sys_id: id, from_line: 3 }, { sys_id: id, from_line: 2, to_line: 1 }, { sys_id: id, from_column: 5 }]) expect((await call('read_script', { table: 'sys_script', ...input })).isError).toBe(true);
    table.mockResolvedValue([{ sys_id: id }]);
    expect((await call('read_script', { table: 'sys_script', sys_id: id })).isError).toBe(true);
  });
  it('masks full source before it is split across pages', async () => {
    table.mockResolvedValue([{ sys_id: id, script: 'x'.repeat(4900) + '\nAuthorization: Bearer private-header\nend' }]);
    const r = json(await call('read_script', { table: 'sys_script', sys_id: id }));
    expect(r.script).toContain('Authorization: [masked]');
    expect(r.script).not.toContain('private-header');
  });
});

describe('trust boundaries', () => {
  it.each([...INSTANCE_READS, ...INSTANCE_WRITES])('%s refuses credential tables without a REST request', async (name) => {
    for (const tableName of CREDENTIAL_TABLES) {
      const input = name === 'run_script' ? { script: 'x', table: tableName } : { table: tableName,
        ...(['get_record', 'update_record', 'delete_record', 'read_script'].includes(name) ? { sys_id: id } : {}),
        ...(['create_record', 'update_record'].includes(name) ? { fields: { active: false } } : {}) };
      expect((await call(name, input)).isError).toBe(true);
    }
    expect(sn).not.toHaveBeenCalled(); expect(table).not.toHaveBeenCalled();
  });
  it.each(['../stats/incident', 'incident?x=1', 'Incident', 'incident/abc', 'incident%2fabc'])('rejects crafted table %s', async (table) => {
    expect((await call('query_records', { table })).isError).toBe(true); expect(sn).not.toHaveBeenCalled();
  });
  it.each(['sys_id=javascript:gs.sleep(999)', 'sys_id=javascript:gs.getUserID();gs.info(1)', 'sys_id=JAVASCRIPT:gs.getUserID()', 'sys_id=javascript:gs.getUserID()%3b', 'sys_id=javascript:new GlideRecord("incident").deleteMultiple()'])('refuses executable query %s', async (query) => {
    for (const name of ['query_records', 'count_records', 'aggregate']) expect((await call(name, { table: 'incident', query })).isError).toBe(true);
    expect(sn).not.toHaveBeenCalled();
  });
  it('allows complete read-only date and identity expressions', async () => {
    sn.mockResolvedValue({ result: [] });
    json(await call('query_records', { table: 'incident', query: 'sys_created_on>=javascript:gs.hoursAgo(24)^assigned_to=javascript:gs.getUserID()' }));
    expect(sn).toHaveBeenCalledOnce();
  });
  it('refuses invalid bounds, ids, fields, names, and extra arguments', async () => {
    for (const input of [{ limit: 0 }, { limit: 1001 }, { offset: -1 }, { fields: ['name&sysparm_limit=99'] }, { order: ['priority^NQactive=true'] }, { display_value: 'yes' }, { extra: true }]) expect((await call('query_records', { table: 'incident', ...input })).isError).toBe(true);
    expect((await call('get_record', { table: 'incident', sys_id: '../../x' })).isError).toBe(true);
    expect((await call('create_record', { table: 'incident', fields: {} })).isError).toBe(true);
    expect((await call('update_record', { table: 'incident', sys_id: id, fields: { 'bad.field': 1 } })).isError).toBe(true);
    expect((await call('read_script', { table: 'sys_script', name: 'x^ORactive=true' })).isError).toBe(true);
    expect((await call('read_script', { table: 'sys_user', sys_id: id, field: 'user_password' })).isError).toBe(true);
    expect(sn).not.toHaveBeenCalled(); expect(table).not.toHaveBeenCalled();
  });
  it('rechecks write and script settings at execution, even after approval', async () => {
    settings.set({ writeEnabled: false });
    expect((await call('delete_record', { table: 'incident', sys_id: id })).content[0].text).toContain('writes are off');
    settings.set({ writeEnabled: true, scriptingEnabled: false });
    expect((await call('run_script', { script: 'x', why: 'test' })).content[0].text).toContain('scripting is off');
    expect(sn).not.toHaveBeenCalled();
  });
});
