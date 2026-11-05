import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { audit, chats, fullPermissions, instances, settings, type Instance } from './db.ts';
import { instanceFacts, useUpdateSet } from './facts.ts';
import { tableScopes } from './ownership.ts';
import { table } from './sn.ts';
import { parse as parseAccess } from './access.ts';
import { lockInstance } from './instanceLock.ts';
import { loadSkills, noLinks, parseSkill, SHIPPED_DIR, USER_DIR, type SkillSet } from './skills.ts';
import { announce } from './events.ts';
import { quoted } from './prompts.ts';

// Where a piece of work should live: the app you're in, the app that owns the table, a new custom app, or global.
// The rules are the `placement` skill (shipped, or the user's own); `place()` applies them to facts looked up on the
// instance. Before the first instance change in a chat, Pip shows the result as a card and stops; the user's click
// settles it (switching the update set when needed), and policy.ts refuses record changes until then.

export type Place = 'current-app' | 'owning-app' | 'new-app' | 'global';
const PLACES: Place[] = ['current-app', 'owning-app', 'new-app', 'global'];
export const CONDITIONS = ['new-tables', 'adds-to-current-app', 'table-in-current-app', 'table-in-other-app', 'table-in-global', 'no-tables', 'current-is-app', 'current-is-global', 'always'] as const;
type Condition = (typeof CONDITIONS)[number];

export interface Rule { id: string; if: { cond: Condition; not: boolean }[]; place: Place; why: string; warn?: string; cite?: string }
export interface App { scope: string; name: string }
export interface PlaceFacts {
  tables: { name: string; scope: string | null; scopeName?: string }[]; // owning scope; null when the table isn't there yet
  newTables: boolean;
  addsToCurrentApp: boolean;
  current: App | null; // the app the current update set belongs to; null = unknown
}
export interface Home { place: Place; scope: string | null; name: string }
export interface Placement { home: Home; rule: string; why: string; warn?: string; cite?: string; alternatives: Home[]; mismatch?: string }

// `## id` sections with `key: value` lines; anything before the first section is prose for Pip.
const httpsOnly = (url: string): string | undefined => { try { return new URL(url).protocol === 'https:' ? url : undefined; } catch { return undefined; } };

export function parseRules(body: string): { rules: Rule[]; warnings: string[] } {
  const rules: Rule[] = [], warnings: string[] = [];
  for (const section of body.split(/^## /m).slice(1)) {
    const [head, ...lines] = section.split(/\r?\n/);
    const id = head.trim();
    const f: Record<string, string> = {};
    for (const l of lines) { const m = /^([a-z]+):\s*(.*)$/.exec(l.trim()); if (m) f[m[1]] = m[2].trim(); }
    const bad = (why: string) => warnings.push(`Placement rule "${id}" ${why}; skipped.`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) { bad('needs an id of lowercase letters, digits and dashes'); continue; }
    if (rules.some((r) => r.id === id)) { bad('appears twice'); continue; }
    if (!PLACES.includes(f.place as Place)) { bad(`has place "${f.place ?? ''}" (one of ${PLACES.join(', ')})`); continue; }
    if (!f.why) { bad('needs a why'); continue; }
    const conds = (f.if ?? '').split(',').map((c) => c.trim()).filter(Boolean).map((c) => ({ cond: c.replace(/^!\s*/, '') as Condition, not: c.startsWith('!') }));
    const unknown = conds.find((c) => !CONDITIONS.includes(c.cond));
    if (!conds.length) { bad('needs an if (use "always" for a catch-all)'); continue; }
    if (unknown) { bad(`has an unknown condition "${unknown.cond}"`); continue; }
    // The cite becomes a link on the card, so only an https address is kept; anything else is dropped with a warning.
    const cite = f.cite ? httpsOnly(f.cite) : undefined;
    if (f.cite && !cite) warnings.push(`Placement rule "${id}" has a cite that isn't an https link; the link was dropped.`);
    rules.push({ id, if: conds, place: f.place as Place, why: f.why, ...(f.warn ? { warn: f.warn } : {}), ...(cite ? { cite } : {}) });
  }
  return { rules, warnings };
}

export function placementRules(set: SkillSet = loadSkills()): { rules: Rule[]; warnings: string[]; origin: 'shipped' | 'yours' | null } {
  const skill = set.skills.find((s) => s.name === 'placement');
  if (!skill) return { rules: [], warnings: ['There is no placement skill, so placement falls back to the app you are in.'], origin: null };
  const parsed = parseRules(skill.body);
  if (!parsed.rules.length) parsed.warnings.push('The placement skill has no usable rules, so placement falls back to the app you are in.');
  return { ...parsed, origin: skill.origin };
}

const isGlobal = (scope: string | null | undefined) => !scope || scope === 'global';

function holds(cond: Condition, f: PlaceFacts): boolean {
  const cur = f.current?.scope;
  switch (cond) {
    case 'always': return true;
    case 'new-tables': return f.newTables;
    case 'adds-to-current-app': return f.addsToCurrentApp;
    case 'no-tables': return !f.tables.some((t) => t.scope);
    case 'current-is-app': return !!f.current && !isGlobal(cur);
    case 'current-is-global': return !!f.current && isGlobal(cur);
    case 'table-in-current-app': return !!f.current && !isGlobal(cur) && f.tables.some((t) => t.scope === cur);
    case 'table-in-other-app': return f.tables.some((t) => t.scope && !isGlobal(t.scope) && t.scope !== cur);
    case 'table-in-global': return f.tables.some((t) => t.scope === 'global');
  }
}

function resolve(place: Place, f: PlaceFacts): Home | null {
  if (place === 'new-app') return { place, scope: null, name: 'A new custom app' };
  if (place === 'global') return { place, scope: 'global', name: 'Global' };
  if (place === 'owning-app') {
    const t = f.tables.find((x) => x.scope && !isGlobal(x.scope) && x.scope !== f.current?.scope);
    return t ? { place, scope: t.scope, name: t.scopeName ?? t.scope! } : null;
  }
  if (!f.current) return null;
  return isGlobal(f.current.scope) ? { place: 'global', scope: 'global', name: 'Global' } : { place, scope: f.current.scope, name: f.current.name };
}

// Pure: the first rule whose conditions all hold and whose place resolves wins. With no rules (or none matching), the
// work stays where it is.
export function place(f: PlaceFacts, rules: Rule[]): Placement {
  let hit: { rule: Rule; home: Home } | undefined;
  for (const rule of rules) {
    if (!rule.if.every((c) => holds(c.cond, f) !== c.not)) continue;
    const home = resolve(rule.place, f);
    if (home) { hit = { rule, home }; break; }
  }
  const home = hit?.home ?? resolve('current-app', f) ?? { place: 'new-app' as Place, scope: null, name: 'A new custom app' };
  const options = PLACES.map((p) => resolve(p, f)).filter((h): h is Home => !!h);
  const alternatives = options.filter((h, i) => h.scope !== home.scope && options.findIndex((o) => o.scope === h.scope) === i);
  const other = f.tables.find((t) => t.scope && f.current && t.scope !== f.current.scope && !isGlobal(t.scope));
  return {
    home, alternatives,
    rule: hit?.rule.id ?? 'none', why: hit?.rule.why ?? 'No rule matched, so it stays where you are.',
    ...(hit?.rule.warn ? { warn: hit.rule.warn } : {}), ...(hit?.rule.cite ? { cite: hit.rule.cite } : {}),
    ...(other && f.current ? { mismatch: `You're in ${f.current.name}, but ${other.name} belongs to ${other.scopeName ?? other.scope}.` } : {}),
  };
}

// The app the current update set belongs to.
export async function currentApp(inst: Instance): Promise<App | null> {
  const id = (await instanceFacts(inst).catch(() => null))?.updateSet?.sys_id;
  if (!id || !/^[0-9a-f]{32}$/.test(id)) return { scope: 'global', name: 'Global' };
  const [set] = await table(inst, 'sys_update_set', `sys_id=${id}`, 'application.name,application.scope', 1).catch(() => [] as any[]);
  return set ? { scope: set['application.scope'] || 'global', name: set['application.name'] || 'Global' } : null;
}

export async function gatherFacts(inst: Instance, ask: { tables: string[]; new_tables: boolean; adds_to_current_app: boolean }): Promise<PlaceFacts> {
  const [owners, current] = await Promise.all([tableScopes(inst, ask.tables), currentApp(inst)]);
  return {
    tables: ask.tables.map((name) => { const o = owners.get(name); return { name, scope: o?.scope ?? null, ...(o ? { scopeName: o.scopeName } : {}) }; }),
    newTables: ask.new_tables, addsToCurrentApp: ask.adds_to_current_app, current,
  };
}

// What's kept on the chat: the card waiting for a choice (and, for the moment one click is being handled, choosing),
// then the choice. Each is for one instance: moving the chat to another instance asks again. A new app also keeps which
// app was current when it was chosen (from), so writes wait until a newer app exists and is current.
export interface Pending { status: 'pending'; id: string; instance_id: string; work: string; update_set: string; placement: Placement; at: number }
type Choosing = Omit<Pending, 'status'> & { status: 'choosing' };
export interface Settled { status: 'settled'; id: string; instance_id: string; work: string; home: Home; by: 'accept' | 'other' | 'new-app'; update_set?: string; update_set_id?: string; app_id?: string; warning?: string; from?: string | null; at: number }
export type ChatPlacement = Pending | Choosing | Settled;

export function chatPlacement(chatId: string): ChatPlacement | null {
  const raw = chats.get(chatId)?.placement;
  if (!raw) return null;
  try { return JSON.parse(raw) as ChatPlacement; } catch { return null; }
}
// Settled for this instance. Rows from before placements carried an instance count as not settled, so they ask again.
export const settledHere = (chatId: string, instanceId: string | null): Settled | null => {
  const p = chatPlacement(chatId);
  return p?.status === 'settled' && !!instanceId && p.instance_id === instanceId ? p : null;
};

// The gate policy.ts applies before any record change: null = go ahead, otherwise why not. A new custom app counts as
// settled only once an app created after the choice is the current one; then the chat's home becomes that app.
export async function writeGate(chatId: string, inst: Instance | undefined): Promise<string | null> {
  const p = settledHere(chatId, inst?.id ?? null);
  if (!inst || !p) {
    const other = chatPlacement(chatId);
    return other?.status === 'settled' && !!other.instance_id && other.instance_id !== inst?.id
      ? "Where this work lives was settled for another instance. Call pdi placement again for this one, then stop and wait for the user's choice."
      : "Settle where this work lives first: call pdi placement, then stop and wait for the user to pick on the card.";
  }
  if (p.home.place !== 'new-app') return null;
  const app = await newAppReady(inst, p).catch(() => null);
  if (!app) return 'The user chose a new custom app for this work, so nothing changes on the instance from here until that app exists and is the current app. Build it in Build mode first; if the user changes their mind, call pdi placement again.';
  const upgraded: Settled = { ...p, home: { place: 'current-app', scope: app.scope, name: app.name } };
  chats.update(chatId, { placement: JSON.stringify(upgraded) });
  audit.add(chatId, inst.id, 'placement', { work: p.work, new_app: app }, 'new app is current');
  return null;
}

// Another chat on the same account may have switched the current update set or app since this chat settled, so before
// each write (with the instance held, instanceLock.ts) this puts the chat's own back and reads both back. null = in
// place; otherwise why the write must not run. shortcut: a new-app home has no update set of its own here, so only
// the app the user made current counts; pin its set too if parallel new-app work turns out to be common.
export async function ensurePlace(chatId: string, inst: Instance): Promise<string | null> {
  const raw = chats.get(chatId)?.placement ?? '';
  const p = settledHere(chatId, inst.id);
  const me = parseAccess(inst)?.userId;
  if (!p) return "Where this work lives isn't settled for this instance any more. Call pdi placement again and wait for the user's choice.";
  if (!p.update_set || !p.home.scope) return null; // a new-app home: see the shortcut above
  if (!me) return "Wayfinder can't tell which account to check (run Check access in Settings), so the change did not run.";
  const read = () => table(inst, 'sys_user_preference', `user=${me}^nameINsys_update_set,apps.current_app`, 'name,value', 20);
  const holds = (rows: any[], setId?: string, appId?: string) => !!setId && !!appId && rows.some((r) => r.name === 'sys_update_set') && rows.some((r) => r.name === 'apps.current_app')
    && rows.every((r) => r.value === (r.name === 'sys_update_set' ? setId : appId));
  try {
    if (holds(await read(), p.update_set_id, p.app_id)) return null;
    // Only an in-progress set takes changes; one completed meanwhile is never made current again.
    const gone = `The update set "${p.update_set}" is no longer in progress, so nothing was changed. Call pdi placement again and wait for the user's choice.`;
    if (p.update_set_id) {
      const [s] = await table(inst, 'sys_update_set', `sys_id=${p.update_set_id}`, 'state', 1);
      if (s?.state !== 'in progress') return gone;
    } else {
      // A choice saved before ids were kept: find its set by name, and never let a lookup quietly create a new one.
      const [s] = await table(inst, 'sys_update_set', `state=in progress^name=${p.update_set}^application.scope=${p.home.scope}`, 'sys_id', 1);
      if (!s) return gone;
    }
    const set = await useUpdateSet(inst, p.update_set_id ? { sys_id: p.update_set_id } : { name: p.update_set, scope: p.home.scope });
    if (set.warning || !holds(await read(), set.sys_id, set.app_id)) return `Couldn't make "${p.update_set}" in ${p.home.name} current again for this chat, so the change did not run. ${set.warning ?? 'Ask again in a moment.'}`;
    if (set.sys_id !== p.update_set_id || set.app_id !== p.app_id) chats.swapPlacement(chatId, raw, JSON.stringify({ ...p, update_set_id: set.sys_id, app_id: set.app_id }));
    audit.add(chatId, inst.id, 'update set', { name: set.name, application: set.application, why: 'Another chat had switched it; put back before this chat\'s change' }, 'put back');
    return null;
  } catch (e) {
    return `Couldn't check this chat's update set on the instance (${(e as Error).message}), so the change did not run.`;
  }
}

// An approved switch later in the chat (pdi use_update_set) moves this chat's place with it, so ensurePlace keeps the
// new set rather than putting the old one back.
export function movePlace(chatId: string, instanceId: string, set: { sys_id: string; name: string; app_id: string }, scope: string) {
  const raw = chats.get(chatId)?.placement ?? '';
  const p = settledHere(chatId, instanceId);
  if (!p) return;
  const home: Home = p.home.scope === scope ? p.home : { place: isGlobal(scope) ? 'global' : 'current-app', scope, name: scope };
  chats.swapPlacement(chatId, raw, JSON.stringify({ ...p, home, update_set: set.name, update_set_id: set.sys_id, app_id: set.app_id } satisfies Settled));
}

// The current app, if it was created after the choice and isn't the one that was current then.
async function newAppReady(inst: Instance, p: Settled): Promise<App | null> {
  const cur = await currentApp(inst);
  if (!cur || isGlobal(cur.scope) || cur.scope === p.from) return null;
  const [row] = await table(inst, 'sys_app', `scope=${cur.scope}`, 'sys_created_on', 1);
  const created = row?.sys_created_on ? Date.parse(`${String(row.sys_created_on).replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(created) && created >= p.at - 5 * 60_000 ? cur : null;
}

export function offer(chatId: string, instanceId: string, work: string, updateSet: string, p: Placement): Pending {
  const pending: Pending = { status: 'pending', id: randomUUID(), instance_id: instanceId, work, update_set: updateSet, placement: p, at: Date.now() };
  chats.update(chatId, { placement: JSON.stringify(pending) });
  announce('chats', { id: chatId });
  return pending;
}

// The user's click. Only the card on the chat right now can be answered, once; "other" must name an app that's on the
// instance. A home in an app switches to the named update set there (audited, as the user's choice); a new app
// switches nothing and hands over to Build mode.
export async function choose(inst: Instance, chatId: string, cardId: string, choice: { by: Settled['by']; scope?: string; auto?: boolean }): Promise<Settled> {
  const checkAuto = () => {
    const live = instances.get(inst.id);
    if (choice.auto && (choice.by !== 'accept' || !fullPermissions(live) || live?.url !== inst.url || !settings.get().writeEnabled || chats.get(chatId)?.mode !== 'build'))
      throw new Error('Full permissions placement requires an active developer instance, changes enabled, and Build mode.');
  };
  checkAuto();
  const raw = chats.get(chatId)?.placement ?? '';
  const now = chatPlacement(chatId);
  if (!now || now.status !== 'pending' || now.id !== cardId) throw new Error('That card was already answered or replaced.');
  if (now.instance_id !== inst.id) throw new Error('This card was for another instance; ask Pip again.');
  const scope = String(choice.scope ?? '').trim();
  if (choice.by === 'other' && !/^[a-z0-9_]{1,40}$/.test(scope)) throw new Error('Pick an application.');
  // Claim the card before anything slow: a second click finds it no longer pending, so the update set switches once.
  const claimed = JSON.stringify({ ...now, status: 'choosing' } satisfies Choosing);
  if (!chats.swapPlacement(chatId, raw, claimed)) throw new Error('That card was already answered or replaced.');
  let done: Settled;
  try {
    let home: Home, from: string | null | undefined;
    if (choice.by === 'accept') home = now.placement.home;
    else if (choice.by === 'new-app') { home = { place: 'new-app', scope: null, name: 'A new custom app' }; from = (await currentApp(inst))?.scope ?? null; }
    else {
      const [app] = scope === 'global' ? [{ scope: 'global', name: 'Global' }] : await table(inst, 'sys_scope', `scope=${scope}`, 'scope,name', 1);
      if (!app) throw new Error(`No application with scope ${scope} on this instance.`);
      home = { place: scope === 'global' ? 'global' : 'current-app', scope, name: app.name || scope };
    }
    let updateSet: string | undefined, warning: string | undefined, ids: Pick<Settled, 'update_set_id' | 'app_id'> = {};
    if (home.scope) {
      // Another chat's write may be running: switch only once it has returned (instanceLock.ts).
      const release = await lockInstance(inst.id, chatId);
      let set;
      try { checkAuto(); set = await useUpdateSet(inst, { name: now.update_set, scope: home.scope }); } finally { release(); }
      updateSet = set.name; warning = set.warning; ids = { update_set_id: set.sys_id, app_id: set.app_id };
    }
    done = { status: 'settled', id: now.id, instance_id: inst.id, work: now.work, home, by: choice.by, ...(updateSet ? { update_set: updateSet, ...ids } : {}), ...(warning ? { warning } : {}), ...(from !== undefined ? { from } : {}), at: Date.now() };
  } catch (e) {
    chats.swapPlacement(chatId, claimed, raw); // let the user try again
    throw e;
  }
  chats.swapPlacement(chatId, claimed, JSON.stringify(done));
  const updateSet = done.update_set, home = done.home;
  audit.add(chatId, inst.id, 'placement', { work: now.work, recommended: now.placement.home, rule: now.placement.rule, chosen: home, update_set: updateSet ?? null }, choice.auto ? 'auto-approved (full permissions)' : choice.by === 'accept' ? 'accepted' : `chose ${choice.by}`, now.id);
  if (updateSet) audit.add(chatId, inst.id, 'update set', { name: updateSet, application: home.name, why: `Where this work lives: ${home.name}` }, choice.auto ? 'switched by Pip (full permissions)' : 'switched by you');
  announce('chats', { id: chatId });
  return done;
}

// What Pip is told after the click.
export function settledNote(s: Settled): string {
  if (s.home.place === 'new-app') return `The user chose a new custom app for ${quoted(s.work, 200)}. Don't change the instance from this chat: tell them in one line to start it in Build mode (it creates the app with its own scope), with a one-line brief they can paste.`;
  return `The user settled where ${quoted(s.work, 200)} lives: ${quoted(s.home.name)} (${s.home.scope})${s.update_set ? `, update set ${quoted(s.update_set)} is now current` : ''}.${s.warning ? ` ${s.warning}` : ''} Carry on with the work there.`;
}

// Evals: each scenario is facts → the expected place and rule. Shipped ones are in tests/fixtures; anyone can add their
// own in <config>/placement-scenarios.json and run them against their rules with `npm run eval:placement`.
export interface Scenario { name: string; facts: PlaceFacts; expect: { place: Place; rule?: string } }
export function runScenarios(scenarios: Scenario[], rules: Rule[]) {
  return scenarios.map((s) => {
    const got = place(s.facts, rules);
    const ok = got.home.place === s.expect.place && (!s.expect.rule || got.rule === s.expect.rule);
    return { name: s.name, ok, expected: s.expect, got: { place: got.home.place, rule: got.rule } };
  });
}

// Settings → Pip → Placement rules: the rules as one file you can edit. Saving writes your override of the placement
// skill (owner-only, size-capped, at a fixed path inside the config folder, never through a symlink); Reset deletes it.
export const PLACEMENT_FILE = join(USER_DIR, 'placement', 'SKILL.md');
export const MAX_RULES_BYTES = 50_000;

export function rulesFile(): { text: string; origin: 'shipped' | 'yours'; rules: number; list: Rule[]; warnings: string[] } {
  const yours = existsSync(PLACEMENT_FILE) && placementRules().origin === 'yours';
  const text = readFileSync(yours ? PLACEMENT_FILE : join(SHIPPED_DIR, 'placement', 'SKILL.md'), 'utf8');
  const { rules, warnings } = placementRules();
  return { text, origin: yours ? 'yours' : 'shipped', rules: rules.length, list: rules, warnings };
}

// The rules written back into the file's own format, under the front matter and prose it already has (everything
// before the first `## `). One line per field; a newline in a value would start a new field, so it becomes a space.
export function serializeRules(text: string, rules: Rule[]): string {
  const head = text.split(/^## /m)[0].trimEnd();
  const line = (v: string) => v.replace(/\s+/g, ' ').trim();
  const block = (r: Rule) => [`## ${line(r.id)}`, `if: ${r.if.map((c) => `${c.not ? '!' : ''}${c.cond}`).join(', ')}`, `place: ${r.place}`, `why: ${line(r.why)}`,
    ...(r.warn?.trim() ? [`warn: ${line(r.warn)}`] : []), ...(r.cite?.trim() ? [`cite: ${line(r.cite)}`] : [])].join('\n');
  return `${head}\n\n${rules.map(block).join('\n\n')}\n`;
}

export function saveRulesFile(text: string): { rules: number; warnings: string[] } {
  if (Buffer.byteLength(text) > MAX_RULES_BYTES) throw new Error(`That's over ${MAX_RULES_BYTES / 1000} KB; keep the rules shorter.`);
  const skill = parseSkill(text, 'placement');
  if (typeof skill === 'string') throw new Error(`The file ${skill}.`);
  if (skill.mode) throw new Error('The placement skill is not a mode skill; remove the mode: line.');
  const { rules, warnings } = parseRules(skill.body);
  if (!rules.length) throw new Error(`No usable rules${warnings.length ? `: ${warnings[0]}` : ''}.`);
  noLinks(PLACEMENT_FILE);
  mkdirSync(dirname(PLACEMENT_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${PLACEMENT_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, PLACEMENT_FILE);
  chmodSync(PLACEMENT_FILE, 0o600);
  audit.add(null, null, 'placement rules', { rules: rules.length, bytes: Buffer.byteLength(text) }, 'saved');
  return { rules: rules.length, warnings };
}

export function resetRulesFile() {
  noLinks(PLACEMENT_FILE);
  rmSync(PLACEMENT_FILE, { force: true });
  audit.add(null, null, 'placement rules', {}, 'reset to shipped');
}
