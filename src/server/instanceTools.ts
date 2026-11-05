import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { settings, type Instance } from './db.ts';
import { sn, table, TABLE_NAME } from './sn.ts';
import { CREDENTIAL_TABLES, scrub, scrubText } from './scrub.ts';
import { INSTANCE_WRITES } from './instanceReads.ts';
import { removeScriptRunner, runScript, setupScriptRunner } from './scriptRunner.ts';

const tableName = z.string().regex(TABLE_NAME);
const sysId = z.string().regex(/^[0-9a-f]{32}$/);
const field = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/).max(240);
const fields = z.array(field).min(1).max(100);
const display = z.enum(['false', 'true', 'all']).default('false');
// Encoded queries can execute JavaScript on the server even on a GET. Permit only these complete, read-only calls.
const safeExpression = /^gs\.(?:(?:daysAgo|hoursAgo|minutesAgo|monthsAgo)\(\d{1,6}\)|(?:getUserID|now|beginningOfToday|endOfToday|beginningOfLast7Days|beginningOfThisMonth)\(\))$/;
const query = z.string().max(16000).refine((q) => q.split('^').every((part) => {
  const at = part.toLowerCase().indexOf('javascript:');
  return at < 0 || (part.slice(at, at + 11) === 'javascript:' && safeExpression.test(part.slice(at + 11)));
}), 'Query contains unsafe JavaScript expression; use a supported gs date helper or a literal value.').default('');
const recordFields = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
  .refine((f) => Object.keys(f).length > 0 && Object.keys(f).length <= 100, 'Supply 1–100 fields.');
const params = (values: Record<string, string | number | boolean>) => new URLSearchParams(Object.entries(values).map(([k, v]) => [k, String(v)])).toString();
const rows = (records: unknown[]) => ({ count: records.length, records });

async function schema(inst: Instance, name: string) {
  const chain: string[] = [];
  let current = name;
  while (current) {
    if (chain.includes(current) || chain.length >= 32) throw new Error('The table inheritance chain is cyclic or too deep.');
    tableName.parse(current);
    chain.push(current);
    const [row] = await table(inst, 'sys_db_object', `name=${current}`, 'name,super_class.name', 1);
    if (!row) throw new Error(`Cannot read table definition for ${current}.`);
    current = row['super_class.name'] || '';
  }
  const found = new Map<string, Record<string, unknown>>();
  // Closest definition wins, and every dictionary page is read before calling the schema complete.
  for (const owner of chain) {
    for (let offset = 0; ; offset += 500) {
      const result = await sn(inst, `/api/now/table/sys_dictionary?${params({
        sysparm_query: `name=${owner}^elementISNOTEMPTY^ORDERBYsys_id`,
        sysparm_fields: 'element,column_label,internal_type.name,reference,mandatory', sysparm_limit: 500,
        sysparm_offset: offset, sysparm_display_value: 'false', sysparm_exclude_reference_link: true,
      })}`);
      for (const f of result.result) if (!found.has(f.element)) found.set(f.element, {
        name: f.element, label: f.column_label, type: f['internal_type.name'], reference: f.reference,
        mandatory: f.mandatory === true || f.mandatory === 'true', inherited_from: owner === name ? undefined : owner,
      });
      if (result.result.length < 500) break;
    }
  }
  return [...found.values()];
}

// Pages fit inside the chat's 6000-character clip, including JSON escaping. Columns handle a single very long line.
function scriptPage(source: string, from: number, to: number | undefined, column: number) {
  const lines = scrubText(source).split(/\r?\n/);
  if (from > lines.length || column > lines[from - 1].length + 1) throw new Error('The requested line or column is past the end of the script.');
  const end = Math.min(to ?? lines.length, lines.length);
  if (end < from) throw new Error('to_line must be at least from_line.');
  let script = '', line = from, col = column;
  while (line <= end) {
    const rest = lines[line - 1].slice(col - 1) + (line < end ? '\n' : '');
    let take = Math.min(rest.length, 5000 - JSON.stringify(script).length);
    while (take > 0 && JSON.stringify(script + rest.slice(0, take)).length > 5000) take--;
    if (!take && rest.length) break;
    script += rest.slice(0, take);
    if (take < rest.length) { col += take; break; }
    line++; col = 1;
  }
  return { total_lines: lines.length, from_line: from, from_column: column, to_line: line > end ? end : line,
    script, ...(line <= end ? { next_from_line: line, next_from_column: col } : end < lines.length ? { next_from_line: end + 1, next_from_column: 1 } : {}) };
}

export function instanceServer(inst: Instance, writes = false) {
  const define = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (input: z.output<z.ZodObject<S>>) => Promise<unknown>) =>
    tool(name, description, shape, async (input) => {
      try {
        const parsed = z.object(shape).strict().parse(input);
        const target = (parsed as { table?: string }).table;
        if (target && CREDENTIAL_TABLES.has(target)) throw new Error(`${target} holds credentials, so Wayfinder doesn't access it.`);
        if (INSTANCE_WRITES.has(name) && (!writes || !settings.get().writeEnabled)) throw new Error('Instance writes are off in Settings or this mode.');
        if (name === 'run_script' && !settings.get().scriptingEnabled) throw new Error('Server-side scripting is off in Settings.');
        const text = JSON.stringify(scrub(await run(parsed)));
        return { content: [{ type: 'text' as const, text: text.length > 6000 ? text.slice(0, 6000) + `\n… (${text.length - 6000} more characters; request fewer records or fields)` : text }] };
      } catch (e) { return { content: [{ type: 'text' as const, text: scrubText(`Error: ${(e as Error).message}`).slice(0, 6000) }], isError: true }; }
    });
  return createSdkMcpServer({ name: 'instance', version: '1.0.0', tools: [
    define('query_records', 'Read records using an encoded query. Select fields and page with limit/offset; order is a list of fields, prefixed with - for descending.', {
      table: tableName, query, fields: fields.optional(), limit: z.number().int().min(1).max(1000).default(20),
      offset: z.number().int().min(0).max(1000000).default(0), order: z.array(z.string().regex(/^-?[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/)).max(10).optional(), display_value: display,
    }, async (i) => {
      const q = [i.query, ...(i.order ?? []).map((f) => f.startsWith('-') ? `ORDERBYDESC${f.slice(1)}` : `ORDERBY${f}`)].filter(Boolean).join('^');
      return rows((await sn(inst, `/api/now/table/${i.table}?${params({ sysparm_query: q, ...(i.fields ? { sysparm_fields: i.fields.join(',') } : {}), sysparm_limit: i.limit, sysparm_offset: i.offset, sysparm_display_value: i.display_value, sysparm_exclude_reference_link: true })}`)).result);
    }),
    define('get_record', 'Read one record by table and sys_id.', { table: tableName, sys_id: sysId, fields: fields.optional(), display_value: display }, async (i) =>
      rows([(await sn(inst, `/api/now/table/${i.table}/${i.sys_id}?${params({ ...(i.fields ? { sysparm_fields: i.fields.join(',') } : {}), sysparm_display_value: i.display_value, sysparm_exclude_reference_link: true })}`)).result])),
    define('count_records', 'Count records matching an encoded query.', { table: tableName, query }, async (i) => {
      const result = await sn(inst, `/api/now/stats/${i.table}?${params({ sysparm_query: i.query, sysparm_count: true })}`);
      const count = Number(result.result?.stats?.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('The instance returned no valid record count.');
      return { count };
    }),
    define('aggregate', 'Aggregate records: count and/or sum, avg, min, max of fields, optionally grouped by fields.', {
      table: tableName, query, group_by: fields.optional(), count: z.boolean().default(true),
      sum: fields.optional(), avg: fields.optional(), min: fields.optional(), max: fields.optional(),
    }, async (i) => {
      if (!i.count && ![i.sum, i.avg, i.min, i.max].some(Boolean)) throw new Error('Select at least one aggregate.');
      const p: Record<string, string | boolean> = { sysparm_query: i.query, sysparm_count: i.count, sysparm_display_value: 'false' };
      for (const op of ['group_by', 'sum', 'avg', 'min', 'max'] as const) if (i[op]) p[`sysparm_${op === 'group_by' ? op : `${op}_fields`}`] = i[op].join(',');
      const result = (await sn(inst, `/api/now/stats/${i.table}?${params(p)}`)).result;
      return rows(Array.isArray(result) ? result : [result]);
    }),
    define('get_table_schema', 'Read dictionary fields, types, references and mandatory flags, including inherited fields.', { table: tableName }, async (i) => rows(await schema(inst, i.table))),
    define('get_mandatory_fields', 'Read mandatory dictionary fields, including inherited fields (runtime UI policies may require more).', { table: tableName }, async (i) => rows((await schema(inst, i.table)).filter((f) => f.mandatory))),
    define('read_script', 'Read source from a script-bearing record (script include, business rule, client script, UI action, scheduled job or fix script). Supply sys_id or exact name. Follow next_from_line/next_from_column for long sources.', {
      table: tableName, sys_id: sysId.optional(), name: z.string().min(1).max(160).refine((s) => !/\^|javascript:/i.test(s)).optional(),
      from_line: z.number().int().min(1).default(1), to_line: z.number().int().min(1).optional(), from_column: z.number().int().min(1).default(1),
    }, async (i) => {
      if (!!i.sys_id === !!i.name) throw new Error('Supply exactly one of sys_id or name.');
      const records = await table(inst, i.table, i.sys_id ? `sys_id=${i.sys_id}` : `name=${i.name}`, 'sys_id,script', 2);
      if (records.length !== 1) throw new Error(records.length ? 'More than one script has that name; use sys_id.' : 'No matching script record.');
      if (typeof records[0].script !== 'string') throw new Error('Cannot read the script field. Check the table schema and access.');
      return { sys_id: records[0].sys_id, field: 'script', ...scriptPage(records[0].script, i.from_line, i.to_line, i.from_column) };
    }),
    define('create_record', 'Create one record. Always requires placement and approval.', { table: tableName, fields: recordFields }, async (i) =>
      rows([(await sn(inst, `/api/now/table/${i.table}`, { method: 'POST', body: i.fields })).result])),
    define('update_record', 'Update only the supplied fields of one record. Always requires placement and approval.', { table: tableName, sys_id: sysId, fields: recordFields }, async (i) =>
      rows([(await sn(inst, `/api/now/table/${i.table}/${i.sys_id}`, { method: 'PATCH', body: i.fields })).result])),
    define('delete_record', 'Delete one record. Always requires placement and approval.', { table: tableName, sys_id: sysId }, async (i) => {
      await sn(inst, `/api/now/table/${i.table}/${i.sys_id}`, { method: 'DELETE' });
      return { deleted: true, table: i.table, sys_id: i.sys_id };
    }),
    define('setup_script_runner', 'Install or reuse the exact admin-only script runner in global scope. Always asks for explicit approval.', {}, async () => setupScriptRunner(inst)),
    define('remove_script_runner', 'Remove only the saved script runner records. Always asks for approval.', { records: z.string().optional().describe('Bound by the approval card; omit.') }, async (i) => {
      if (!i.records) throw new Error('Ask for approval to remove the saved script runner records first.');
      return removeScriptRunner(inst, i.records);
    }),
    define('run_script', 'Run a server-side script like Scripts - Background and return output. Requires placement, scripting enabled and approval of the full script. If missing, offer setup_script_runner.', {
      script: z.string().min(1).max(100000), why: z.string().min(1).max(1000),
    }, async (i) => runScript(inst, i.script)),
  ].filter((t) => writes || !INSTANCE_WRITES.has(t.name)) });
}
