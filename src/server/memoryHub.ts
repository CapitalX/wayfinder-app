import { audit, conventionKey, conventions, fluentLessons, memories, pauses, projects, toolLessons, type ConventionRule, type FluentLesson, type Instance, type Memory, type RuleKind, type ToolLesson } from './db.ts';

// The Memory page: every rule Pip follows, from wherever it came (your memories, Pip's suggestions you kept, your
// instance's conventions, lessons from builds and from failed tool calls), grouped by where it applies. Paused rules
// stay saved but stay out of the prompt; the prompt builders read the same `active*` lists, so the page and the
// prompt never disagree. Rules guide Pip; none of them can approve a change.

export const WORD_BUDGET = 1500;

// What goes into the prompt, per source.
export const activeMemories = (projectId: string | null): Memory[] => { const p = pauses.all(); return memories.forChat(projectId).filter((m) => !p.has(`memory:${m.id}`)); };
export const activeConventions = (inst: Instance | undefined): ConventionRule[] => {
  if (!inst) return [];
  const c = conventions.get(inst.id);
  if (c?.status !== 'on') return [];
  const p = pauses.all();
  return c.rules.filter((r) => !p.has(`convention:${conventionKey(inst.id, r.id)}`));
};
export const activeToolLessons = (): ToolLesson[] => { const p = pauses.all(); return toolLessons.list('learned').filter((l) => !p.has(`tool:${l.id}`)).slice(0, 20); };
export const activeFluentLessons = (): FluentLesson[] => { const p = pauses.all(); return fluentLessons.list('approved').filter((l) => !p.has(`fluent:${l.id}`)); };

// How many rules guided an answer in this mode (Fluent lessons ride with the build skill, so only Build counts them).
export const guidedCount = (inst: Instance | undefined, projectId: string | null, mode: string) =>
  activeMemories(projectId).length + activeConventions(inst).length + activeToolLessons().length + (mode === 'build' ? activeFluentLessons().length : 0);

export type Where = 'all' | 'project' | 'instance' | 'build' | 'tools' | 'placement';
export type Origin = 'you' | 'pip' | 'instance' | 'builds' | 'tool-calls' | 'placement' | 'placement-yours';
// Placement rules are shown read-only (they live in the placement skill file) and aren't part of the prompt budget:
// the placement tool applies them, Pip doesn't read them each turn.
export interface HubRule { kind: RuleKind | 'placement'; id: string; text: string; where: Where; group: string; origin: Origin; paused: boolean; editable: boolean; readOnly?: boolean; conflict?: { id: string; text: string } }
export interface PlacementView { rules: { id: string; place: string; why: string }[]; origin: 'shipped' | 'yours' | null; file: string }
const PLACE_LABEL: Record<string, string> = { 'current-app': 'The app you are in', 'owning-app': 'The app that owns the table', 'new-app': 'A new custom app', global: 'Global' };
export interface QueueItem { kind: 'memory' | 'fluent'; id: string; text: string; why: string; origin: Origin; group: string; conflict?: { id: string; text: string } }

// Two rules that talk about the same things, one saying do and the other don't, are labelled as a possible conflict.
// A cheap word check, not a judge: it only adds a label for the user to look at.
const NEGATIVE = /\b(never|don'?t|do not|avoid|no longer|instead of|not)\b/i;
const STOP = new Set(['always', 'never', 'prefer', 'avoid', 'should', 'would', 'could', 'about', 'their', 'there', 'these', 'those', 'which', 'where', 'when', 'with', 'without', 'from', 'into', 'over', 'than', 'that', 'this', 'them', 'they', 'what', 'your', 'have', 'make', 'only', 'instead', 'every', 'anything', 'something', 'using', 'used', 'unless', 'other', 'more', 'less', 'just', 'like', 'does', 'doesn', 'dont']);
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
export function conflicts(rules: { id: string; text: string }[]): Map<string, { id: string; text: string }> {
  const out = new Map<string, { id: string; text: string }>();
  const prepared = rules.map((r) => ({ ...r, w: words(r.text), neg: NEGATIVE.test(r.text) }));
  for (let i = 0; i < prepared.length; i++) for (let j = i + 1; j < prepared.length; j++) {
    const a = prepared[i], b = prepared[j];
    if (a.neg === b.neg) continue;
    let shared = 0;
    for (const w of a.w) if (b.w.has(w)) shared++;
    if (shared < 2) continue;
    if (!out.has(a.id)) out.set(a.id, { id: b.id, text: b.text });
    if (!out.has(b.id)) out.set(b.id, { id: a.id, text: a.text });
  }
  return out;
}

export const wordCount = (texts: string[]) => texts.reduce((n, t) => n + (t.trim() ? t.trim().split(/\s+/).length : 0), 0);

export function hub(inst: Instance | undefined, placement?: PlacementView) {
  const p = pauses.all();
  const projectName = (id: string | null) => projects.get(id ?? '')?.name ?? 'a removed project';
  const rules: HubRule[] = [];
  for (const m of memories.list('saved')) rules.push({
    kind: 'memory', id: m.id, text: m.text, where: m.scope === 'core' ? 'all' : 'project', group: m.scope === 'core' ? 'Every chat' : `Project · ${projectName(m.project_id)}`,
    origin: m.chat_id ? 'pip' : 'you', paused: p.has(`memory:${m.id}`), editable: true,
  });
  const cv = inst ? conventions.get(inst.id) : undefined;
  if (inst && cv?.status === 'on') for (const r of cv.rules) rules.push({ kind: 'convention', id: conventionKey(inst.id, r.id), text: `${r.rule}${r.example ? ` (e.g. ${r.example})` : ''}`, where: 'instance', group: `This instance · ${inst.name}`, origin: 'instance', paused: p.has(`convention:${conventionKey(inst.id, r.id)}`), editable: false });
  for (const l of fluentLessons.list('approved')) if (l.rule) rules.push({ kind: 'fluent', id: l.id, text: l.rule, where: 'build', group: 'Building apps', origin: 'builds', paused: p.has(`fluent:${l.id}`), editable: false });
  for (const l of toolLessons.list('learned')) if (l.rule) rules.push({ kind: 'tool', id: l.id, text: l.rule, where: 'tools', group: 'Using tools', origin: 'tool-calls', paused: p.has(`tool:${l.id}`), editable: false });

  for (const r of placement?.rules ?? []) rules.push({
    kind: 'placement', id: r.id, text: `${PLACE_LABEL[r.place] ?? r.place}: ${r.why}`, where: 'placement', group: 'Where work lives',
    origin: placement!.origin === 'yours' ? 'placement-yours' : 'placement', paused: false, editable: false, readOnly: true,
  });

  const queue: QueueItem[] = [
    ...memories.list('proposed').map((m): QueueItem => ({ kind: 'memory', id: m.id, text: m.text, why: m.why, origin: 'pip', group: m.scope === 'core' ? 'Every chat' : `Project · ${projectName(m.project_id)}` })),
    ...fluentLessons.list('proposed').filter((l) => l.rule).map((l): QueueItem => ({ kind: 'fluent', id: l.id, text: l.rule!, why: `From a build error: ${l.message.slice(0, 160)}`, origin: 'builds', group: 'Building apps' })),
  ];
  // Conflicts are checked among the active rules, and each waiting item against them.
  const active = rules.filter((r) => !r.paused && !r.readOnly);
  const clash = conflicts([...active, ...queue].map((r) => ({ id: `${r.kind}:${r.id}`, text: r.text })));
  const label = (r: { kind: string; id: string }) => { const c = clash.get(`${r.kind}:${r.id}`); return c ? { id: c.id, text: c.text } : undefined; };
  for (const r of rules) if (!r.paused) r.conflict = label(r);
  for (const q of queue) q.conflict = label(q);
  return {
    rules, queue,
    words: wordCount(active.map((r) => r.text)), budget: WORD_BUDGET,
    conventions_waiting: inst && cv ? cv.proposed.length : 0,
    placement_file: placement?.file ?? null,
  };
}

// Delete means: a memory is forgotten, a convention leaves the approved list, a lesson is dropped. Audited.
export function deleteRule(inst: Instance | undefined, kind: RuleKind, id: string): boolean {
  if (kind === 'memory') { if (!memories.get(id)) return false; memories.remove(id); }
  else if (kind === 'convention') {
    // The id is <instance id>:<rule id>, so a rule is deleted only on the instance it was shown for.
    const at = id.indexOf(':');
    const instanceId = id.slice(0, at), ruleId = id.slice(at + 1);
    const cv = at > 0 ? conventions.get(instanceId) : undefined;
    if (!cv || !cv.rules.some((r) => r.id === ruleId)) return false;
    const rest = cv.rules.filter((r) => r.id !== ruleId);
    if (rest.length) conventions.approve(instanceId, rest); else conventions.clear(instanceId);
  } else if (kind === 'tool') { if (!toolLessons.get(id)) return false; toolLessons.update(id, { status: 'removed' }); }
  else if (kind === 'fluent') { if (!fluentLessons.get(id)) return false; fluentLessons.update(id, { status: 'dismissed' }); }
  else return false;
  pauses.set(kind, id, false);
  audit.add(null, inst?.id ?? null, 'memory hub', { kind, id }, 'deleted');
  return true;
}
