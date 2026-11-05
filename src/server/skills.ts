import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, DATA_DIR } from './config.ts';
import { CHEAT_SHEET } from './fluent.ts';
import { sheetAddendum } from './fluentReview.ts';
import type { Mode } from './prompts.ts';

// Pip's know-how as skills. Shipped defaults live in src/server/skills/<name>/SKILL.md; the user's own in
// <config>/skills/<name>/SKILL.md (same name replaces a default, a new name adds one). A skill with `mode:` is the
// rule set for that mode and goes straight into that mode's system prompt (it's needed every turn, so loading it
// on demand would only add a round trip). Every other skill loads on demand: Wayfinder writes them into a plugin
// folder in its data dir and hands the SDK that plugin plus the exact list of names, so nothing from ~/.claude loads.

export const PLUGIN = 'wayfinder';
export const SHIPPED_DIR = fileURLToPath(new URL('./skills/', import.meta.url));
export const USER_DIR = join(CONFIG_DIR, 'skills');
export const PLUGIN_DIR = join(DATA_DIR, 'skills-plugin');

const MODES: readonly Mode[] = ['explore', 'mockup', 'decide', 'debug', 'build'];
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BYTES = 100_000;

export interface Skill { name: string; description: string; mode?: Mode; modes?: Mode[]; body: string; origin: 'shipped' | 'yours' }
export interface SkillSet { skills: Skill[]; warnings: string[] }

// Front matter is a few `key: value` lines between --- fences; nothing else in it is read. `modes: build, debug` offers
// an on-demand skill only in those modes (default: all).
export function parseSkill(text: string, dirName: string): Omit<Skill, 'origin'> | string {
  if (Buffer.byteLength(text) > MAX_BYTES) return `is over ${MAX_BYTES / 1000} KB`;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return 'has no front matter (--- name / description ---)';
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const body = m[2].trim();
  if (!fields.name || !NAME.test(fields.name)) return 'needs a name of lowercase letters, digits and dashes';
  if (fields.name !== dirName) return `is named "${fields.name}" but sits in the folder "${dirName}"`;
  if (!fields.description) return 'needs a one-line description';
  if (fields.description.length > 1024) return 'has a description over 1024 characters';
  if (fields.mode && !MODES.includes(fields.mode as Mode)) return `has an unknown mode "${fields.mode}" (one of ${MODES.join(', ')})`;
  const modes = fields.modes ? fields.modes.split(/[\s,]+/).filter(Boolean) : undefined;
  const unknown = modes?.find((x) => !MODES.includes(x as Mode));
  if (unknown) return `has an unknown mode "${unknown}" in modes (one of ${MODES.join(', ')})`;
  if (!body) return 'is empty below the front matter';
  return { name: fields.name, description: fields.description, ...(fields.mode ? { mode: fields.mode as Mode } : {}), ...(modes?.length ? { modes: modes as Mode[] } : {}), body };
}

function readDir(dir: string, origin: Skill['origin'], warnings: string[]): Map<string, Skill> {
  const found = new Map<string, Skill>();
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    let parsed: ReturnType<typeof parseSkill>;
    try { parsed = parseSkill(readFileSync(file, 'utf8'), entry.name); } catch (e) { parsed = `can't be read (${(e as Error).message})`; }
    if (typeof parsed === 'string') warnings.push(`Skill "${entry.name}" ${parsed}; ${origin === 'yours' ? 'using the shipped one instead, if there is one' : 'skipped'}.`);
    else found.set(parsed.name, { ...parsed, origin });
  }
  return found;
}

// The shipped fluent skill carries the cheat sheet (kept in fluent-cheatsheet.md, where the build check reads it)
// and what this machine learned since.
const shippedExtra = (name: string) => (name === 'fluent' ? [CHEAT_SHEET, sheetAddendum()].filter(Boolean).join('\n\n') : '');

export function loadSkills(opts: { shippedDir?: string; userDir?: string; extra?: (name: string) => string } = {}): SkillSet {
  const { shippedDir = SHIPPED_DIR, userDir = USER_DIR, extra = shippedExtra } = opts;
  const warnings: string[] = [];
  const merged = readDir(shippedDir, 'shipped', warnings);
  for (const s of merged.values()) { const more = extra(s.name); if (more) s.body = `${s.body}\n\n${more}`; }
  for (const [name, s] of readDir(userDir, 'yours', warnings)) merged.set(name, s);
  // Two skills claiming one mode: the user's wins, then the first by name.
  const byMode = new Map<Mode, Skill>();
  for (const s of [...merged.values()].sort((a, b) => (a.origin === b.origin ? a.name.localeCompare(b.name) : a.origin === 'yours' ? -1 : 1))) {
    if (!s.mode) continue;
    if (byMode.has(s.mode)) { warnings.push(`Skills "${byMode.get(s.mode)!.name}" and "${s.name}" are both for ${s.mode} mode; using "${byMode.get(s.mode)!.name}".`); s.mode = undefined; }
    else byMode.set(s.mode, s);
  }
  return { skills: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

export const modeRule = (set: SkillSet, mode: Mode) => set.skills.find((s) => s.mode === mode)?.body ?? '';
export const onDemand = (set: SkillSet, mode?: Mode) => set.skills.filter((s) => !s.mode && (!mode || !s.modes || s.modes.includes(mode)));
export const qualified = (name: string) => `${PLUGIN}:${name}`;

// Writes every on-demand skill as a local plugin (the per-mode choice is the names list), touching only files that changed (answers run side by side), and
// removes skills that are gone. The front matter is rewritten as JSON strings, so any description parses.
export function writePlugin(set: SkillSet, dir = PLUGIN_DIR): { type: 'local'; path: string } {
  const put = (file: string, text: string) => {
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  };
  put(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: PLUGIN, description: "Wayfinder's ServiceNow know-how for Pip" }, null, 2)}\n`);
  const keep = new Set(onDemand(set).map((s) => s.name));
  for (const s of onDemand(set)) put(join(dir, 'skills', s.name, 'SKILL.md'), `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`);
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) for (const e of readdirSync(skillsDir)) if (!keep.has(e)) rmSync(join(skillsDir, e), { recursive: true, force: true });
  return { type: 'local', path: dir };
}

// The names the last answer was given; the Skill tool gate in policy.ts allows only these.
let allowed = new Set<string>();
export const skillAllowed = (name: unknown) => typeof name === 'string' && (allowed.has(name) || allowed.has(qualified(name)));

// Per answer: read the skills fresh (edits apply on the next answer, no restart) and refresh the plugin folder.
export function prepareSkills(mode: Mode): { set: SkillSet; plugin: { type: 'local'; path: string }; names: string[] } {
  const set = loadSkills();
  const plugin = writePlugin(set);
  const names = onDemand(set, mode).map((s) => qualified(s.name));
  allowed = new Set(names);
  return { set, plugin, names };
}

// Settings → Pip → Skills: a skill's file as text, and your own copy of it saved from the page. Your copy lives in
// the config folder (owner-only, size-capped, never written through a link); removing it brings the shipped one back.
const MAX_FILE = 100_000;
export function noLinks(path: string) {
  for (let p = path; p.startsWith(CONFIG_DIR) && p !== CONFIG_DIR; p = dirname(p))
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a link; Wayfinder only writes real files in its config folder.`);
}
export function readSkillFile(name: string): { text: string; origin: 'shipped' | 'yours'; shipped: boolean } | null {
  if (!NAME.test(name)) return null;
  const yours = join(USER_DIR, name, 'SKILL.md'), shipped = join(SHIPPED_DIR, name, 'SKILL.md');
  if (existsSync(yours)) return { text: readFileSync(yours, 'utf8'), origin: 'yours', shipped: existsSync(shipped) };
  if (existsSync(shipped)) return { text: readFileSync(shipped, 'utf8'), origin: 'shipped', shipped: true };
  return null;
}
export function saveUserSkill(name: string, text: string) {
  if (!NAME.test(name)) throw new Error('Not a skill name.');
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error(`That's over ${MAX_FILE / 1000} KB; keep the skill shorter.`);
  const parsed = parseSkill(text, name);
  if (typeof parsed === 'string') throw new Error(`The skill ${parsed}.`);
  const file = join(USER_DIR, name, 'SKILL.md');
  noLinks(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
export function removeUserSkill(name: string) {
  if (!NAME.test(name)) throw new Error('Not a skill name.');
  const dir = join(USER_DIR, name);
  noLinks(join(dir, 'SKILL.md'));
  rmSync(dir, { recursive: true, force: true });
}
