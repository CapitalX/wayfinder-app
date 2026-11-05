import { audit, chats, instances, type Instance } from './db.ts';
import { secrets } from './secrets.ts';
import { clearToken, secureUrl } from './sn.ts';

// A page on the connected instance for Pip's open_page tool: a path ("incident.do?sys_id=…", "/now/nav/ui/home") or a
// full address, which must be on this instance and nowhere else. Returns the https URL to open in the user's browser.
export function instancePage(instUrl: string, target: string): string {
  const base = new URL(instUrl);
  const raw = target.trim();
  if (!raw) throw new Error('Say which page to open.');
  let url: URL;
  try { url = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') ? new URL(raw) : new URL(raw.startsWith('/') ? raw : `/${raw}`, base); }
  catch { throw new Error(`"${raw}" is not a page address.`); }
  if (url.protocol !== 'https:' || url.host !== base.host) throw new Error(`Only pages on ${base.host} can be opened.`);
  url.username = ''; url.password = '';
  return url.toString();
}

export const isPdiUrl = (url: string) => /^https:\/\/dev\d+\.service-now\.com$/.test(url);

// What the user typed, as an origin ("dev12345.service-now.com" becomes https://dev12345.service-now.com).
export function parseInstanceUrl(raw: string): { url: string } | { error: string } {
  const text = raw.trim();
  let url: string;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).origin; } catch { return { error: `"${text}" is not a web address.` }; }
  if (!secureUrl(url)) return { error: 'The instance address must start with https://, so your sign-in details are never sent unencrypted.' };
  return { url };
}

// Pointing an instance at a new address is a new instance as far as trust goes: the stored sign-in (secret, password
// or session) is dropped so it's never sent to the new host, the PDI check runs again (anything else needs the same
// opt-in as connecting it), the access profile is cleared, and any chat on it leaves auto mode.
export function changeInstanceUrl(inst: Instance, url: string, allowNonPdi: boolean): { error: string; needs_opt_in?: boolean } | null {
  if (url === inst.url) return null;
  const pdi = isPdiUrl(url);
  if (!pdi && !allowNonPdi) return { error: 'This is not a personal developer instance. Tick "This is a production or vendor instance" to connect it anyway.', needs_opt_in: true };
  // Clear the sign-in first: if that fails, the old address keeps its old sign-in rather than the new one getting it.
  secrets.clearInstance(inst.id);
  clearToken(inst.id);
  instances.update(inst.id, { url, kind: pdi ? 'pdi' : 'other', profile: null, script_runner_path: null, script_runner_records: null });
  chats.stopAutoOn(inst.id);
  audit.add(null, inst.id, 'instance', { from: inst.url, to: url }, `changed the address; stored sign-in dropped${pdi ? '' : ' (non-PDI, opted in)'}`);
  return null;
}
