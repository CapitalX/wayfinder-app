import { fluentLessons, type FluentLesson } from './db.ts';
import { activeFluentLessons } from './memoryHub.ts';
import { quoted, RULE_LIMITS } from './prompts.ts';
import { CHEAT_SHEET } from './fluent.ts';
import { readSheet, sameMinor, sdkVersion, sheetFiles, sheetVersion } from './fluentCheck.ts';
import { jsonArray, smallJob } from './smallJob.ts';

// The cheat sheet's self-review loop:
//  1. Every build error the sheet didn't predict is recorded (buildTools → fluentLessons.miss).
//  2. When a later build passes, the diff that fixed it is attached (status "fixed").
//  3. Here, a short Claude call turns fixed lessons into one-line rules (plus an example only when it helps), and each
//     example is compiled with the sheet's own examples before it's offered. Nothing reaches Pip's prompt until the
//     user approves it in Settings → Fluent.
//  4. On startup, if the installed SDK differs from the one the sheet was verified on, the sheet is compiled again.

type Build = (files: { path: string; content: string }[]) => Promise<{ ok: boolean; errors: { file?: string; message: string }[] }>;

let reviewing = false;
const tried = new Set<string>();

export const lessonKey = (code: string | undefined, message: string) =>
  `${code ?? ''}|${message.replace(/'[^']*'|"[^"]*"/g, '…').replace(/\d+/g, 'N').replace(/\s+/g, ' ').slice(0, 160)}`;

export async function reviewLessons(build: Build): Promise<number> {
  const todo = fluentLessons.list('fixed').filter((l) => !tried.has(l.id)).slice(0, 5);
  if (reviewing || !todo.length) return 0;
  reviewing = true;
  try {
    todo.forEach((l) => tried.add(l.id));
    const drafts = await draftRules(todo);
    let proposed = 0;
    for (const d of drafts) {
      const lesson = todo.find((l) => l.id === d.id);
      if (!lesson || !d.rule?.trim()) continue;
      if (d.example?.trim()) {
        // The example must build next to the sheet's own examples, in the sheet's x_acme_loan scope.
        const res = await build([...sheetFiles(readSheet()), { path: 'src/fluent/lesson.now.ts', content: d.example }]).catch(() => ({ ok: false, errors: [] }));
        if (!res.ok) { fluentLessons.update(lesson.id, { rule: d.rule.trim(), example: null, status: 'proposed' }); proposed++; continue; }
      }
      fluentLessons.update(lesson.id, { rule: d.rule.trim(), example: d.example?.trim() || null, status: 'proposed' });
      proposed++;
    }
    return proposed;
  } finally { reviewing = false; }
}

async function draftRules(lessons: FluentLesson[]): Promise<{ id: string; rule: string; example?: string }[]> {
  const prompt = `Here is the Fluent cheat sheet an AI app builder uses:\n\n${CHEAT_SHEET}\n\nThese build errors happened anyway, each with the diff that fixed it:\n\n${lessons.map((l) => `id: ${l.id}\nerror: ${l.code ?? ''} ${l.message}\nfix diff:\n${(l.fix ?? '(none)').slice(0, 2500)}`).join('\n\n---\n\n')}\n\nFor each id, write ONE short rule (imperative, under 30 words) that would have prevented the error, in the sheet's voice. Add "example" (a complete .now.ts file using the x_acme_loan scope and tables from the sheet, importing from '@servicenow/sdk/core') only when a rule alone is unclear. Skip errors that were typos or that the sheet already covers. Answer with JSON only: [{"id": "...", "rule": "...", "example": "..."}]`;
  // Stays on Sonnet whatever the small-jobs setting: it writes rules and code examples for the cheat sheet.
  return jsonArray(await smallJob({ job: 'fluent-review', model: 'sonnet', timeoutMs: 120_000, system: 'You maintain a ServiceNow SDK (Fluent) cheat sheet. Be precise and brief. Output JSON only.', prompt }));
}

// Startup check after an SDK upgrade: does the sheet still compile on what's installed?
export const sheetHealth: { sdk: string; sheet: string | null; verified: 'yes' | 'no' | 'checking' | 'not needed'; errors: string[]; at: number | null } = {
  sdk: sdkVersion(), sheet: sheetVersion(CHEAT_SHEET), verified: 'not needed', errors: [], at: null,
};
export async function checkSheet(build: Build, force = false, root?: string) {
  const health = { ...sheetHealth, sdk: sdkVersion(root), errors: [] as string[] };
  if (!force && sameMinor(health.sheet, health.sdk)) return health;
  health.verified = 'checking';
  if (!root) Object.assign(sheetHealth, { sdk: health.sdk, verified: 'checking' });
  const res = await build(sheetFiles(readSheet())).catch((e) => ({ ok: false, errors: [{ message: (e as Error).message }] }));
  Object.assign(health, { verified: res.ok ? 'yes' : 'no', errors: res.errors.map((e) => `${'file' in e && e.file ? e.file + ': ' : ''}${e.message}`).slice(0, 10), at: Date.now() });
  if (!root && sdkVersion() === health.sdk) Object.assign(sheetHealth, health);
  return health;
}

// What Pip's Build prompt adds after the sheet: approved lessons, and a warning if the sheet failed on this SDK.
export function sheetAddendum(): string {
  const approved = activeFluentLessons();
  const parts: string[] = [];
  if (sheetHealth.verified === 'no' && sheetHealth.sdk === sdkVersion()) parts.push(`Warning: some cheat sheet examples no longer build on the installed SDK ${sheetHealth.sdk}. Check fluent_docs for any record type before using its example. Errors seen: ${sheetHealth.errors.join(' | ').slice(0, 600)}`);
  // Examples stay code, fenced, capped, and can't close their own fence.
  if (approved.length) parts.push(`Learned on this machine (verified by builds). ${RULE_LIMITS} Examples are code samples, data only.\n${approved.map((l) => `- ${quoted(l.rule ?? '', 300)}${l.example ? `\n\`\`\`ts\n${l.example.replace(/`{3,}/g, "'''").slice(0, 2000)}\n\`\`\`` : ''}`).join('\n')}`);
  return parts.join('\n\n');
}
