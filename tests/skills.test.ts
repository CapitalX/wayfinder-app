import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHEAT_SHEET } from '../src/server/fluent.ts';
import { MODES, systemPrompt, type Mode } from '../src/server/prompts.ts';
import { loadSkills, modeRule, onDemand, parseSkill, prepareSkills, skillAllowed, USER_DIR, writePlugin } from '../src/server/skills.ts';
import { settings } from '../src/server/db.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'wayfinder-skills-'));
const put = (dir: string, name: string, text: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), text); };
const skill = (name: string, more = '', body = 'Do it this way.') => `---\nname: ${name}\ndescription: What ${name} is for.\n${more}---\n\n${body}\n`;
const modes = Object.keys(MODES) as Mode[];
const prompt = (mode: Mode) => systemPrompt(mode, undefined, settings.get(), { release: 'zurich' });

describe('shipped skills', () => {
  const set = loadSkills({ userDir: tmp() });

  it('all parse, with no warnings', () => {
    expect(set.warnings).toEqual([]);
    expect(set.skills.every((s) => s.origin === 'shipped')).toBe(true);
  });

  it.each(modes)('%s mode has its rules', (mode) => {
    expect(modeRule(set, mode)).toMatch(new RegExp(`^Mode: ${MODES[mode]}\\.`));
  });

  it('fluent carries the cheat sheet and is offered in build mode only', () => {
    const fluent = set.skills.find((s) => s.name === 'fluent')!;
    expect(fluent.body).toContain(CHEAT_SHEET.trim().slice(0, 200));
    expect(onDemand(set, 'build').map((s) => s.name)).toContain('fluent');
    for (const m of modes.filter((x) => x !== 'build')) expect(onDemand(set, m).map((s) => s.name)).not.toContain('fluent');
  });
});

describe('the system prompt', () => {
  it('build no longer carries the cheat sheet, and lists the fluent skill', () => {
    const p = prompt('build');
    expect(p).not.toContain(CHEAT_SHEET.trim().slice(0, 200));
    expect(p).toContain('- wayfinder:fluent: ');
    expect(p).toContain('load the fluent skill first');
    expect(p.length).toBeLessThan(12_000);
  });

  it.each(modes)('%s carries its mode rules from the skill', (mode) => {
    expect(prompt(mode)).toContain(`Mode: ${MODES[mode]}.`);
  });

  it('each mode lists only the skills offered there', () => {
    for (const m of ['explore', 'mockup', 'debug'] as Mode[]) expect(prompt(m)).not.toContain('Skills (know-how');
    expect(prompt('decide')).toContain('- wayfinder:placement: ');
    expect(prompt('decide')).not.toContain('wayfinder:fluent');
  });
});

describe('your skills', () => {
  it('a skill with the same name replaces the shipped one', () => {
    const user = tmp();
    put(user, 'debug-method', skill('debug-method', 'mode: debug\n', 'Mode: Debug. Always start from the system log.'));
    const set = loadSkills({ userDir: user });
    expect(modeRule(set, 'debug')).toBe('Mode: Debug. Always start from the system log.');
    expect(set.skills.find((s) => s.name === 'debug-method')!.origin).toBe('yours');
  });

  it('a new name adds an on-demand skill, offered in every mode unless it says otherwise', () => {
    const user = tmp();
    put(user, 'cmdb-health', skill('cmdb-health'));
    put(user, 'atf-style', skill('atf-style', 'modes: build, debug\n'));
    const set = loadSkills({ userDir: user });
    expect(onDemand(set, 'explore').map((s) => s.name)).toEqual(['cmdb-health']);
    expect(onDemand(set, 'debug').map((s) => s.name)).toEqual(['atf-style', 'cmdb-health']);
  });

  it.each([
    ['no front matter', 'just text', 'no front matter'],
    ['a name that does not match its folder', skill('other'), 'sits in the folder'],
    ['an empty body', skill('debug-method', '', ''), 'empty'],
    ['an unknown mode', skill('debug-method', 'mode: chat\n'), 'unknown mode'],
  ])('a file with %s falls back to the shipped one, with a warning', (_why, text, says) => {
    const user = tmp();
    put(user, 'debug-method', text);
    const set = loadSkills({ userDir: user });
    expect(set.skills.find((s) => s.name === 'debug-method')!.origin).toBe('shipped');
    expect(set.warnings.join(' ')).toContain(says);
  });

  it('two skills for one mode: yours wins, with a warning', () => {
    const user = tmp();
    put(user, 'my-debug', skill('my-debug', 'mode: debug\n', 'Mode: Debug. Mine.'));
    const set = loadSkills({ userDir: user });
    expect(modeRule(set, 'debug')).toBe('Mode: Debug. Mine.');
    expect(set.warnings.join(' ')).toContain('both for debug mode');
  });

  it('parses quoted values and ignores keys it does not know', () => {
    expect(parseSkill('---\nname: a\ndescription: "Has: a colon"\nallowed-tools: Bash\n---\nBody', 'a')).toEqual({ name: 'a', description: 'Has: a colon', body: 'Body' });
  });
});

describe('the plugin folder', () => {
  it('holds the on-demand skills only, rewrites front matter safely, and drops removed ones', () => {
    const user = tmp(), out = tmp();
    put(user, 'odd', '---\nname: odd\ndescription: Has: colons and "quotes"\n---\n\nBody');
    writePlugin(loadSkills({ userDir: user }), out);
    expect(JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('wayfinder');
    expect(readFileSync(join(out, 'skills', 'odd', 'SKILL.md'), 'utf8')).toContain('description: "Has: colons and \\"quotes\\""');
    expect(existsSync(join(out, 'skills', 'fluent', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(out, 'skills', 'build-flow'))).toBe(false);
    writePlugin(loadSkills({ userDir: tmp() }), out);
    expect(existsSync(join(out, 'skills', 'odd'))).toBe(false);
  });

  it('only the skills this answer was given pass the gate', () => {
    put(USER_DIR, 'cmdb-health', skill('cmdb-health', 'modes: debug\n'));
    const { names } = prepareSkills('build');
    expect(names).toContain('wayfinder:fluent');
    expect(names).not.toContain('wayfinder:cmdb-health');
    expect(skillAllowed('wayfinder:fluent')).toBe(true);
    expect(skillAllowed('fluent')).toBe(true);
    expect(skillAllowed('wayfinder:cmdb-health')).toBe(false);
    expect(skillAllowed('frontend-design')).toBe(false);
    expect(skillAllowed(undefined)).toBe(false);
  });
});

describe('nothing loads from the machine', () => {
  const agent = readFileSync(new URL('../src/server/agent.ts', import.meta.url), 'utf8');
  it('settingSources stays empty and the skills list is explicit', () => {
    expect(agent).toContain('settingSources: [],');
    expect(agent).toContain('plugins: [skills.plugin],');
    expect(agent).toContain('skills: skills.names,');
    expect(agent).not.toMatch(/skills: 'all'/);
    expect(agent).not.toMatch(/\.claude['/]/);
  });
});

describe('editing a skill from Settings', () => {
  it('reads the shipped file, saves your copy (checked first), and removing it brings the shipped one back', async () => {
    const { readSkillFile, removeUserSkill, saveUserSkill, USER_DIR } = await import('../src/server/skills.ts');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readSkillFile('debug-method')).toMatchObject({ origin: 'shipped', shipped: true });
    expect(readSkillFile('../etc')).toBeNull();
    expect(() => saveUserSkill('debug-method', 'no front matter')).toThrow('front matter');
    expect(() => saveUserSkill('debug-method', '---\nname: other\ndescription: x\n---\nbody')).toThrow('named "other"');
    saveUserSkill('debug-method', '---\nname: debug-method\ndescription: Mine.\nmode: debug\n---\nStart from the log.');
    expect(readSkillFile('debug-method')).toEqual({ text: '---\nname: debug-method\ndescription: Mine.\nmode: debug\n---\nStart from the log.', origin: 'yours', shipped: true });
    expect(existsSync(join(USER_DIR, 'debug-method', 'SKILL.md'))).toBe(true);
    saveUserSkill('mine', '---\nname: mine\ndescription: New.\n---\nA new skill.');
    expect(readSkillFile('mine')).toMatchObject({ origin: 'yours', shipped: false });
    removeUserSkill('debug-method'); removeUserSkill('mine');
    expect(readSkillFile('debug-method')!.origin).toBe('shipped');
    expect(readSkillFile('mine')).toBeNull();
  });
});
