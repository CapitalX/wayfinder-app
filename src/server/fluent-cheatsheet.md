# Fluent cheat sheet (ServiceNow SDK 4.14.0). Every example here compiles. Use it instead of fluent_docs for these record types.
Files: Fluent in src/fluent/*.now.ts, server modules in src/server/*.ts. Never write src/fluent/generated/keys.ts (the build owns it).
Imports: `import { Table, StringColumn, ... } from '@servicenow/sdk/core'`. `Now` is global: never import it.
The build fails on unused imports and unused locals: import only what you use, and never assign a step/record result you don't read.
.now.ts files are declarative: imports, const/export declarations and API calls only. No loops, if, helper functions or inline arrow scripts (the one exception: the body of a Flow, Subflow or Action, see Flows).
Every API call needs `$id: Now.ID['unique-key']` (unique across the app), except Table, Role, Form and List. Never invent sys_ids.
Cross-file refs: export the const and import it (`import { loanUser } from './security.now'`). Pass the object itself (menu, role, record, test), not `.$id` or a name.
Arrays, never a single string: Acl/ApplicationMenu/module `roles`, BusinessRule `action`, ATF `roles`, TestSuite `tests`.
Names: tables `<scope>_<name>`, lowercase, at most 30 chars (the build doesn't check length). `export const <tableName> = Table({ name: '<tableName>' })`, same text.
Columns: snake_case, no prefix on your own tables, never `sys_`. Role names use a dot: `<scope>.<name>`.
For extends:'task', don't redeclare inherited fields (number, state, short_description, description, priority, assigned_to, due_date, active...). The build may accept it, but the install breaks.
Column/Record typos are silent: `required`/`readonly` are ignored (use `mandatory`/`readOnly`), and unknown Record data fields are dropped.
Use `operation: 'write'` for updates ('update' compiles but isn't an ACL operation).
Set `allowWebServiceAccess: true` on tables so REST/Table API checks work.

## Tables (tables.now.ts)
```ts
import { Table, StringColumn, ChoiceColumn, ReferenceColumn, IntegerColumn, BooleanColumn, DateColumn } from '@servicenow/sdk/core'
export const x_acme_loan_item = Table({
    name: 'x_acme_loan_item', label: 'Item', display: 'name', allowWebServiceAccess: true,
    schema: {
        name: StringColumn({ label: 'Name', mandatory: true, maxLength: 100 }),
        status: ChoiceColumn({ label: 'Status', default: 'available', choices: { available: 'Available', loaned: 'Loaned' } }),
        quantity: IntegerColumn({ label: 'Quantity', default: 1 }),
        active: BooleanColumn({ label: 'Active', default: true }),
    },
})
export const x_acme_loan_request = Table({
    name: 'x_acme_loan_request', label: 'Loan Request', extends: 'task', allowWebServiceAccess: true,
    autoNumber: { prefix: 'LNR', number: 1000, numberOfDigits: 7 },
    schema: {
        item: ReferenceColumn({ label: 'Item', referenceTable: 'x_acme_loan_item', mandatory: true }),
        borrower: ReferenceColumn({ label: 'Borrower', referenceTable: 'sys_user' }),
        return_by: DateColumn({ label: 'Return by' }),
    },
})
```
Other column types: DateTimeColumn, DecimalColumn, MultiLineTextColumn({maxLength:4000}), EmailColumn, UrlColumn, HtmlColumn, ListColumn({referenceTable}).
Choices are an object `{ key: 'Label' }`, never an array. A default and any Record value must be a key. Comments/work notes: `GenericColumn({ columnType: 'journal_input' })`.

## Roles and ACLs (security.now.ts). Give every table read/create/write/delete ACLs.
```ts
import { Role, Acl } from '@servicenow/sdk/core'
export const loanUser = Role({ name: 'x_acme_loan.user', description: 'Request loans' })
export const loanAdmin = Role({ name: 'x_acme_loan.admin', description: 'Manage items', containsRoles: [loanUser] })
Acl({ $id: Now.ID['item_read'], type: 'record', table: 'x_acme_loan_item', operation: 'read', roles: [loanUser] })
Acl({ $id: Now.ID['item_write'], type: 'record', table: 'x_acme_loan_item', operation: 'write', roles: [loanAdmin] })
// ...item_create, item_delete; field-level: add field: 'status'
```

## Menu and modules (menu.now.ts). Add a LIST module for each table, plus NEW where users create records.
```ts
import { ApplicationMenu, Record } from '@servicenow/sdk/core'
import { loanUser } from './security.now'
export const loanMenu = ApplicationMenu({ $id: Now.ID['menu'], title: 'Loaner', roles: [loanUser], active: true })
Record({ $id: Now.ID['mod_items'], table: 'sys_app_module',
    data: { title: 'Items', application: loanMenu, link_type: 'LIST', name: 'x_acme_loan_item', roles: [loanUser], active: true, order: 100 } })
```
Valid link_type values: LIST, NEW, FILTER (+ `filter: '<encoded query>'`), DIRECT (+ `query: 'page.do'`), SEPARATOR. Modules default to inactive, so always set `active: true`.

## Logic (logic.now.ts). Script values are a string or an imported module function.
```ts
import { BusinessRule, ScriptInclude, ClientScript, UiPolicy } from '@servicenow/sdk/core'
import { markLoaned } from '../server/loan-rules'   // src/server/loan-rules.ts: export function markLoaned(current: any, _previous: any) {...}
BusinessRule({ $id: Now.ID['br_default_return_by'], name: 'Default return date', table: 'x_acme_loan_request',
    when: 'before', action: ['insert'], order: 100,          // when: before|after|async|display
    script: `(function executeRule(current, previous) {
    if (current.return_by.nil()) { var d = new GlideDate(); d.addDaysUTC(14); current.setValue('return_by', d.getValue()); }
})(current, previous);` })
BusinessRule({ $id: Now.ID['br_mark_loaned'], name: 'Mark item loaned', table: 'x_acme_loan_request', when: 'after', action: ['insert'], script: markLoaned })
ScriptInclude({ $id: Now.ID['si_loan_utils'], name: 'LoanUtils', apiName: 'x_acme_loan.LoanUtils', accessibleFrom: 'package_private',
    script: `var LoanUtils = Class.create();
LoanUtils.prototype = { initialize: function() {}, openCount: function(id) { /* GlideRecord... */ return 0; }, type: 'LoanUtils' };` })
ClientScript({ $id: Now.ID['cs_item_hint'], name: 'Item hint', table: 'x_acme_loan_request', type: 'onChange', field: 'item', uiType: 'all',
    script: `function onChange(control, oldValue, newValue, isLoading) { if (isLoading || !newValue) return; g_form.showFieldMsg('item', 'Check the date', 'info'); }` })
UiPolicy({ $id: Now.ID['up_borrower'], table: 'x_acme_loan_request', shortDescription: 'Borrower mandatory when item set',
    conditions: 'itemISNOTEMPTY', onLoad: true, reverseIfFalse: true, actions: [{ field: 'borrower', mandatory: true }] })
```
ScriptInclude, ClientScript and UiPolicy take strings only (or `Now.include('../server/x.js')`, a path relative to the .now.ts file). A Script Include's `type` must equal its class name and `name`.
In a before rule, change `current` directly and never call `current.update()`. To abort: `current.setAbortAction(true)`.

## Sample data (data.now.ts): always mark it as demo data
```ts
import { Record } from '@servicenow/sdk/core'
export const tent = Record({ $id: Now.ID['item_tent'], $meta: { installMethod: 'demo' }, table: 'x_acme_loan_item',
    data: { name: 'Tent', status: 'available', quantity: 2, active: true } })
Record({ $id: Now.ID['req_1'], $meta: { installMethod: 'demo' }, table: 'x_acme_loan_request',
    data: { short_description: 'Tent for the weekend', item: tent, return_by: '2026-12-01' } })
```
Numbers as numbers. Date 'YYYY-MM-DD', date-time 'YYYY-MM-DD HH:mm:ss'. A reference takes the exported Record or a real sys_id.

## ATF (tests.now.ts): one test per rule (cover both sides where there are two), plus one TestSuite holding them all
```ts
import { Test, TestSuite } from '@servicenow/sdk/core'
import { loanUser } from './security.now'
export const loanMarksItem = Test(
    { $id: Now.ID['t_loan_marks_item'], name: 'New loan marks item loaned', failOnServerError: true, description: 'What it checks and how.' },
    (atf) => {
        atf.server.createUser({ $id: Now.ID['t1_user'], firstName: 'ATF', lastName: 'User', roles: [loanUser], impersonate: true })
        const item = atf.server.recordInsert({ $id: Now.ID['t1_item'], table: 'x_acme_loan_item', fieldValues: { name: 'Kayak', status: 'available' }, enforceSecurity: false })
        atf.server.recordInsert({ $id: Now.ID['t1_req'], table: 'x_acme_loan_request', fieldValues: { short_description: 'ATF loan', item: item.record_id } })
        atf.server.recordValidation({ $id: Now.ID['t1_check'], table: 'x_acme_loan_item', recordId: item.record_id, fieldValues: 'status=loaned' })
    })
export const loanSuite = TestSuite({ $id: Now.ID['suite_loaner'], name: 'Loaner tests', tests: [loanMarksItem] })
```
Every step needs its own $id. recordValidation's `fieldValues` is an encoded query string. Pass Role objects to createUser.
Script Include test: `atf.server.runServerSideScript({ $id, script: '(function(outputs, steps, params, stepResult, assertEqual){ ... assertEqual({name, shouldbe, value}); })(outputs, steps, params, stepResult, assertEqual);' })`.

## Flows: custom Action, Subflow, a subflow calling a subflow (flows.now.ts)
```ts
import { Action, Subflow, wfa, actionStep, action } from '@servicenow/sdk/automation'
import { StringColumn, IntegerColumn, BooleanColumn } from '@servicenow/sdk/core'
// Action: wfa.actionStep(actionStep.*) calls in order, then assignActionOutputs. No flowLogic, no wfa.action/subflow inside.
export const countOpenLoans = Action({ $id: Now.ID['act_count_open_loans'], name: 'Count open loans',
    inputs: { item_id: StringColumn({ label: 'Item sys_id', mandatory: true }) },
    outputs: { open_count: IntegerColumn({ label: 'Open loans' }) },
}, (params) => {
    const counted = wfa.actionStep(actionStep.script, { $id: Now.ID['step_count_open'], label: 'Count open requests' }, {
        required_run_time: 'instance',
        script: `(function execute(inputs, outputs) {
    var gr = new GlideRecordSecure('x_acme_loan_request');   // only rows the caller may read; GlideAggregate skips ACLs
    gr.addQuery('item', inputs.item_id); gr.addActiveQuery(); gr.query();
    var n = 0; while (gr.next()) n++;
    outputs.open_count = n;
})(inputs, outputs);`,
        inputVariables: { item_id: { label: 'Item sys_id', value: wfa.dataPill(params.inputs.item_id, 'string') } },
        outputVariables: { open_count: IntegerColumn({ label: 'Open loans', default: '0' }) },
    })
    wfa.assignActionOutputs(params.outputs, { open_count: wfa.dataPill(counted.open_count, 'integer') })
})
// Subflow: typed inputs/outputs, no trigger. Its body may use flowLogic, actions and other subflows. Assign outputs on every path.
export const itemAvailability = Subflow({ $id: Now.ID['sf_item_availability'], name: 'Item availability', runAs: 'user',
    inputs: { item_id: StringColumn({ label: 'Item sys_id', mandatory: true }) },
    outputs: { available: BooleanColumn({ label: 'Available' }), open_count: IntegerColumn({ label: 'Open loans' }) },
}, (params) => {
    const counted = wfa.action(countOpenLoans, { $id: Now.ID['call_count_open'], annotation: 'Count open loans' }, { item_id: wfa.dataPill(params.inputs.item_id, 'string') })
    wfa.flowLogic.if({ $id: Now.ID['if_none_open'], condition: `${wfa.dataPill(counted.open_count, 'integer')}=0` }, () => {
        wfa.flowLogic.assignSubflowOutputs({ $id: Now.ID['out_available'] }, params.outputs, { available: true, open_count: 0 })
    })
    wfa.flowLogic.else({ $id: Now.ID['else_open'] }, () => {
        wfa.flowLogic.assignSubflowOutputs({ $id: Now.ID['out_loaned'] }, params.outputs,
            { available: false, open_count: wfa.dataPill(counted.open_count, 'integer') })
    })
})
// Calling a subflow: waitForCompletion goes in the inputs (third argument), not the config. Built-in actions: action.core.*.
export const checkItem = Subflow({ $id: Now.ID['sf_check_item'], name: 'Check item', runAs: 'user',
    inputs: { item_id: StringColumn({ label: 'Item sys_id', mandatory: true }) },
    outputs: { summary: StringColumn({ label: 'Summary', maxLength: 200 }) },
}, (params) => {
    const avail = wfa.subflow(itemAvailability, { $id: Now.ID['call_availability'] },
        { item_id: wfa.dataPill(params.inputs.item_id, 'string'), waitForCompletion: true })
    wfa.action(action.core.log, { $id: Now.ID['log_check'] }, { log_level: 'info', log_message: `Open loans: ${wfa.dataPill(avail.open_count, 'integer')}` })
    wfa.flowLogic.assignSubflowOutputs({ $id: Now.ID['out_summary'] }, params.outputs, { summary: `Available: ${wfa.dataPill(avail.available, 'boolean')}` })
})
```
Steps inside an Action are `wfa.actionStep(actionStep.<step>, ...)` (`wfa.step` doesn't exist). In a Flow or Subflow use `wfa.action(action.core.<action>, ...)`. The two use different parameter names (`actionStep.createRecord` takes `create_record_table_name`; `action.core.createRecord` takes `table_name`), so never copy one's inputs to the other.
Data pills go straight into the value: `wfa.dataPill(params.inputs.x, 'string')` or `${wfa.dataPill(...)}` in a template. Never store a pill in a const; keep the step/action/subflow result in a const and read pills from it (`counted.open_count`).
Only `actionStep.script` takes `inputVariables` (`{ label, value }`) and `outputVariables` (columns); its script reads `inputs.<name>` and sets `outputs.<name>`, and `required_run_time: 'instance'` is mandatory. Booleans in assignActionOutputs are `'1'`/`'0'`.
Also proven (a real app with one subflow per tool): a long script can sit in a module-level const string and be passed as `script: routeScript` (only pills can't be kept in a const); action inputs take literals as well as pills (`tool_name: 'get_record'`), and optional inputs can simply be left out; a BooleanColumn subflow output can be fed from a string pill whose script sets `'true'`/`'false'`.
`runAs: 'user'` doesn't make a script step respect ACLs by itself: GlideRecord inside a script skips them. Use GlideRecordSecure (or `canRead()`/`canWrite()`) for anything the caller's rights should limit, counts included: GlideAggregate has no secure form, so count readable rows with GlideRecordSecure.
Many similar subflows (e.g. one per tool): write each one out in full with literal `Now.ID['...']` keys. A function that builds them, typed parameters or computed keys don't build. Shared logic goes in one Action or a Script Include the script steps call.
Errors: "Property 'step' does not exist on type 'typeof wfa'" means use wfa.actionStep. "FlowInstancePlugin/StepInstancePlugin failed to transform … invalid value (type: symbol): undefined" plus TS211 "wfa.dataPill: failed to resolve" means a data pill was stored in a const. TS150/TS154 "Node kind NumberKeyword/StringKeyword is not allowed" means a type annotation (`: number`, `(key: string)`) in a .now.ts file. TS213 "must be used inside a Flow or Subflow body" means flowLogic in an Action.
Subflows run as the user who starts them (`runAs: 'user'`), so the caller's ACLs apply. `runAs: 'system'` skips every ACL: use it only when the user asks for it, and say why in the plan.
More: fluent_docs topics `subflow` (subflow-api), `subflow-guide`, `action` (custom-action-api, every actionStep's parameters), `flow-actions` (action.core), `flow-logic`, `trigger`, `flow`.
When Fluent can't express a step: put the logic in a Script Include and call it from one `actionStep.script` step (always expressible), or call an existing subflow/action by its sys_id string (`wfa.subflow('<sys_id>', { $id }, {...})`, read the sys_id from the instance, never invent one). Only if neither fits: install what builds, then tell the user exactly what to add in Flow Designer. Don't hand-write sys_hub_* records through the Table API: their bodies are packed JSON tied to generated ids, which is very hard to get right by hand.

## Optional default form and list (ui.now.ts)
```ts
import { Form, List, default_view } from '@servicenow/sdk/core'
Form({ table: 'x_acme_loan_item', view: default_view, sections: [{ caption: 'Item', content: [
    { layout: 'one-column', elements: [{ field: 'name', type: 'table_field' }, { field: 'status', type: 'table_field' }] }] }] })
List({ table: 'x_acme_loan_item', view: default_view, columns: ['name', 'status', 'quantity'] })
```

## Reading build errors
`file:line:col - error TSnnn: msg`. Codes under 1000 (TS11, TS213, TS244, TS250, TS303) are Fluent rule errors; 2000+ are TypeScript type errors. Read the last line of the chain.
"Failed to determine ID" means a `$id` is missing. "is defined 2 times" means a duplicate Now.ID key. "Did you mean" gives the fix. Fix every error, then build once.
Deleting a record's code makes the next install delete it from the instance (keys.ts tracks it), so ask the user before removing records.
Docs known wrong: application-menu-guide (module roles are an array, `application: menu` not `menu.$id`), now-id-guide (`action: 'insert'` must be an array), table-api "Extending Task" example (export name must equal table name). `explain menu` returns SPMenu (portal), so use applicationmenu-api.
