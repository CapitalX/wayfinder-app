import { apps, projects, type Instance } from './db.ts';
import { cleanFilter, pulse, QUICK, type Filter, type Insight, type Pulse } from './insights.ts';

// Starter suggestions from what developers actually changed on the instance (the same read-only findings as
// Insights, cached 10 minutes): review, impact, access checks and "is this ready to promote?". No demo-data prompts.
// Falls back to generic starters for admins and developers when nothing is connected.

export interface Suggestion { label: string; text: string; why?: string }

const GENERIC: Record<string, Suggestion[]> = {
  explore: [
    { label: 'What changed this week?', text: QUICK.find((q) => q.id === 'q-touch')!.prompt },
    { label: 'How do ACLs decide access?', text: 'How does ServiceNow evaluate ACLs, step by step? Then show me the ones on a table I pick.' },
  ],
  mockup: [{ label: 'A better form for one of my tables', text: 'Mock up a better form layout for one of my custom tables: list the recently changed ones first, ask which, then read its fields on the instance.' }],
  decide: [
    { label: 'Is my update set ready to promote?', text: 'Which update sets are in progress? Pick the biggest and tell me whether it is ready to promote: overlaps with other sets, inactive scripts, looser ACLs, missing dependencies, and what it touches. Read-only.' },
    { label: 'Custom table or extend task?', text: 'For a new request type, should I create a custom table or extend task?' },
  ],
  debug: [
    { label: 'New errors since yesterday', text: QUICK.find((q) => q.id === 'q-errors')!.prompt },
    { label: 'Why didn’t my job run?', text: 'A scheduled job didn’t run last night. Find out why with read-only checks.' },
  ],
  build: [{ label: 'An admin check as an app', text: 'A small admin app: a scheduled check that lists business rules on core tables with no condition, and client scripts doing GlideRecord calls, for review.' }],
};

const find = (p: Pulse | null, id: string) => p?.items.find((i) => i.id === id);
const said = (i: Insight) => `${i.value ? `${i.value} ` : ''}${i.label}`;

export async function suggestionsFor(inst: Instance | undefined, mode: string, projectId: string | null): Promise<Suggestion[]> {
  const generic = GENERIC[mode] ?? GENERIC.explore;
  if (!inst || inst.status !== 'active') return generic;
  let p: Pulse | null = null;
  try { p = await pulse(inst, cleanFilter({})); } catch { return generic; }
  const brief = projectId ? projects.get(projectId)?.brief?.trim() : '';
  const logs = find(p, 'logs'), schema = find(p, 'schema'), scripts = find(p, 'scripts'), access = find(p, 'access'), sets = find(p, 'sets');
  const out: Suggestion[] = [];
  switch (mode) {
    case 'debug':
      if (logs?.tone === 'warn') out.push({ label: `${logs.value} new errors since yesterday`, text: logs.prompt, why: 'system log' });
      if (scripts?.impact) out.push({ label: 'Did a recent script change break something?', text: `${scripts.prompt} Then check whether any of the system log errors since yesterday come from these scripts.`, why: 'recent script changes' });
      break;
    case 'explore':
      if (schema) out.push({ label: `What do the changed fields touch?`, text: schema.impact?.prompt ?? schema.prompt, why: said(schema) });
      if (scripts) out.push({ label: 'Review this week’s script changes', text: scripts.prompt, why: said(scripts) });
      break;
    case 'decide':
      if (sets) out.push({ label: 'Ready to promote?', text: sets.prompt, why: said(sets) });
      if (access) out.push({ label: access.tone === 'warn' ? 'Were the looser ACLs intended?' : 'Check this week’s ACL changes', text: access.prompt, why: said(access) });
      break;
    case 'mockup':
      if (schema?.impact?.target.kind === 'field') out.push({ label: `Form for ${schema.impact.target.table}`, text: `Mock up the form for ${schema.impact.target.table} with its recent field changes: read its fields on the instance first, then lay them out the way the people working it would want.`, why: 'recently changed table' });
      break;
    case 'build': {
      const built = apps.list().filter((a) => a.status === 'installed').map((a) => a.name)[0];
      if (built) out.push({ label: `Improve ${built}`, text: `Suggest the next improvement for ${built} and plan it.`, why: 'built here' });
      if (schema?.impact?.target.kind === 'field') out.push({ label: `Build on ${schema.impact.target.table}`, text: `Extend the recently changed table ${schema.impact.target.table} with a small app: check what's there and what references it first, then propose additions.`, why: 'recently changed table' });
      break;
    }
  }
  if (brief) out.unshift({ label: 'Next step for this project', text: `Given the project brief ("${brief.slice(0, 160)}"), what's the most useful next step in ${mode} mode? Then do it.`, why: 'project brief' });
  const filled = [...out, ...generic];
  return filled.filter((s, i) => filled.findIndex((x) => x.label === s.label) === i).slice(0, 4);
}

// Insights for the home screen: findings about development work and logs, then one-click checks.
export async function instancePulse(inst: Instance | undefined, filter: Filter = cleanFilter({})): Promise<Pulse> {
  if (!inst || inst.status !== 'active') return { items: QUICK, skipped: [], filter, people: [], sets: [] };
  try { return await pulse(inst, filter); } catch { return { items: QUICK, skipped: [], filter, people: [], sets: [] }; }
}
