// What each mode sends before the user's first word: the system prompt and the definitions of Wayfinder's own tools
// (instance, pdi, project, and build in Build mode), minus the tools a mode doesn't get (modeTools.ts). Counted in characters, so
// it's the same on every machine. tests/contextSize.test.ts fails a change that grows a mode by more than 15% against
// tests/fixtures/context-baseline.json; to accept a bigger prompt on purpose, run `npm run eval:baseline` and commit it.
// Not counted: the SDK's built-in tools (the same for every mode).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const BASELINE = new URL('../tests/fixtures/context-baseline.json', import.meta.url);
export const GROWTH_LIMIT = 0.15;

export async function measure(): Promise<Record<string, { prompt: number; tools: number; total: number }>> {
  const { MODES, systemPrompt } = await import('../src/server/prompts.ts');
  const { settings } = await import('../src/server/db.ts');
  const { instanceServer } = await import('../src/server/instanceTools.ts');
  const { pdiServer } = await import('../src/server/pdiTools.ts');
  const { projectServer } = await import('../src/server/projectTools.ts');
  const { buildServer } = await import('../src/server/buildTools.ts');
  const { hiddenTools } = await import('../src/server/modeTools.ts');
  const inst = { id: 'measure', name: 'dev', url: 'https://dev12345.service-now.com', kind: 'pdi', status: 'active' } as any;
  const defs = (server: any, prefix: string) => Object.entries(server.instance._registeredTools as Record<string, any>).map(([name, t]) => ({
    name: `mcp__${prefix}__${name}`,
    size: name.length + (t.description ?? '').length + JSON.stringify(t.inputSchema ? z.toJSONSchema(t.inputSchema) : {}).length,
  }));
  const out: Record<string, { prompt: number; tools: number; total: number }> = {};
  for (const mode of Object.keys(MODES) as (keyof typeof MODES)[]) {
    const hidden = new Set(hiddenTools(mode));
    const tools = [...defs(instanceServer(inst, mode === 'build'), 'instance'), ...defs(pdiServer(inst, 'm'), 'pdi'), ...defs(projectServer(undefined, 'm'), 'project'), ...(mode === 'build' ? defs(buildServer(undefined, undefined, 'm'), 'build') : [])]
      .filter((t) => !hidden.has(t.name)).reduce((n, t) => n + t.size, 0);
    const prompt = systemPrompt(mode, undefined, settings.get(), { release: 'zurich' }).length;
    out[mode] = { prompt, tools, total: prompt + tools };
  }
  return out;
}

// Modes that grew past the limit, in plain words.
export function overLimit(now: Record<string, { total: number }>, base: Record<string, { total: number }>, limit = GROWTH_LIMIT): string[] {
  return Object.entries(now).filter(([m, v]) => base[m] && v.total > base[m].total * (1 + limit))
    .map(([m, v]) => `${m}: ${v.total} characters, ${Math.round((v.total / base[m].total - 1) * 100)}% more than the baseline ${base[m].total}`);
}

if (process.argv[1]?.endsWith('context-size.ts')) {
  // Empty, throwaway data and config folders: the shipped prompt and skills only, never someone's own rules or memories.
  const dir = mkdtempSync(join(tmpdir(), 'wayfinder-context-'));
  for (const k of Object.keys(process.env)) if (k.startsWith('WAYFINDER_') || k.startsWith('SNW_')) delete process.env[k];
  Object.assign(process.env, { WAYFINDER_DATA_DIR: join(dir, 'data'), WAYFINDER_CONFIG_DIR: join(dir, 'config'), WAYFINDER_SANDBOX: 'off', WAYFINDER_SMALL_JOBS: 'off' });
  const now = await measure();
  if (process.argv.includes('--write')) { writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`); console.log('Baseline written:', BASELINE.pathname); }
  console.table(now);
  process.exit(0);
}
