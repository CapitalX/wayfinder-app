import type { Instance } from './db.ts';
import { table } from './sn.ts';

// The features engine: what a plugin or Store app's state is on this instance, what it needs first, and
// whether it can be turned on at all (PDIs block some apps, and the Store says so).

// 'unknown': the instance didn't let us check whether it's installed (a refused or failed query), which is not the
// same as "not installed".
export type FeatureStatus = 'on' | 'ready' | 'store' | 'blocked' | 'pdi_unavailable' | 'unknown';
export interface Feature {
  kind: 'plugin' | 'store_app';
  id: string;            // plugin id, or the Store app's sys_id
  name: string;
  scope?: string;
  description: string;
  plain: string;         // one plain line: what it does and why you'd turn it on
  status: FeatureStatus;
  why?: string;          // why it's blocked or unavailable, in the instance's own words
  version?: string;
  requires: { id: string; name: string; on: boolean | null }[];
  help?: string;         // docs link for the feature
  demo_data?: boolean;
  paid?: boolean;
}

// One plain line per feature: written out for products people often look for, otherwise the first sentence of the
// instance's own description (without markup).
const PLAIN: [RegExp, string][] = [
  [/performance analytics/i, 'Scores and trends for your KPIs over time (backlog, SLAs, response times). Turn it on for dashboards that show change, not just today\'s number.'],
  [/integration ?hub/i, 'Ready-made Flow Designer actions for calling other systems. Turn it on to integrate without writing REST code.'],
  [/field service/i, 'Plans and dispatches on-site work by technicians. Turn it on if your team visits users or assets.'],
  [/customer service/i, 'Cases, accounts and a portal for external customers. Turn it on to support customers rather than employees.'],
  [/hr service delivery|human resources/i, 'HR cases, onboarding and an employee portal. Turn it on to run HR requests in ServiceNow.'],
  [/vulnerability response/i, 'Brings in scanner findings and tracks fixing them. Turn it on to manage security vulnerabilities.'],
  [/security incident/i, 'Tracks and coordinates the response to security incidents. Turn it on for a security operations process.'],
  [/service mapping/i, 'Maps which servers and apps make up each business service. Turn it on to see what an outage affects.'],
  [/discovery/i, 'Finds devices and software on your network and fills the CMDB. Turn it on to keep configuration items current.'],
  [/workspace/i, 'A modern screen for agents to work their queue. Turn it on to give agents everything for a ticket in one place.'],
  [/virtual agent/i, 'A chat assistant for common requests. Turn it on to answer and route simple questions automatically.'],
  [/predictive intelligence/i, 'Machine learning that suggests categories, groups and similar records. Turn it on to cut manual triage.'],
  [/automated test framework|\batf\b/i, 'Automated tests for forms, scripts and flows. Turn it on to check changes before you promote them.'],
  [/service portal/i, 'Self-service pages where people request and track things. Turn it on to give users a portal.'],
  [/(hardware|software) asset|asset management/i, 'Tracks owned hardware or software, costs and licences. Turn it on to manage assets beyond the CMDB.'],
  [/knowledge/i, 'Articles that users and agents can search. Turn it on to publish answers and how-tos.'],
  [/event management/i, 'Turns monitoring alerts into events you can act on. Turn it on to connect monitoring tools.'],
];
export function plainLine(name: string, description: string): string {
  const known = PLAIN.find(([re]) => re.test(name));
  if (known) return known[1];
  const text = description.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const first = text.match(/^.{20,}?[.!?](\s|$)/)?.[0].trim() ?? text;
  return first.length > 180 ? `${first.slice(0, 177).replace(/\s+\S*$/, '')}…` : first;
}

const clean = (q: string) => q.replace(/[\^=]/g, ' ').trim().slice(0, 80);
const indicatorText = (raw: string) => {
  try { return (JSON.parse(raw || '[]') as { message?: string; tooltip?: string }[]).map((i) => i.tooltip || i.message).filter(Boolean).join('; '); } catch { return ''; }
};

// Words that don't narrow a search: a phrase like "service catalog request fulfillment with flow designer" becomes
// catalog, request, fulfillment, flow, designer (and "service" only when nothing more specific is left).
const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'that', 'this', 'from', 'into', 'how', 'can', 'use', 'using',
  'should', 'turn', 'enable', 'plugin', 'plugins', 'app', 'apps', 'feature', 'features', 'servicenow', 'now', 'out', 'box', 'oob']);
const WEAK = new Set(['service', 'management', 'manager', 'core', 'base', 'data']);

function keywords(query: string): string[] {
  const words = clean(query).toLowerCase().split(/[^a-z0-9_.]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  const strong = words.filter((w) => !WEAK.has(w));
  return [...new Set(strong.length ? strong : words)].slice(0, 6);
}

const anyOf = (fields: string[], terms: string[]) => terms.flatMap((t) => fields.map((f) => `${f}LIKE${t}`)).join('^OR');

// What a search found, and what it couldn't check: a refused or failed query is reported, never read as "none".
export interface FeatureSearch { features: Feature[]; problems: string[] }

// Recent searches answer instantly for two minutes (plugin state rarely changes faster; installs clear it). A search
// that hit a problem isn't kept, so the next one asks the instance again.
const featureCache = new Map<string, { at: number; value: FeatureSearch }>();
export const clearFeatureCache = () => featureCache.clear();
export async function findFeatures(inst: Instance, query: string, limit = 20): Promise<FeatureSearch> {
  const key = `${inst.id}:${limit}:${query.trim().toLowerCase()}`;
  const hit = featureCache.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.value;
  const value = await runFeatureSearch(inst, query, limit);
  if (!value.problems.length) featureCache.set(key, { at: Date.now(), value });
  return value;
}
export const searchFeatures = async (inst: Instance, query: string, limit = 20): Promise<Feature[]> => (await findFeatures(inst, query, limit)).features;

const reason = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 160);

async function runFeatureSearch(inst: Instance, query: string, limit: number): Promise<FeatureSearch> {
  const phrase = clean(query).toLowerCase();
  const terms = keywords(query);
  if (!terms.length) return { features: [], problems: [] };
  const problems: string[] = [];
  const tried = <T,>(what: string, p: Promise<T[]>): Promise<T[]> => p.catch((e) => { problems.push(`Couldn't read ${what}: ${reason(e)}`); return []; });
  // One query per table matching any keyword, then rank by how many keywords each result matches.
  const [plugins, remote, installed] = await Promise.all([
    tried('plugins (v_plugin)', table(inst, 'v_plugin', anyOf(['name', 'id', 'description'], terms), 'id,name,description,active,requires,block_install,indicators,has_demo_data,help,version', 80)),
    tried('Store apps (sys_remote_app)', table(inst, 'sys_remote_app', anyOf(['name', 'scope', 'short_description'], terms), 'sys_id,name,scope,short_description,latest_version,block_install,indicators,dependencies,price_type,demo_data', 60)),
    installedApps(inst, terms),
  ]);
  if (!installed) problems.push("Couldn't check which Store apps are installed (sys_scope was refused), so their install state is unknown.");

  // Look up whether each plugin's prerequisites are already on, in one call.
  const reqIds = [...new Set(plugins.flatMap((p: any) => String(p.requires || '').split(',').map((s) => s.trim()).filter(Boolean)))];
  const reqRows = reqIds.length ? await tried('plugin prerequisites', table(inst, 'v_plugin', `idIN${reqIds.join(',')}`, 'id,name,active', reqIds.length)) : [];
  const reqState = new Map(reqRows.map((r: any) => [r.id, { name: r.name, on: r.active === 'active' }]));

  const out: Feature[] = plugins.map((p: any) => {
    const blocked = p.block_install === 'true';
    return {
      kind: 'plugin',
      id: p.id,
      name: p.name,
      description: p.description || '',
      plain: plainLine(p.name ?? '', p.description || ''),
      status: p.active === 'active' ? 'on' : blocked ? 'blocked' : 'ready',
      why: blocked ? indicatorText(p.indicators) || 'Install is blocked on this instance.' : undefined,
      version: p.version,
      requires: String(p.requires || '').split(',').map((s) => s.trim()).filter(Boolean).map((id) => ({ id, name: reqState.get(id)?.name ?? id, on: reqState.get(id)?.on ?? null })),
      help: p.help ? `${inst.url}${p.help}` : undefined,
      demo_data: p.has_demo_data === 'true',
    } satisfies Feature;
  });

  for (const a of remote as any[]) {
    const why = indicatorText(a.indicators);
    const isInstalled = installed?.has(a.scope) ?? false;
    out.push({
      kind: 'store_app',
      id: a.sys_id,
      name: a.name,
      scope: a.scope,
      description: a.short_description || '',
      plain: plainLine(a.name ?? '', a.short_description || ''),
      status: isInstalled ? 'on' : !installed ? 'unknown' : a.block_install === 'true' ? (/developer instance/i.test(why) ? 'pdi_unavailable' : 'blocked') : 'store',
      why: !isInstalled && a.block_install === 'true' ? why || 'Install is blocked on this instance.' : undefined,
      version: a.latest_version,
      requires: String(a.dependencies || '').split(',').map((s) => s.trim()).filter(Boolean).map((d) => {
        const [id] = d.split(':');
        return { id, name: id, on: installed?.has(id) ? true : null };
      }),
      demo_data: a.demo_data && a.demo_data !== 'no_demo_data',
      paid: a.price_type === 'paid',
    });
  }

  // Name hits count double; matching the whole phrase wins outright. Usable features before blocked ones.
  const score = (f: Feature) => {
    const name = f.name.toLowerCase(), rest = `${f.id} ${f.scope ?? ''} ${f.description}`.toLowerCase();
    return (phrase.length > 3 && name.includes(phrase) ? 10 : 0) + terms.reduce((n, t) => n + (name.includes(t) ? 2 : rest.includes(t) ? 1 : 0), 0);
  };
  const rank: Record<FeatureStatus, number> = { on: 1, ready: 0, store: 0, unknown: 1, blocked: 2, pdi_unavailable: 3 };
  const features = out
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s || rank[a.f.status] - rank[b.f.status] || a.f.name.localeCompare(b.f.name))
    .slice(0, limit)
    .map((x) => x.f);
  return { features, problems };
}

// Scopes of Store apps already on the instance, read through sys_scope (sys_store_app itself is often closed to the
// Table API by a web service access policy, and each refused read logs an error on the instance). If even the class
// filter is refused, fall back to every active scope; if that's refused too, the answer is "unknown" (null), not
// "nothing installed".
async function installedApps(inst: Instance, terms: string[]): Promise<Set<string> | null> {
  try {
    const rows = await table(inst, 'sys_scope', `sys_class_name=sys_store_app^active=true^${anyOf(['name', 'scope'], terms)}`, 'scope', 100);
    return new Set(rows.map((r: any) => r.scope));
  } catch {
    try {
      const rows = await table(inst, 'sys_scope', `active=true^${anyOf(['name', 'scope'], terms)}`, 'scope', 100);
      return new Set(rows.map((r: any) => r.scope));
    } catch { return null; }
  }
}

export const STATUS_TEXT: Record<FeatureStatus, string> = {
  on: 'On',
  ready: 'Ready to turn on',
  store: 'Available in the Store',
  blocked: 'Blocked on this instance',
  pdi_unavailable: 'Not available on developer instances',
  unknown: "Couldn't check whether it's installed",
};
