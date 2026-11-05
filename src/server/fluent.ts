import { readFileSync } from 'node:fs';

// What Build mode knows about Fluent without reading docs: a cheat sheet whose examples all compile (SDK 4.13),
// build output turned into structured errors with fix hints, and aliases for doc topics that are easy to get wrong.

export const CHEAT_SHEET = readFileSync(new URL('./fluent-cheatsheet.md', import.meta.url), 'utf8');

export interface BuildIssue { file?: string; line?: number; col?: number; code?: string; message: string; hint?: string }

// Known messages → the fix, from building the common mistakes on purpose.
const HINTS: [RegExp, string][] = [
  [/should be exported as a named export/, "Export the table as `export const <tableName> = Table({ name: '<tableName>' })`, same text."],
  [/Export assignments are not supported/, 'No `export default`: use a named export.'],
  [/should start with scope prefix/, 'Prefix the name with the app scope.'],
  [/Column name must only contain lowercase/, 'Column names are snake_case.'],
  [/Invalid column in table schema/, 'Check the column call; see the next error for the exact problem.'],
  [/is declared but its value is never read/, 'Remove the unused import, or don\'t assign a result you don\'t read.'],
  [/ArrayShape to ObjectShape|not assignable to type 'Choices/, "Choices are an object: { key: 'Label' }, never an array."],
  [/'referenceTable' is missing/, 'Add referenceTable to the ReferenceColumn.'],
  [/no exported member 'Now'/, "Don't import Now; it's global."],
  [/Role name must begin with/, 'Role names are <scope>.<name>, with a dot.'],
  [/Failed to determine ID|Property '\$id' is missing/, "Add $id: Now.ID['unique-key'] to this call."],
  [/is defined \d+ times in the project/, 'Make the Now.ID keys unique.'],
  [/Record<"sys_app_application">/, 'Set application to the menu object itself, not menu.$id.'],
  [/not assignable to type '\(string \| Role/, 'Roles go in an array: roles: [role].'],
  [/Unsupported statement in arrow function body|Cannot find name 'gs'/, 'Scripts are strings, Now.include(...) or an imported module function, never inline arrows.'],
  [/is not allowed in Fluent files/, 'No loops or ifs in .now.ts files: write each call out.'],
  [/'\("insert" \| "update"/, "BusinessRule action is an array: action: ['insert']."],
  [/Did you mean/, 'Use the suggestion in the message.'],
  [/No file found at path/, 'Now.include paths are relative to the .now.ts file.'],
  [/is not a valid sys_id/, 'Pass the Test (or record) object, not a name string.'],
  [/is listed more than once/, 'Remove the duplicate from the suite.'],
  [/`?\$\{number\}-/, "Dates are 'YYYY-MM-DD', date-times 'YYYY-MM-DD HH:mm:ss'. If it's an inherited task field, don't redeclare it."],
];
const hintFor = (m: string) => HINTS.find(([re]) => re.test(m))?.[1];

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// `[now-sdk] ERROR: file:line:col - error TSnnn: message`, its indented chain lines, then a code frame (dropped).
// Plugin failures and duplicate-record conflicts have no position. The first errors are kept, not the tail.
export function parseBuild(raw: string): { errors: BuildIssue[]; warnings: BuildIssue[] } {
  const errors: BuildIssue[] = [], warnings: BuildIssue[] = [];
  let last: BuildIssue | null = null;
  for (const line of strip(raw).split('\n')) {
    const m = /^\[now-sdk\] (ERROR|WARN): (.+?):(\d+):(\d+) - (?:error|warning) TS(\d+): (.*)$/.exec(line);
    if (m) {
      last = { file: m[2], line: +m[3], col: +m[4], code: `TS${m[5]}`, message: m[6].trim() };
      (m[1] === 'ERROR' ? errors : warnings).push(last);
      continue;
    }
    const p = /^\[now-sdk\] (ERROR|WARN): (.*)$/.exec(line);
    if (p) {
      if (/Found \d+ diagnostic|Build failed due to errors/.test(p[2])) { last = null; continue; }
      const src = /\(source: ([^)]+)\)/.exec(p[2])?.[1];
      last = { ...(src ? { file: src.replace(/^.*?\/(src\/)/, '$1') } : {}), message: p[2].replace(/\s*\(source: [^)]+\)/, '').trim() };
      (p[1] === 'ERROR' ? errors : warnings).push(last);
      continue;
    }
    // Chain lines (and conflict lines like `  1. file:line`) follow the main line; a blank line ends them, and the
    // code frame after it is dropped.
    if (last && /^ {2}\S/.test(line)) { last.message += ` ${line.trim()}`; continue; }
    if (!line.trim()) last = null;
  }
  for (const i of [...errors, ...warnings]) { i.message = i.message.slice(0, 400); const h = hintFor(i.message); if (h) i.hint = h; }
  return { errors: errors.slice(0, 25), warnings: warnings.slice(0, 10) };
}

// Topic names people (and models) reach for, mapped to the page that answers them.
export const DOC_ALIAS: Record<string, string> = {
  menu: 'applicationmenu-api', 'application-menu': 'applicationmenu-api', module: 'applicationmenu-api',
  suite: 'testsuite-api', 'test-suite': 'testsuite-api', test: 'test-api', atf: 'atf-guide',
  table: 'table-api', acl: 'acl-api', role: 'role-api', 'business-rule': 'businessrule-api', br: 'businessrule-api',
  'script-include': 'scriptinclude-api', 'client-script': 'clientscript-api', 'ui-policy': 'uipolicy-api', 'ui-action': 'uiaction-api',
  record: 'record-api', choice: 'choicecolumn-api', reference: 'referencecolumn-api', form: 'form-api', list: 'list-api',
  flow: 'flow-api', subflow: 'subflow-api', 'subflow-guide': 'wfa-subflow-guide', action: 'custom-action-api', 'custom-action': 'custom-action-api',
  'action-step': 'custom-action-api', actionstep: 'custom-action-api', 'flow-actions': 'wfa-flow-actions-guide', 'action.core': 'action-api',
  'flow-logic': 'wfa-flow-logic-api', trigger: 'trigger-api', wfa: 'wfa-api',
};

// One section of a doc page (e.g. "properties", "examples"), so a lookup costs a few KB instead of 30.
export function docSection(page: string, section: string): string {
  const lines = page.split('\n');
  const want = section.toLowerCase();
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.toLowerCase().includes(want));
  if (start < 0) return page;
  const level = lines[start].match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}
