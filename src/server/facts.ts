import { announce } from './events.ts';
import { instances, settings, type Instance } from './db.ts';
import { parse as parseAccess } from './access.ts';
import { sn, table } from './sn.ts';
import { isoDay } from './clock.ts';

// Instance facts Pip would otherwise spend tool calls discovering: release family, vendor prefix, whether ATF can
// run, and the API user's current update set. Read-only, cached 10 minutes per instance, put in the instructions.
export interface InstanceFacts { release: string | null; build: string | null; vendorPrefix: string | null; atfEnabled: boolean | null; updateSet: { sys_id: string; name: string } | null; at: number }

const cache = new Map<string, InstanceFacts>();
export const clearFacts = (instanceId: string) => cache.delete(instanceId);

export async function instanceFacts(inst: Instance): Promise<InstanceFacts> {
  const hit = cache.get(inst.id);
  if (hit && Date.now() - hit.at < 600_000) return hit;
  // The release family is in glide.war ("glide-australia-02-11-2026__patch3-…"); glide.buildname isn't a property on
  // most instances, so it's only a fallback.
  const props = await table(inst, 'sys_properties', 'nameINglide.war,glide.buildname,glide.appcreator.company.code,sn_atf.runner.enabled', 'name,value', 6).catch(() => []);
  const prop = (n: string) => (props as any[]).find((p) => p.name === n)?.value as string | undefined;
  const build = prop('glide.war') ?? prop('glide.buildname') ?? null;
  const release = releaseOf(build);
  const code = prop('glide.appcreator.company.code');
  const atf = prop('sn_atf.runner.enabled');
  const userId = parseAccess(inst)?.userId;
  let updateSet: InstanceFacts['updateSet'] = null;
  if (userId) {
    const [pref] = await table(inst, 'sys_user_preference', `user=${userId}^name=sys_update_set`, 'value', 1).catch(() => []);
    if (pref?.value) {
      const [set] = await table(inst, 'sys_update_set', `sys_id=${pref.value}`, 'sys_id,name', 1).catch(() => []);
      if (set) updateSet = { sys_id: set.sys_id, name: set.name };
    }
  }
  const facts: InstanceFacts = { release, build: build?.replace(/\.zip$/, '') ?? null, vendorPrefix: code ? `x_${code}_` : null, atfEnabled: atf === undefined ? null : atf === 'true', updateSet, at: Date.now() };
  cache.set(inst.id, facts);
  return facts;
}

// Which docs release answers should use: the setting, or the instance's own release when it's on "auto".
export function docsRelease(f: InstanceFacts | null, available: string[]): string {
  const want = settings.get().docsRelease;
  if (want && want !== 'auto') return want;
  if (f?.release && available.includes(f.release)) return f.release;
  return available[0] ?? 'australia';
}

export const activeFacts = async () => { const i = instances.active(); return i ? instanceFacts(i).catch(() => null) : null; };

export const releaseOf = (build: string | null | undefined) => build?.match(/glide-([a-z]+)/i)?.[1]?.toLowerCase() ?? null;

// Make an update set current for the connected account, and the matching application too, so changes land in the
// right scope. With `name` it reuses an in-progress set of that name in the app, or creates one.
export async function useUpdateSet(inst: Instance, opts: { sys_id?: string; name?: string; scope?: string }) {
  const me = parseAccess(inst)?.userId;
  if (!me) throw new Error('Check access in Settings first, so Wayfinder knows which account to set.');
  // Every row for this user and name is set: with a stray duplicate, ServiceNow could read the one left behind.
  const pref = async (name: string, value: string) => {
    const rows = await table(inst, 'sys_user_preference', `user=${me}^name=${name}`, 'sys_id,value', 10);
    if (!rows.length) await sn(inst, '/api/now/table/sys_user_preference', { method: 'POST', body: { user: me, name, value, type: 'string' } });
    for (const row of rows) if (row.value !== value) await sn(inst, `/api/now/table/sys_user_preference/${row.sys_id}`, { method: 'PATCH', body: { value } });
  };
  const appOf = (s: { application?: unknown }) => String((typeof s.application === 'object' ? (s.application as any)?.value : s.application) || 'global');
  let set: { sys_id: string; name: string; application: string } | undefined;
  let appId: string;
  if (opts.sys_id) {
    [set] = await table(inst, 'sys_update_set', `sys_id=${opts.sys_id}`, 'sys_id,name,application', 1);
    if (!set) throw new Error('That update set was not found.');
    // The current application decides where new records land (their sys_scope), so it always follows the set. A set
    // with no application belongs to global; skipping the switch then would leave whatever app was picked before.
    appId = appOf(set);
  } else {
    if (!opts.name?.trim()) throw new Error('Give the update set a name.');
    const scope = (opts.scope ?? 'global').trim();
    const [app] = await table(inst, 'sys_scope', `scope=${scope}`, 'sys_id,name', 1);
    if (!app) throw new Error(`No application with scope ${scope} on this instance.`);
    appId = app.sys_id;
    // ServiceNow files a new set under the account's current application, whatever the request says, so the app is
    // switched first. Otherwise picking Global while another app is current puts the set, and the work, in that app.
    await pref('apps.current_app', appId);
    [set] = await table(inst, 'sys_update_set', `state=in progress^application=${appId}^name=${opts.name.trim()}`, 'sys_id,name,application', 1);
    if (!set) {
      set = (await sn(inst, '/api/now/table/sys_update_set', { method: 'POST', body: { name: opts.name.trim(), application: appId, state: 'in progress' } })).result;
      if (appOf(set!) !== appId) {
        await sn(inst, `/api/now/table/sys_update_set/${set!.sys_id}`, { method: 'PATCH', body: { application: appId } });
        const [again] = await table(inst, 'sys_update_set', `sys_id=${set!.sys_id}`, 'sys_id,name,application', 1);
        if (!again || appOf(again) !== appId) throw new Error(`ServiceNow put the new update set "${opts.name.trim()}" in another application and wouldn't move it to ${app.name || scope}. Pick ${app.name || scope} in the application picker, then try again.`);
        set = again;
      }
    }
  }
  await pref('apps.current_app', appId);
  await pref('sys_update_set', set!.sys_id);
  clearFacts(inst.id);
  announce('instance', { updateSet: set!.name });
  // Read it back, so a switch that didn't take is reported now rather than found later in the wrong app.
  const now = await table(inst, 'sys_user_preference', `user=${me}^name=apps.current_app`, 'value', 10);
  const [app] = await table(inst, 'sys_scope', `sys_id=${appId}`, 'name,scope', 1);
  const application = app ? `${app.name} (${app.scope})` : appId;
  const switched = now.length > 0 && now.every((r) => r.value === appId);
  return {
    sys_id: set!.sys_id, name: set!.name, application, app_id: appId,
    ...(switched ? {} : { warning: `The update set is current, but the current application did not switch to ${application}. New records may land in another app: tell the user to pick ${application} in the application picker before making changes.` }),
  };
}

// ---- Write-back: a plain note of the work, appended to the update set's description ----
// Pip offers it at the end of Build work that changed records or scripts. The approval card shows the exact text and
// the set, and the policy binds both (policy.ts), so what was approved is what gets written.

export interface UpdateSetNote { changed: string[]; why: string; risk: string }
// Plain text only: tags and stray angle brackets are dropped (the description can be shown as HTML), and common
// entities read as what they stand for.
export const plain = (t: string) => t.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&(lt|gt|quot|#39);/gi, ' ');
const oneLine = (t: string, n: number) => plain(t).replace(/\s+/g, ' ').trim().slice(0, n);

// The header names the day and the connected account that wrote it, so a reader of the set knows whose work it was.
export function noteText(n: UpdateSetNote, at = new Date(), account?: string): string {
  const changed = n.changed.map((c) => oneLine(c, 160)).filter(Boolean).slice(0, 12);
  const who = account ? oneLine(account, 80) : '';
  return [`[Wayfinder ${isoDay(at)}${who ? ` · ${who}` : ''}]`, 'What changed:', ...changed.map((c) => `- ${c}`), `Why: ${oneLine(n.why, 300)}`, `Risk: ${oneLine(n.risk, 300)}`].join('\n');
}

// The old description with the note after a blank line; null when it won't fit the field.
export function withNote(old: string, note: string, max: number): string | null {
  const next = old.trim() ? `${old.trimEnd()}\n\n${note}` : note;
  return next.length <= max ? next : null;
}

// The account's current update set, read fresh (facts are cached for ten minutes and the user may have switched).
export async function currentUpdateSet(inst: Instance): Promise<{ sys_id: string; name: string } | null> {
  const userId = parseAccess(inst)?.userId;
  if (!userId) return null;
  const [pref] = await table(inst, 'sys_user_preference', `user=${userId}^name=sys_update_set`, 'value', 1).catch(() => []);
  if (!pref?.value) return null;
  // Each app has its own Default set (is_default), whatever it's called; a set merely named "Default" is not one.
  const [set] = await table(inst, 'sys_update_set', `sys_id=${pref.value}`, 'sys_id,name,state,is_default', 1).catch(() => []);
  return set && set.state === 'in progress' && String(set.is_default) !== 'true' ? { sys_id: set.sys_id, name: set.name } : null;
}

export async function appendNote(inst: Instance, sysId: string, note: string): Promise<{ name: string }> {
  const [set] = await table(inst, 'sys_update_set', `sys_id=${sysId}`, 'sys_id,name,description,state', 1);
  if (!set) throw new Error('That update set was not found.');
  if (set.state !== 'in progress') throw new Error(`"${set.name}" is no longer in progress, so it was left as it is.`);
  const [dict] = await table(inst, 'sys_dictionary', 'name=sys_update_set^element=description', 'max_length', 1).catch(() => []);
  const max = Number(dict?.max_length) || 4000;
  const next = withNote(String(set.description ?? ''), note, max);
  if (next === null) throw new Error(`The note doesn't fit: "${set.name}" has room for ${max} characters in its description. Make it shorter.`);
  await sn(inst, `/api/now/table/sys_update_set/${sysId}`, { method: 'PATCH', body: { description: next } });
  return { name: set.name };
}

// Where a record change would land right now: the account's current update set and application, both read fresh.
// Shown on approval cards (policy.ts). Null when Wayfinder doesn't know the account yet (access not checked).
export async function landsIn(inst: Instance): Promise<{ update_set: string; application: string } | null> {
  const userId = parseAccess(inst)?.userId;
  if (!userId) return null;
  const app = async () => {
    const [pref] = await table(inst, 'sys_user_preference', `user=${userId}^name=apps.current_app`, 'value', 1);
    const id = String(pref?.value || 'global');
    if (id === 'global') return 'Global (global)';
    const [s] = await table(inst, 'sys_scope', `sys_id=${id}`, 'name,scope', 1);
    return s ? `${s.name} (${s.scope})` : 'unknown';
  };
  const [set, application] = await Promise.all([currentUpdateSet(inst), app().catch(() => 'unknown')]);
  return { update_set: set?.name ?? 'Default (no named set)', application };
}
