import { audit, chats, conventions, instances, jobs, type Instance } from './db.ts';
import { clearFacts } from './facts.ts';
import { secrets } from './secrets.ts';
import { clearToken } from './sn.ts';
import { clearPulse } from './insights.ts';
import { clearImpact } from './impact.ts';

// One row per instance address. Connecting an address that's already here updates that instance instead of adding a
// second one; retired instances can be removed; duplicates left by older versions are tidied on start.

type Reconnect = Pick<Instance, 'client_id' | 'login_user' | 'auth' | 'auth_user' | 'kind'> & { name?: string };

// Connecting an address that's already here: the same instance gets the new sign-in. Only call it once the new
// sign-in has been tested (or, for "Sign in as me", once the sign-in has come back): it drops the old one (secret,
// password, session, cached token), and any chat on it leaves auto mode (the new sign-in may be a different account).
// The instance becomes the active one; the caller then saves the new secret.
export function reconnect(inst: Instance, f: Reconnect): Instance {
  secrets.clearInstance(inst.id);
  clearToken(inst.id);
  clearPulse(inst.id); clearImpact(inst.id);
  clearFacts(inst.id);
  instances.update(inst.id, { client_id: f.client_id, login_user: f.login_user, kind: f.kind, name: f.name });
  instances.setAuth(inst.id, f.auth, f.auth_user);
  chats.stopAutoOn(inst.id);
  if (inst.status !== 'active') instances.activate(inst.id);
  audit.add(null, inst.id, 'instance', { url: inst.url, auth: f.auth, client_id: f.client_id ? `${f.client_id.slice(0, 6)}…` : undefined }, 'reconnected the same address with a new sign-in (old sign-in dropped)');
  return instances.get(inst.id)!;
}

export type RemoveResult = { ok: true; chats: 'kept' | 'deleted'; count: number } | { ok: false; error: string };

// Removing a retired instance: its sign-in is deleted and it leaves Settings. Its chats stay readable, labelled with
// its address, unless the user asked to delete them too. The active instance can't be removed.
export function removeInstance(id: string, deleteChats: boolean): RemoveResult {
  const inst = instances.get(id);
  if (!inst || inst.status === 'removed') return { ok: false, error: 'That instance is already gone.' };
  if (inst.status === 'active') return { ok: false, error: "The instance in use can't be removed. Make another one active first." };
  if (jobs.running().some((j) => j.instance_id === id)) return { ok: false, error: 'A plugin or app install is still running on it. Remove it once that finishes.' };
  const ids = chats.idsOn(id);
  secrets.clearInstance(id);
  clearToken(id);
  clearFacts(id);
  conventions.clear(id);
  chats.stopAutoOn(id);
  if (deleteChats) for (const c of ids) chats.remove(c);
  instances.markRemoved(id);
  audit.add(null, id, 'instance', { url: inst.url, chats: ids.length, chats_deleted: deleteChats }, `removed the instance; sign-in deleted; ${ids.length} chat(s) ${deleteChats ? 'deleted' : 'kept, read-only'}`);
  return { ok: true, chats: deleteChats ? 'deleted' : 'kept', count: ids.length };
}

// Once per start: retired copies of the active instance's address that nothing refers to (no chats, audit, jobs,
// apps or conventions) are leftovers from a first connect attempt. They and their sign-in are deleted. Copies with
// history are left for the user to remove.
export function mergeDuplicates(log: (m: string) => void = console.log): number {
  const active = instances.active();
  if (!active) return 0;
  let merged = 0;
  for (const dup of instances.byUrl(active.url)) {
    if (dup.id === active.id || dup.status === 'active') continue;
    if (!instances.deleteUnreferenced(dup.id)) continue;
    secrets.clearInstance(dup.id);
    clearToken(dup.id);
    merged++;
  }
  if (merged) {
    audit.add(null, active.id, 'instance', { url: active.url, merged }, `tidied ${merged} unused duplicate(s) of this address left by an earlier connect`);
    log(`Removed ${merged} unused duplicate instance row(s) for ${active.url}.`);
  }
  return merged;
}
