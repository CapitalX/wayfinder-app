import { instances, type Instance } from './db.ts';
import { authHeader, sn } from './sn.ts';

// The access profile: what the signed-in account can actually do on this instance, judged by how the instance
// answers rather than by guessing. Grounded in the ServiceNow docs (REST APIs, australia):
// - an API user is "subject to access control in the same way as an interactive user";
// - a 403 is the instance's definite "not permitted";
// - rows and fields the caller can't see are silently left out, and sysparm_limit applies before ACLs, so an empty
//   result never proves "nothing there" (the profile only trusts 403 vs 200, never emptiness);
// - `javascript:gs.getUserID()` in a query identifies the caller for any user.
// Nothing here writes: write access is judged from roles when they're readable, otherwise learned from refusals.

export interface AccessProfile {
  user: string; userId: string;
  roles: string[] | null;          // null = this account can't read its own roles
  admin: boolean | null;           // null = unknown
  cicd: boolean;                   // CI/CD API answers (plugin and Store installs)
  reads: Record<string, boolean>;  // table → readable (by 403 vs 200 on a count)
  denied: string[];                // refusals learned from real calls, e.g. "write incident", "read sys_script"
  checkedAt: number;
}

const PROBES: Record<string, string> = {
  incident: 'incidents', sys_user: 'users', sys_script: 'business rules', syslog: 'system logs', sys_properties: 'system properties',
  v_plugin: 'plugins', sys_update_set: 'update sets', sys_app: 'custom apps', sys_db_object: 'table definitions',
  sys_update_xml: 'customer updates', sys_update_version: 'record versions', sys_dictionary: 'field definitions', sys_security_acl: 'ACLs',
};

async function status(inst: Instance, path: string): Promise<number> {
  try {
    const r = await fetch(inst.url + path, { headers: { Authorization: await authHeader(inst), Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    await r.arrayBuffer();
    return r.status;
  } catch { return 0; }
}

export async function checkAccess(inst: Instance): Promise<AccessProfile> {
  const [me] = (await sn(inst, '/api/now/table/sys_user?sysparm_query=sys_id=javascript:gs.getUserID()&sysparm_fields=sys_id,user_name&sysparm_limit=1')).result ?? [];
  let roles: string[] | null = null;
  try {
    const rows = (await sn(inst, '/api/now/table/sys_user_has_role?sysparm_query=user=javascript:gs.getUserID()%5Estate=active&sysparm_fields=role.name&sysparm_limit=500')).result as { 'role.name': string }[];
    // An empty list may just be ACL filtering; only a non-empty answer counts as knowing the roles.
    if (rows?.length) roles = [...new Set(rows.map((r) => r['role.name']).filter(Boolean))].sort();
  } catch { roles = null; }
  const reads: Record<string, boolean> = {};
  await Promise.all(Object.keys(PROBES).map(async (t) => { const s = await status(inst, `/api/now/stats/${t}?sysparm_count=true`); if (s) reads[t] = s !== 403; }));
  // CI/CD: a made-up progress id answers 404 to an allowed caller and 403 to one without the role.
  const cicdStatus = await status(inst, '/api/sn_cicd/progress/00000000000000000000000000000000');
  // Admin is asked of the instance itself: the same identity trick as above, answered only when gs.hasRole says so.
  // Role rows can be hidden and the aggregate API refused to an admin, so neither is a reliable "not admin".
  let admin: boolean | null = null;
  if (me) {
    try {
      const rows = (await sn(inst, `/api/now/table/sys_user?sysparm_query=${encodeURIComponent('sys_id=javascript:gs.hasRole("admin") ? gs.getUserID() : "none"')}&sysparm_fields=sys_id&sysparm_limit=1`)).result as { sys_id: string }[];
      admin = Array.isArray(rows) ? rows.some((r) => r.sys_id === me.sys_id) : null;
    } catch { admin = null; }
  }
  admin ??= roles ? roles.includes('admin') : (reads.sys_properties && reads.syslog && reads.sys_script ? true : null);
  const previous = parse(inst);
  const profile: AccessProfile = {
    user: me?.user_name ?? 'unknown', userId: me?.sys_id ?? '', roles, admin, cicd: cicdStatus !== 403 && cicdStatus !== 401 && cicdStatus !== 0,
    reads, denied: previous && previous.userId === me?.sys_id ? previous.denied : [], checkedAt: Date.now(),
  };
  instances.update(inst.id, { profile: JSON.stringify(profile) });
  return profile;
}

export function parse(inst: Instance | undefined): AccessProfile | null {
  try { return inst?.profile ? JSON.parse(inst.profile) as AccessProfile : null; } catch { return null; }
}

// What the account can do, in the terms the app's features need.
export function can(p: AccessProfile | null) {
  return {
    known: !!p,
    install: p ? p.cicd : true,           // plugins and Store apps (CI/CD API)
    build: p ? p.admin !== false && p.cicd : true, // installing scoped apps needs admin-level rights
    write: p ? p.admin === true || (p.roles?.some((r) => r !== 'snc_internal' && r !== 'snc_external') ?? true) : true,
  };
}

// A refusal from the instance on a real call: remember it so Pip doesn't try again.
export function learnRefusal(inst: Instance, what: string) {
  const p = parse(inst);
  if (!p || p.denied.includes(what)) return;
  p.denied = [...p.denied, what].slice(-30);
  instances.update(inst.id, { profile: JSON.stringify(p) });
}

// The profile as one paragraph for Pip's instructions.
export function describeAccess(p: AccessProfile | null): string {
  if (!p) return 'Access on this instance has not been checked yet; if a call is refused (403), say which role is likely missing instead of retrying.';
  const c = can(p);
  const yes = Object.entries(p.reads).filter(([, v]) => v).map(([t]) => PROBES[t] ?? t);
  const no = Object.entries(p.reads).filter(([, v]) => !v).map(([t]) => PROBES[t] ?? t);
  return [
    `Signed in as ${p.user}${p.admin ? ' (admin)' : ''}. ${p.roles ? `Roles: ${p.roles.slice(0, 25).join(', ')}${p.roles.length > 25 ? '…' : ''}.` : 'This account cannot read its own roles, so work from what it can and cannot reach.'}`,
    yes.length ? `Can read: ${yes.join(', ')}.` : '',
    no.length ? `Cannot read: ${no.join(', ')}; don't query those, say what role would be needed.` : '',
    c.install ? '' : 'It cannot install plugins or Store apps (no CI/CD access: needs admin or sn_cicd.sys_ci_automation); offer the click path instead.',
    c.build ? '' : 'It cannot install apps (Build mode can plan and build locally, but installing needs an admin account).',
    p.denied.length ? `The instance has already refused: ${p.denied.join('; ')}. Don't retry those.` : '',
    'An empty result can mean rows hidden by access rules, not that nothing exists; say so when it matters.',
  ].filter(Boolean).join(' ');
}
