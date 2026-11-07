import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sdkRoot, sdkVersionAt } from './sdkRoot.ts';

// Keeps the Fluent cheat sheet honest: its examples are compiled together as a real app (in CI, after an SDK upgrade,
// and before any learned rule is offered), so the prompt never teaches code that no longer builds.

export const sdkVersion = (root = sdkRoot().path): string => sdkVersionAt(root);
export const sheetVersion = (sheet: string) => /ServiceNow SDK (\d+\.\d+\.\d+)/.exec(sheet)?.[1] ?? null;
export const sameMinor = (a: string | null, b: string | null) => !!a && !!b && a.split('.').slice(0, 2).join('.') === b.split('.').slice(0, 2).join('.');

// The server module the Logic example imports.
const LOAN_RULES = `import { GlideRecord } from '@servicenow/glide'

export function markLoaned(current: any, _previous: any) {
    const item = new GlideRecord('x_acme_loan_item')
    if (item.get(current.getValue('item'))) {
        item.setValue('status', 'loaned')
        item.update()
    }
}
`;

// "## Heading (file.now.ts)" followed by a ```ts block becomes that file.
export function sheetFiles(sheet: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const re = /^## [^\n]*?\(([\w-]+\.now\.ts)\)[^\n]*\n```ts\n([\s\S]*?)\n```/gm;
  for (let m; (m = re.exec(sheet));) out.push({ path: `src/fluent/${m[1]}`, content: m[2] + '\n' });
  if (out.some((f) => f.content.includes('../server/loan-rules'))) out.push({ path: 'src/server/loan-rules.ts', content: LOAN_RULES });
  return out;
}

// A throwaway app folder (scope x_acme_loan, like the examples) holding the given files, ready for `now-sdk build`.
export function scaffold(parent: string, nodeModules: string, files: { path: string; content: string }[]): string {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'fluent-check-'));
  writeFileSync(join(dir, 'now.config.json'), JSON.stringify({ scope: 'x_acme_loan', scopeId: randomBytes(16).toString('hex'), name: 'Loaner' }, null, 2));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fluent-check', version: '0.0.1', private: true }, null, 2));
  symlinkSync(nodeModules, join(dir, 'node_modules'), 'dir');
  for (const f of files) { mkdirSync(join(dir, f.path, '..'), { recursive: true }); writeFileSync(join(dir, f.path), f.content); }
  return dir;
}

export const readSheet = () => readFileSync(new URL('./fluent-cheatsheet.md', import.meta.url), 'utf8');
