import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../src/server/config.ts';
import { placementRules, runScenarios, type Scenario } from '../src/server/placement.ts';

// Runs the placement scenarios (shipped, plus yours in <config>/placement-scenarios.json) against the placement rules
// in use here (the shipped skill, or yours in <config>/skills/placement/SKILL.md). Exits 1 on any miss.
const read = (file: string): Scenario[] => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
const shipped = read(new URL('../tests/fixtures/placement-scenarios.json', import.meta.url).pathname);
const yours = read(join(CONFIG_DIR, 'placement-scenarios.json'));
const { rules, warnings, origin } = placementRules();
for (const w of warnings) console.log(`warning: ${w}`);
const results = runScenarios([...shipped, ...yours], rules);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `: expected ${r.expected.place}${r.expected.rule ? ` (${r.expected.rule})` : ''}, got ${r.got.place} (${r.got.rule})`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed (${shipped.length} shipped, ${yours.length} yours; rules: ${origin ?? 'none'})`);
process.exit(failed ? 1 : 0);
