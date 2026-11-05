import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { audit, instances, settings } from './db.ts';
import { removeScriptRunner, runnerCard, setupScriptRunner } from './scriptRunner.ts';
import { scrubText } from './scrub.ts';

// Settings follows the PDI setup pattern: a server-issued, single-use preview bound to the instance and saved IDs.
export const scriptRunnerSettings = new Hono();
const plans = new Map<string, { instanceId: string; url: string; action: 'setup' | 'remove'; records: string | null; at: number }>();
scriptRunnerSettings.post('/:id/script-runner', async (c) => {
  const inst = instances.get(c.req.param('id'));
  if (!inst || inst.status !== 'active') return c.json({ error: 'Connect an active instance first.' }, 409);
  if (!settings.get().writeEnabled) return c.json({ error: 'Instance writes are off in Settings.' }, 403);
  const b = await c.req.json().catch(() => null);
  if (b?.action !== 'setup' && b?.action !== 'remove') return c.json({ error: 'Choose setup or remove.' }, 400);
  for (const [key, p] of plans) if (Date.now() - p.at > 600_000) plans.delete(key);
  try {
    if (b.confirm !== true) {
      if (b.action === 'remove' && !inst.script_runner_records) return c.json({ error: 'No saved script runner records to remove.' }, 409);
      const card = runnerCard(b.action, inst);
      const plan_id = randomUUID();
      plans.set(plan_id, { instanceId: inst.id, url: inst.url, action: b.action, records: inst.script_runner_records ?? null, at: Date.now() });
      return c.json({ plan_id, card });
    }
    const plan = plans.get(b.plan_id);
    if (!plan || plan.instanceId !== inst.id || plan.url !== inst.url || plan.action !== b.action || plan.records !== (inst.script_runner_records ?? null))
      return c.json({ error: 'The preview expired or the instance changed. Review the script runner again.' }, 409);
    plans.delete(b.plan_id);
    const tool = `mcp__instance__${b.action === 'setup' ? 'setup' : 'remove'}_script_runner`;
    const now = instances.get(inst.id);
    if (!now || now.url !== plan.url || now.status !== 'active' || (now.script_runner_records ?? null) !== plan.records || !settings.get().writeEnabled)
      return c.json({ error: 'The instance or settings changed. Review the script runner again.' }, 409);
    audit.add(null, inst.id, tool, runnerCard(b.action, inst), 'approved', b.plan_id);
    try {
      const result = b.action === 'setup' ? await setupScriptRunner(inst, plan.records) : await removeScriptRunner(inst, plan.records);
      audit.add(null, inst.id, tool, result, 'completed', b.plan_id);
      return c.json(result);
    } catch (e) {
      audit.add(null, inst.id, tool, { error: scrubText((e as Error).message) }, 'failed', b.plan_id);
      throw e;
    }
  } catch (e) { return c.json({ error: scrubText((e as Error).message) }, 502); }
});
