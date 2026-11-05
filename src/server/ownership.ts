import { type Instance } from './db.ts';
import { table } from './sn.ts';

// What lives where on the instance: a record's name, type and owning application scope, and which scope owns a table.
// Read-only, a couple of batched queries per call. Used by Insights (grouping findings by script, scope and table) and
// shared with anything else that needs to know who owns what.

export interface Owned { sys_id: string; name: string; class: string; scope: string; scopeName: string; table?: string }

const SYS_ID = /^[0-9a-f]{32}$/;
const NAME = /^[a-z0-9_]{1,80}$/;

async function scopeNames(inst: Instance, ids: string[]): Promise<Map<string, { scope: string; name: string }>> {
  const want = [...new Set(ids.filter((i) => SYS_ID.test(i)))];
  const out = new Map<string, { scope: string; name: string }>();
  if (!want.length) return out;
  for (const r of await table(inst, 'sys_scope', `sys_idIN${want.join(',')}`, 'sys_id,scope,name', want.length).catch(() => [] as any[]))
    out.set(r.sys_id, { scope: r.scope || 'global', name: r.name || r.scope || 'Global' });
  return out;
}

// Application records (scripts, ACLs, UI policies…) by sys_id. Business rules also say which table they run on.
export async function ownersOf(inst: Instance, ids: string[]): Promise<Map<string, Owned>> {
  const want = [...new Set(ids.filter((i) => SYS_ID.test(i)))].slice(0, 100);
  const out = new Map<string, Owned>();
  if (!want.length) return out;
  const rows = await table(inst, 'sys_metadata', `sys_idIN${want.join(',')}`, 'sys_id,sys_name,sys_class_name,sys_scope', want.length);
  const scopes = await scopeNames(inst, rows.map((r) => r.sys_scope));
  for (const r of rows) {
    const s = scopes.get(r.sys_scope) ?? { scope: 'global', name: 'Global' };
    out.set(r.sys_id, { sys_id: r.sys_id, name: r.sys_name || r.sys_id, class: r.sys_class_name, scope: s.scope, scopeName: s.name });
  }
  const rules = [...out.values()].filter((o) => o.class === 'sys_script').map((o) => o.sys_id);
  if (rules.length) for (const r of await table(inst, 'sys_script', `sys_idIN${rules.join(',')}`, 'sys_id,collection', rules.length).catch(() => [] as any[])) {
    const o = out.get(r.sys_id);
    if (o && r.collection) o.table = r.collection;
  }
  return out;
}

// Which scope owns each table.
export async function tableScopes(inst: Instance, names: string[]): Promise<Map<string, { scope: string; scopeName: string; label: string }>> {
  const want = [...new Set(names.filter((n) => NAME.test(n)))].slice(0, 100);
  const out = new Map<string, { scope: string; scopeName: string; label: string }>();
  if (!want.length) return out;
  const rows = await table(inst, 'sys_db_object', `nameIN${want.join(',')}`, 'name,label,sys_scope', want.length);
  const scopes = await scopeNames(inst, rows.map((r) => r.sys_scope));
  for (const r of rows) {
    const s = scopes.get(r.sys_scope) ?? { scope: 'global', name: 'Global' };
    out.set(r.name, { scope: s.scope, scopeName: s.name, label: r.label || r.name });
  }
  return out;
}

// Customer updates name their record as <table>_<sys_id>; tables and fields have their own forms.
export function parseUpdateName(name: string): { table: string; sys_id?: string; field?: { table: string; element: string } } {
  const m = name.match(/^([a-z0-9_]+?)_([0-9a-f]{32})$/);
  if (m) return { table: m[1], sys_id: m[2] };
  if (name.startsWith('sys_db_object_')) return { table: 'sys_db_object', field: { table: name.slice('sys_db_object_'.length), element: '' } };
  return { table: name.replace(/_[^_]*$/, '') };
}
