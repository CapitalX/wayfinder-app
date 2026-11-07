import { Hono } from 'hono';
import { parse } from './access.ts';
import { audit, instances } from './db.ts';
import { announce } from './events.ts';
import { checkSdkUpdate, sdkDecision, sdkState, startSdkInstall } from './sdkUpdates.ts';

export const sdkSettings = new Hono();
const isAdmin = () => { const inst = instances.active(); return inst?.status === 'active' && parse(inst)?.admin === true; };
const notify = () => announce('sdk');
sdkSettings.get('/', (c) => c.json(sdkState(isAdmin())));
sdkSettings.post('/', async (c) => {
  if (!isAdmin()) return c.json({ error: 'An instance admin is required to manage the ServiceNow SDK.' }, 403);
  const b = await c.req.json().catch(() => null);
  if (!b || !['check', 'install', 'keep', 'use', 'back'].includes(b.action) || (b.action !== 'check' && typeof b.version !== 'string'))
    return c.json({ error: 'Choose an SDK update action and version.' }, 400);
  try {
    if (b.action === 'check') await checkSdkUpdate(notify);
    else if (b.action === 'install') {
      const { done } = startSdkInstall(b.version, notify);
      void done.then((job) => audit.add(null, null, 'sdk update', { version: job.version, errors: job.errors }, job.state));
    } else await sdkDecision(b.action, b.version, notify);
    audit.add(null, instances.active()?.id ?? null, 'sdk update', { version: b.version, action: b.action }, 'requested by admin');
    return c.json(sdkState(isAdmin()));
  } catch (e) { return c.json({ error: (e as Error).message }, 409); }
});
