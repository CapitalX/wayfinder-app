import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { callsInclude, findReferences, summarize, validTarget } from '../src/server/impact.ts';
import { instances } from '../src/server/db.ts';
import { secrets } from '../src/server/secrets.ts';
import { fakeInstance, id } from './fixtures/fakeInstance.ts';

const inst = instances.create({ name: 'dev', url: 'https://dev12345.service-now.com', client_id: '', login_user: 'admin', kind: 'pdi', auth: 'basic', auth_user: 'admin' });
secrets.setPassword(inst.id, 'not-a-real-password');
afterEach(() => vi.unstubAllGlobals());

// A small instance: a loan table with a status field, and things that do and don't use it.
const world = () => fakeInstance({
  sys_script: [
    { sys_id: id(1), name: 'Loan - set due date', collection: 'x_loan', script: "if (current.u_status == 'out') current.due = gs.daysAgo(-7);", condition: '', filter_condition: '' },
    { sys_id: id(2), name: 'Loan - audit', collection: 'x_loan', script: 'gs.info(current.u_status_old);', condition: '', filter_condition: '' }, // u_status_old, not u_status
    { sys_id: id(3), name: 'Incident rule', collection: 'incident', script: 'current.u_status = 1;', condition: '', filter_condition: '' }, // another table
    { sys_id: id(4), name: 'Loan - by condition', collection: 'x_loan', script: '', condition: '', filter_condition: 'u_status=out^EQ' },
  ],
  sys_script_client: [{ sys_id: id(10), name: 'Loan status onChange', table: 'x_loan', script: '', field_name: 'u_status' }],
  sys_ui_action: [],
  sys_ui_policy: [{ sys_id: id(20), short_description: 'Show return date', table: 'x_loan', conditions: 'u_status=returned^EQ', script_true: '', script_false: '' }],
  sys_ui_policy_action: [{ sys_id: id(21), table: 'x_loan', field: 'u_status', ui_policy: id(20) }, { sys_id: id(22), table: 'x_loan', field: 'u_due', ui_policy: id(23) }],
  sys_security_acl: [
    { sys_id: id(30), name: 'x_loan.u_status', operation: 'write', condition: '', script: '', type: 'record', active: 'true', admin_overrides: 'true' },
    { sys_id: id(31), name: 'x_loan', operation: 'read', condition: '', script: '', type: 'record', active: 'true', admin_overrides: 'true' },
    { sys_id: id(32), name: 'x_loan.*', operation: 'write', condition: '', script: '', type: 'record', active: 'true', admin_overrides: 'true' },
  ],
  sys_security_acl_role: [{ sys_id: id(33), sys_security_acl: id(30), sys_user_role: id(34) }],
  sys_user_role: [{ sys_id: id(34), name: 'x_loan.manager' }],
  sysevent_email_action: [{ sys_id: id(40), name: 'Loan overdue', collection: 'x_loan', condition: 'u_status=out', advanced_condition: '', message_html: '' }],
  sys_report: [{ sys_id: id(50), title: 'Loans by status', table: 'x_loan', filter: '', field: 'u_status', group: '' }],
  sys_script_include: [
    { sys_id: id(60), name: 'LoanUtils', script: "var LoanUtils = Class.create(); var gr = new GlideRecord('x_loan'); gr.addQuery('u_status', 'out');" },
    { sys_id: id(61), name: 'Other', script: "var gr = new GlideRecord('x_loan_item'); gr.addQuery('u_status', 'x');" }, // x_loan_item, not x_loan
    { sys_id: id(62), name: 'Caller', script: 'var u = new LoanUtils(); u.due();' },
    { sys_id: id(63), name: 'Scoped caller', script: 'x_acme.LoanUtils.overdue(current);' },
    { sys_id: id(64), name: 'Lookalike', script: 'var x = new LoanUtilsLegacy();' },
  ],
  sysauto_script: [], sys_ws_operation: [],
  sys_script_client_ajax: [],
  sys_dictionary: [{ sys_id: id(70), name: 'x_loan_item', element: 'u_loan', internal_type: 'reference', reference: 'x_loan' }],
  sys_hub_trigger_instance: [{ sys_id: id(80), table: 'x_loan', flow: id(81) }, { sys_id: id(82), table: 'incident', flow: id(83) }],
  sys_hub_flow: [{ sys_id: id(81), name: 'Loan reminders', type: 'flow' }, { sys_id: id(83), name: 'Incident flow', type: 'flow' }],
});

const names = (r: { refs: { kind: string; name: string }[] }) => r.refs.map((x) => `${x.kind}: ${x.name}`).sort();

describe('findReferences', () => {
  it('refuses a target that could change the query, before any request', async () => {
    const f = world(); f.stub();
    for (const t of [{ kind: 'table', table: 'x_loan^ORname=x' }, { kind: 'field', table: 'x_loan', field: 'u_status^OR1=1' }, { kind: 'script_include', name: 'a b' }, { kind: 'acl', name: 'x^y' }] as const) {
      expect(validTarget(t as any)).not.toBeNull();
      await expect(findReferences(inst, t as any)).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });

  it('a field: the scripts, UI policies, ACLs, notifications, reports and flows that use it, and nothing that merely looks alike', async () => {
    const f = world(); f.stub();
    const r = await findReferences(inst, { kind: 'field', table: 'x_loan', field: 'u_status' });
    expect(names(r)).toEqual([
      'ACL: x_loan.u_status', 'Business rule: Loan - by condition', 'Business rule: Loan - set due date', 'Client script: Loan status onChange',
      'Flow: Loan reminders', 'Notification: Loan overdue', 'Report: Loans by status', 'Script include: LoanUtils', 'UI policy: Show return date',
    ]);
    expect(r.refs.every((x) => x.link.startsWith('https://dev12345.service-now.com/'))).toBe(true);
    expect(r.refs.find((x) => x.name === 'Loan - set due date')!.match).toBe('reads u_status in script');
    expect(r.summary).toBe('4 scripts, 1 ACL, 1 UI policy, 1 flow, 1 report and 1 notification');
  });

  it("checks every hit itself, so a condition the instance ignores can't add false references", async () => {
    const f = world(); f.loose = true; f.stub();
    const r = await findReferences(inst, { kind: 'field', table: 'x_loan', field: 'u_status' });
    expect(names(r)).not.toContain('Business rule: Incident rule');
    expect(names(r)).not.toContain('Business rule: Loan - audit');
    expect(names(r)).not.toContain('Flow: Incident flow');
    expect(names(r)).not.toContain('Script include: Other');
  });

  it('a table: what runs on it, names it in code, points at it, or guards it', async () => {
    const f = world(); f.stub();
    const r = await findReferences(inst, { kind: 'table', table: 'x_loan' });
    const n = names(r);
    for (const want of ['Business rule: Loan - set due date', 'ACL: x_loan', 'ACL: x_loan.*', 'ACL: x_loan.u_status', 'Script include: LoanUtils', 'Reference field: x_loan_item.u_loan', 'Flow: Loan reminders'])
      expect(n).toContain(want);
    expect(n).not.toContain('Script include: Other');
    expect(n).not.toContain('Business rule: Incident rule');
  });

  it('a script include: its callers, scoped or not, and not lookalikes or itself', async () => {
    const f = world(); f.stub();
    const r = await findReferences(inst, { kind: 'script_include', name: 'LoanUtils' });
    expect(names(r)).toEqual(['Script include: Caller', 'Script include: Scoped caller']);
    expect(callsInclude('LoanUtils')("var ga = new GlideAjax('LoanUtils');")).toBe(true);
    expect(callsInclude('LoanUtils')('var ga = new LoanUtilsLegacy();')).toBe(false);
    expect(callsInclude('LoanUtils')('x_acme.LoanUtils.overdue(current);')).toBe(true);
    expect(callsInclude('LoanUtils')('a.b.LoanUtils.overdue();')).toBe(false);
  });

  it("uses the instance's code search when it has one", async () => {
    const f = world();
    f.codeSearch = [{ recordType: 'sys_script', hits: [{ name: 'Rule calling it', className: 'sys_script', sysId: id(90), matches: [{ field: 'script', lineMatches: [{ line: 3, context: 'new LoanUtils().due();' }] }] }, { name: 'Mentions only', className: 'sys_script', sysId: id(91), matches: [{ field: 'script', lineMatches: [{ line: 1, context: '// LoanUtils is old' }] }] }] }];
    f.stub();
    const r = await findReferences(inst, { kind: 'script_include', name: 'LoanUtils' });
    expect(names(r)).toEqual(['Business rule: Rule calling it']);
    expect(f.calls.some((c) => c.startsWith('/api/now/table/sys_script_include'))).toBe(false);
  });

  it('an ACL: its table and field, its roles, and the other ACLs deciding the same thing', async () => {
    const f = world(); f.stub();
    const r = await findReferences(inst, { kind: 'acl', name: 'x_loan.u_status', sys_id: id(30) });
    expect(names(r)).toEqual(['ACL: x_loan.*', 'Role: x_loan.manager', 'Table: x_loan']);
    expect(r.summary).toBe('1 ACL and 1 role'); // its own table isn't news
    expect(r.notes).toContain('Admins pass it anyway (admin overrides).');
  });

  it("says which searches it couldn't run instead of failing", async () => {
    const f = world(); f.denied.add('sys_report'); f.stub();
    const r = await findReferences(inst, { kind: 'field', table: 'x_loan', field: 'u_status' });
    expect(r.skipped).toEqual(["sys_report (this account can't read it)"]);
    expect(names(r)).not.toContain('Report: Loans by status');
  });

  it('summarises in plain words', () => {
    expect(summarize([]).text).toBe('nothing found');
    expect(summarize([{ kind: 'Flow' }, { kind: 'Business rule' }, { kind: 'Client script' }] as any).text).toBe('2 scripts and 1 flow');
  });
});
