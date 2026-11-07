// First: refuse an old Node with a plain message, before anything loads node:sqlite.
import './nodeCheck.ts';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { HOST, PORT } from './config.ts';
import { BUDGET_CHOICES, spentToday } from './budget.ts';
import { continueChat } from './carryOver.ts';
import { apps, artifacts, audit, conventions, fluentLessons, toolLessons, pauses, board, boardKey, chats, instances, jobs, memories, messages, perf, projects, routines, sends, settings, type ArtifactKind, type BoardKind, type BoardStatus, type AuthMethod, type MemoryScope, type MemoryStatus, type RuleKind, type Settings } from './db.ts';
import { findFeatures } from './features.ts';
import { scanConventions } from './conventions.ts';
import { appLink, buildScratch, cancelInstall, diffBuilds, driftSince, failOrphanedInstalls, readSpec, restoreTo, timeline } from './buildTools.ts';
import { clearTranscripts } from './transcripts.ts';
import { specHash } from './db.ts';
import { announce, bus } from './events.ts';
import { instancePulse, suggestionsFor } from './suggestions.ts';
import { cleanFilter, clearPulse } from './insights.ts';
import { clearImpact, impactLine, type ImpactTarget } from './impact.ts';
// Insights read the instance as a given sign-in; a new sign-in or instance starts them afresh.
const clearInsights = (id: string) => { clearPulse(id); clearImpact(id); };
import { setupState, testClaude } from './setup.ts';
import { docsAuto, docsJob, freeBytes, localInfo, NEED_BYTES, startDocsAutoUpdate, startDocsSetup } from './docsLocal.ts';
import { activeFacts, clearFacts, docsRelease, instanceFacts } from './facts.ts';
import { checkSheet, reviewLessons, sheetHealth } from './fluentReview.ts';
import { docReleases, docsSource } from './docs.ts';
import { APPS_DIR, DATA_DIR } from './config.ts';
import { startJobPoller } from './jobs.ts';
import { answering, isRunning, noteCutOff, runChat, stop, stopAllForRestart } from './agent.ts';
import { followLive } from './liveAnswer.ts';
import { clearUpdating, updating, UPDATING } from './updating.ts';
import { decide } from './policy.ts';
import { MODES } from './prompts.ts';
import { secrets } from './secrets.ts';
import { toolServers, serverConfig, discoverTools } from './toolServers.ts';
import { runRoutine, saveRoutine, startRoutines, templates as routineTemplates } from './routines.ts';
import { validZone } from './clock.ts';
import { activatePlugin, batchInstall, InstanceError, pdiStatus, sn, table, testSignIn, tokenRequest } from './sn.ts';
import { can, checkAccess, parse as parseAccess } from './access.ts';
import { createHash, randomBytes } from 'node:crypto';
import { checkNow, currentStatus, startMonitor } from './monitor.ts';
import { backupUpdateSets } from './backup.ts';
import { changeInstanceUrl, isPdiUrl, parseInstanceUrl } from './instanceUrl.ts';
import { mergeDuplicates, reconnect, removeInstance } from './instanceRows.ts';
import { CSP } from './csp.ts';
import { secureCookie, securityHeaders } from './httpSecurity.ts';
import { chatPlacement, choose, placementRules, resetRulesFile, rulesFile, saveRulesFile, serializeRules, settledNote, type Rule } from './placement.ts';
import { afterPlacement } from './followup.ts';
import { deleteRule, hub } from './memoryHub.ts';
import { loadSkills, readSkillFile, removeUserSkill, saveUserSkill, USER_DIR as SKILLS_DIR } from './skills.ts';
import { applyPdiSetup, INTEGRATION_USER, planPdiSetup, SetupError } from './pdiSetup.ts';
import { scriptRunnerSettings } from './scriptRunnerSettings.ts';

const app = new Hono();
const COOKIE = 'snw_session';

app.use('*', securityHeaders);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Request size limits, counted while the body streams in, so an oversized request is refused before it is all in
// memory: 4 MB for every API route (saved mockups are the largest JSON).
const jsonLimit = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'That is too large to send.' }, 413) });

// Every /api route needs the app token (cookie from /api/login, or a bearer header).
// GET /api/status also accepts the status-only token.
// Writes must be JSON from this origin, which blocks cross-site form posts.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET') {
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
    if (origin && host && new URL(origin).host !== host) return c.json({ error: 'cross-origin request refused' }, 403);
    const type = c.req.header('content-type') ?? '';
    if (!type.includes('application/json')) return c.json({ error: 'send JSON' }, 415);
  }
  if (c.req.path === '/api/login') return next();
  // The OAuth redirect back from the instance: a top-level navigation from another site, so the SameSite=Strict
  // cookie isn't sent. It's checked by its one-time state value instead (see /api/oauth/callback).
  if (c.req.method === 'GET' && c.req.path === '/api/oauth/callback') return next();
  const bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
  const token = bearer ?? getCookie(c, COOKIE) ?? '';
  if (c.req.method === 'GET' && c.req.path === '/api/status' && bearer && same(bearer, secrets.statusToken())) return next();
  if (!same(token, secrets.appToken())) return c.json({ error: 'login required' }, 401);
  return next();
});
app.use('/api/*', jsonLimit);

app.post('/api/login', async (c) => {
  const { token } = await c.req.json<{ token?: string }>();
  if (!token || !same(token, secrets.appToken())) return c.json({ error: 'wrong token' }, 401);
  const secure = secureCookie(c.req);
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure, path: '/', maxAge: 60 * 60 * 24 * 90 });
  return c.json({ ok: true });
});

app.get('/api/session', (c) => c.json({ ok: true, modes: MODES }));

// Rotating the app token signs every browser out (the cookie is the token); this browser gets the new one.
app.post('/api/token/rotate', (c) => {
  const token = secrets.rotateAppToken();
  const secure = secureCookie(c.req);
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure, path: '/', maxAge: 60 * 60 * 24 * 90 });
  audit.add(null, null, 'app token', {}, 'rotated (all other browsers signed out)');
  return c.json({ token });
});

// Version and release notes for the What's new panel; changelog.json ships with the repo, newest first.
const readJson = (file: string) => { try { return JSON.parse(readFileSync(join(process.cwd(), file), 'utf8')); } catch { return null; } };
app.get('/api/about', (c) => c.json({ version: readJson('package.json')?.version ?? '0.0.0', changelog: readJson('changelog.json') ?? [] }));

// Pip's greeting on the home screen: built from what's going on, no model call, so it's instant.
// Pip's hello on the home screen: the most recent thing you did (a chat, an app, a finished install), what's next for
// it, and a button to pick it back up. Instance warnings come first; the time of day is only the opener.
app.get('/api/greeting', (c) => {
  const hour = Number(c.req.query('hour') ?? new Date().getHours());
  const hello = hour < 5 ? 'Late one.' : hour < 12 ? 'Morning.' : hour < 18 ? 'Afternoon.' : 'Evening.';
  const status = currentStatus();
  const ago = (t: number) => {
    const m = Math.floor((Date.now() - t) / 60_000);
    return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.floor(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.floor(m / 1440)} days ago`;
  };
  const warn = status?.state === 'hibernating' ? 'Your PDI is asleep; wake it from the developer site and I can get back to it.'
    : status?.remind ? `It's been ${status.daysSinceLogin} days since you logged in to your PDI; one login keeps it from being reclaimed.` : '';
  const MODE_VERB: Record<string, string> = { explore: 'looking into', mockup: 'mocking up', decide: 'deciding on', debug: 'debugging', build: 'building' };
  const NEXT: Record<string, [string, string]> = {
    draft: ['is planned but not built yet', 'Build it'], built: ['built cleanly and is ready to install', 'Install it'],
    build_failed: ['has a build error I can fix', 'Fix the build'], installing: ['is installing now', 'Watch it'],
    installed: ['is installed', 'Review it'], install_failed: ['failed to install', 'See why'], removed: ['was removed', 'Open it'],
  };
  type Pick = { at: number; line: string; action?: { label: string; chatId?: string; projectId?: string } };
  const picks: Pick[] = [];
  const chat = chats.list().find((x) => x.title && x.title !== 'New chat');
  if (chat) picks.push({ at: chat.updated_at, line: `Last time (${ago(chat.updated_at)}) we were ${MODE_VERB[chat.mode] ?? "on"} “${chat.title}”.`, action: { label: 'Continue', chatId: chat.id } });
  const app = apps.list()[0];
  if (app) { const [what, label] = NEXT[app.status] ?? [app.status, 'Open it']; picks.push({ at: app.updated_at + 1, line: `${app.name} ${what} (${ago(app.updated_at)}).`, action: app.chat_id ? { label, chatId: app.chat_id } : app.project_id ? { label, projectId: app.project_id } : undefined }); }
  const job = jobs.recent().find((j) => j.status === 'successful' && j.kind !== 'app_install');
  if (job?.finished_at) picks.push({ at: job.finished_at, line: `${job.target.split('@')[0]} finished installing ${ago(job.finished_at)}.`, action: job.chat_id ? { label: 'Explore it', chatId: job.chat_id } : undefined });
  const latest = picks.sort((a, b) => b.at - a.at)[0];
  const line = [warn, latest?.line ?? 'Ask me anything below, or describe an app and I\'ll plan it.'].filter(Boolean).join(' ');
  return c.json({ hello, line, action: latest?.action ?? null });
});

// Chats
app.get('/api/chats', (c) => c.json(chats.list()));
app.post('/api/chats', async (c) => {
  const { mode, project_id } = await c.req.json<{ mode?: string; project_id?: string | null }>();
  const project = project_id ? projects.get(project_id) : undefined;
  return c.json(chats.create(mode && mode in MODES ? mode : 'explore', instances.active()?.id ?? null, project?.id ?? null));
});
app.get('/api/chats/:id', (c) => {
  const chat = chats.get(c.req.param('id'));
  if (!chat) return c.json({ error: 'not found' }, 404);
  const inst = chat.instance_id ? instances.get(chat.instance_id) : undefined;
  // Apps this chat can put on auto: ones it made, or ones in its project.
  const chatApps = apps.list().filter((a) => a.chat_id === chat.id || (!!chat.project_id && a.project_id === chat.project_id)).map((a) => ({ id: a.id, name: a.name, status: a.status }));
  return c.json({ chat, instance: inst ?? null, running: isRunning(chat.id), messages: messages.list(chat.id), apps: chatApps });
});
app.patch('/api/chats/:id', async (c) => {
  const body = await c.req.json<{ title?: string; mode?: string; project_id?: string | null; auto_mode?: 'ask' | 'app' | 'project'; auto_app_id?: string }>();
  const project_id = body.project_id === null ? null : body.project_id && projects.get(body.project_id) ? body.project_id : undefined;
  chats.update(c.req.param('id'), { title: body.title?.trim() || undefined, mode: body.mode && body.mode in MODES ? body.mode : undefined, project_id });
  // Auto mode: only this route (a click by the user) can turn it on; it lasts two hours.
  if (body.auto_mode === 'ask') chats.update(c.req.param('id'), { auto_mode: 'ask', auto_until: null, auto_app_id: null });
  else if (body.auto_mode === 'app' || body.auto_mode === 'project') {
    const chat = chats.get(c.req.param('id'));
    if (body.auto_mode === 'app' && !(body.auto_app_id && apps.get(body.auto_app_id))) return c.json({ error: 'Pick an app for auto mode.' }, 400);
    if (body.auto_mode === 'project' && !chat?.project_id) return c.json({ error: 'This chat is not in a project.' }, 400);
    chats.update(c.req.param('id'), { auto_mode: body.auto_mode, auto_until: Date.now() + 2 * 3_600_000, auto_app_id: body.auto_mode === 'app' ? body.auto_app_id! : null });
    audit.add(c.req.param('id'), chat?.instance_id ?? null, 'auto mode', { mode: body.auto_mode, app: body.auto_app_id }, 'turned on for 2 hours');
  }
  return c.json(chats.get(c.req.param('id')));
});
app.delete('/api/chats/:id', (c) => {
  // The SDK's own transcripts of this chat go too, so deleting a chat leaves nothing of it on this machine.
  const sessions = chats.sessions(c.req.param('id'));
  chats.remove(c.req.param('id'));
  const transcripts = clearTranscripts(sessions);
  return c.json({ ok: true, transcripts });
});
// Carry on in a fresh chat that starts from a summary of this one (session hygiene).
app.post('/api/chats/:id/continue', async (c) => {
  const chat = chats.get(c.req.param('id'));
  if (!chat) return c.json({ error: 'not found' }, 404);
  if (isRunning(chat.id)) return c.json({ error: 'This chat is still answering. Stop it or wait, then continue in a fresh chat.' }, 409);
  return c.json(await continueChat(chat, instances.active()?.id ?? null));
});
app.post('/api/chats/:id/stop', (c) => { stop(c.req.param('id')); return c.json({ ok: true }); });

app.post('/api/chats/:id/send', async (c) => {
  const id = c.req.param('id');
  const { text, sendId, tz } = await c.req.json<{ text?: string; sendId?: unknown; tz?: unknown }>();
  if (!text?.trim()) return c.json({ error: 'empty message' }, 400);
  // The browser's clock travels with each message, so Pip and the routines follow the person's time zone.
  if (validZone(tz) && tz !== settings.get().timeZone) settings.set({ timeZone: tz });
  if (sendId !== undefined && (typeof sendId !== 'string' || !/^[\w-]{8,64}$/.test(sendId))) return c.json({ error: 'bad send id' }, 400);
  if (!chats.get(id)) return c.json({ error: 'not found' }, 404);
  if (sendId && sends.seen(sendId)) return c.json({ error: 'already sent', duplicate: true }, 409);   // a resend: the page follows the answer instead
  if (isRunning(id)) return c.json({ error: 'already answering' }, 409);
  if (updating()) return c.json({ error: UPDATING, updating: true }, 503);   // nothing saved; the page sends it again
  if (sendId) sends.take(sendId, id);
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const done = runChat(id, text.trim(), (event) => {
      queue.push(JSON.stringify(event));
      wake?.();
    }).catch((e) => queue.push(JSON.stringify({ t: 'notice', level: 'error', text: (e as Error).message }), JSON.stringify({ t: 'done' })))
      .finally(() => { finished = true; wake?.(); });
    // Keep sending while the client listens; if it leaves, the run still finishes and is saved.
    while (!finished || queue.length) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
      wake = null;
      if (!queue.length) { await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {}); continue; }
      const data = queue.shift()!;
      await stream.writeSSE({ data }).catch(() => {});
    }
    await done;
  });
});

// The answer this chat is giving right now, from its first event, then live until it's done (liveAnswer.ts). A page
// that opens a chat mid-answer streams this instead of waiting for the saved answer.
app.get('/api/chats/:id/live', (c) => {
  const id = c.req.param('id');
  if (!chats.get(id)) return c.json({ error: 'not found' }, 404);
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished = false, gone = false;
    stream.onAbort(() => { gone = true; wake?.(); });
    const unfollow = followLive(id, (e) => { queue.push(JSON.stringify(e)); if (e.t === 'done') finished = true; wake?.(); });
    try {
      while (!gone && (!finished || queue.length)) {
        if (!queue.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
        wake = null;
        if (!queue.length) { await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {}); continue; }
        await stream.writeSSE({ data: queue.shift()! }).catch(() => { gone = true; });
      }
    } finally { unfollow(); }
  });
});

app.post('/api/chats/:chatId/approvals/:id', async (c) => {
  const { allow } = await c.req.json<{ allow?: boolean }>();
  return decide(c.req.param('chatId'), c.req.param('id'), allow === true) ? c.json({ ok: true }) : c.json({ error: 'no such approval (it may have timed out)' }, 404);
});

// Where a chat's work lives: the card Pip showed (or the choice made), the user's answer, and the apps to pick from.
app.get('/api/chats/:id/placement', (c) => c.json({ placement: chatPlacement(c.req.param('id')) }));
app.post('/api/chats/:id/placement', async (c) => {
  const chat = chats.get(c.req.param('id'));
  if (!chat) return c.json({ error: 'not found' }, 404);
  const inst = instances.active();
  if (!inst || inst.id !== chat.instance_id) return c.json({ error: "This chat's instance isn't the active one; switch to it first." }, 409);
  const { id, by, scope } = await c.req.json<{ id?: string; by?: string; scope?: string }>();
  if (by !== 'accept' && by !== 'other' && by !== 'new-app') return c.json({ error: 'Pick one of the options.' }, 400);
  try {
    const done = await choose(inst, chat.id, String(id ?? ''), { by, scope });
    afterPlacement(chat.id, settledNote(done));
    return c.json({ placement: done });
  } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
// The placement rules as one editable file (Settings → Pip): read, save your version, or go back to the shipped one.
app.get('/api/placement/rules', (c) => c.json(rulesFile()));
// Saved as text (the file as typed) or as a list of rules (the cards), which is written in the file's format first.
app.post('/api/placement/rules', async (c) => {
  const b = await c.req.json<{ text?: string; rules?: unknown }>();
  const text = typeof b.text === 'string' ? b.text : Array.isArray(b.rules) && b.rules.length <= 50 ? serializeRules(rulesFile().text, b.rules as Rule[]) : null;
  if (text === null) return c.json({ error: 'Send the rules as text or as a list.' }, 400);
  try { saveRulesFile(text); return c.json(rulesFile()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.post('/api/placement/rules/reset', (c) => {
  try { resetRulesFile(); return c.json(rulesFile()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.get('/api/placement/apps', async (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ apps: [] });
  const rows = await table(inst, 'sys_app', 'active=true^ORDERBYname', 'scope,name', 200).catch(() => [] as any[]);
  return c.json({ apps: [{ scope: 'global', name: 'Global' }, ...rows.filter((r) => r.scope).map((r) => ({ scope: r.scope, name: r.name || r.scope }))] });
});

// Projects: chats, saved items and built apps grouped under a goal.
const appView = (a: ReturnType<typeof apps.get>) => {
  if (!a) return a;
  const inst = a.instance_id ? instances.get(a.instance_id) : undefined;
  return { ...a, spec: readSpec(a), link: appLink(inst, a), folder: join(APPS_DIR, a.scope) };
};
app.get('/api/projects', (c) => c.json(projects.list()));
app.post('/api/projects', async (c) => {
  const b = await c.req.json<{ name?: string; brief?: string }>();
  if (!b.name?.trim()) return c.json({ error: 'name is required' }, 400);
  return c.json(projects.create(b.name.trim().slice(0, 80), (b.brief ?? '').slice(0, 4000)));
});
app.get('/api/projects/:id', (c) => {
  const id = c.req.param('id');
  const project = id === 'none' ? null : projects.get(id);
  if (id !== 'none' && !project) return c.json({ error: 'not found' }, 404);
  const pid = project?.id ?? null;
  return c.json({
    project,
    chats: chats.list().filter((ch) => ch.project_id === pid),
    saved: artifacts.list(pid),
    apps: apps.list(pid).map(appView),
  });
});
app.patch('/api/projects/:id', async (c) => {
  const b = await c.req.json<{ name?: string; brief?: string }>();
  projects.update(c.req.param('id'), { name: b.name?.trim().slice(0, 80) || undefined, brief: b.brief === undefined ? undefined : b.brief.slice(0, 4000) });
  return c.json(projects.get(c.req.param('id')));
});
app.delete('/api/projects/:id', (c) => { projects.remove(c.req.param('id')); return c.json({ ok: true }); });

const KINDS: ArtifactKind[] = ['mockup', 'script', 'decision', 'note'];
app.post('/api/saved', async (c) => {
  const b = await c.req.json<{ chat_id?: string; kind?: ArtifactKind; title?: string; content?: string }>();
  const chat = b.chat_id ? chats.get(b.chat_id) : undefined;
  if (!b.content || !b.kind || !KINDS.includes(b.kind)) return c.json({ error: 'kind and content are required' }, 400);
  return c.json(artifacts.add({ project_id: chat?.project_id ?? null, chat_id: chat?.id ?? null, kind: b.kind, title: (b.title?.trim() || 'Untitled').slice(0, 120), content: b.content.slice(0, 200_000) }));
});
app.delete('/api/saved/:id', (c) => { artifacts.remove(c.req.param('id')); return c.json({ ok: true }); });
app.get('/api/apps/:id', async (c) => {
  const a = apps.get(c.req.param('id'));
  return a ? c.json({ ...appView(a), timeline: await timeline(a) }) : c.json({ error: 'not found' }, 404);
});
app.get('/api/apps/:id/diff', async (c) => {
  const a = apps.get(c.req.param('id'));
  if (!a) return c.json({ error: 'not found' }, 404);
  try { return c.json({ diff: await diffBuilds(a, c.req.query('from') ?? '', c.req.query('to') ?? '') }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.get('/api/apps/:id/drift', async (c) => {
  const a = apps.get(c.req.param('id'));
  const inst = a?.instance_id ? instances.get(a.instance_id) : undefined;
  if (!a || !inst || inst.status !== 'active' || a.status !== 'installed') return c.json({ count: 0, items: [] });
  try { return c.json(await driftSince(inst, a)); } catch { return c.json({ count: 0, items: [] }); }
});
// Approve plan: only a click here (never a tool) approves an app's plan, exactly as it stands now.
app.post('/api/apps/:id/approve-plan', (c) => {
  const a = apps.get(c.req.param('id'));
  if (!a) return c.json({ error: 'not found' }, 404);
  apps.update(a.id, { plan_approved: specHash(a.spec) });
  audit.add(a.chat_id, a.instance_id, 'approve plan', { app: a.name, scope: a.scope }, 'approved by you');
  return c.json({ ok: true });
});
app.post('/api/apps/:id/restore', async (c) => {
  const a = apps.get(c.req.param('id'));
  if (!a) return c.json({ error: 'not found' }, 404);
  if (a.status === 'installing' || a.status === 'removing') return c.json({ error: `Wait until it finishes ${a.status}.` }, 409);
  const { ref } = await c.req.json<{ ref?: string }>();
  try { return c.json({ restored: await restoreTo(a, String(ref ?? '')) }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});

// Memories: Pip proposes, the user saves, edits or dismisses.
app.get('/api/memories', (c) => {
  const list = c.req.query('all') ? memories.listAll() : memories.list();
  const chat = c.req.query('chat_id');
  return c.json(chat ? list.filter((m) => m.chat_id === chat) : list);
});
app.get('/api/memories/:id', (c) => { const m = memories.get(c.req.param('id')); return m ? c.json(m) : c.json({ error: 'not found' }, 404); });
app.post('/api/memories', async (c) => {
  const b = await c.req.json<{ text?: string; scope?: MemoryScope; project_id?: string | null }>();
  if (!b.text?.trim()) return c.json({ error: 'text is required' }, 400);
  const project = b.scope === 'project' && b.project_id ? projects.get(b.project_id) : undefined;
  return c.json(memories.add({ text: b.text.trim().slice(0, 400), why: 'Added by you', scope: project ? 'project' : 'core', project_id: project?.id ?? null, status: 'saved', chat_id: null }));
});
app.patch('/api/memories/:id', async (c) => {
  const b = await c.req.json<{ text?: string; status?: MemoryStatus; scope?: MemoryScope }>();
  const status = b.status && ['saved', 'dismissed', 'proposed'].includes(b.status) ? b.status : undefined;
  const scope = b.scope && ['core', 'project'].includes(b.scope) ? b.scope : undefined;
  memories.update(c.req.param('id'), { text: b.text?.trim().slice(0, 400) || undefined, status, scope, project_id: scope === 'core' ? null : undefined });
  return c.json(memories.get(c.req.param('id')));
});
app.delete('/api/memories/:id', (c) => { memories.remove(c.req.param('id')); return c.json({ ok: true }); });

// The Memory page: every rule Pip follows, the review queue, pause and delete.
const RULE_KINDS: RuleKind[] = ['memory', 'convention', 'tool', 'fluent'];
app.get('/api/memory-hub', (c) => {
  const p = placementRules();
  return c.json(hub(instances.active(), { rules: p.rules.map(({ id, place, why }) => ({ id, place, why })), origin: p.origin, file: join(SKILLS_DIR, 'placement', 'SKILL.md') }));
});
app.post('/api/memory-hub/pause', async (c) => {
  const { kind, id, paused } = await c.req.json<{ kind?: RuleKind; id?: string; paused?: boolean }>();
  if (!kind || !RULE_KINDS.includes(kind) || !id) return c.json({ error: 'kind and id are required' }, 400);
  pauses.set(kind, id, paused === true);
  audit.add(null, instances.active()?.id ?? null, 'memory hub', { kind, id }, paused === true ? 'paused' : 'resumed');
  return c.json({ ok: true });
});
app.post('/api/memory-hub/delete', async (c) => {
  const { kind, id } = await c.req.json<{ kind?: RuleKind; id?: string }>();
  if (!kind || !RULE_KINDS.includes(kind) || !id) return c.json({ error: 'kind and id are required' }, 400);
  return deleteRule(instances.active(), kind, id) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});
// One waiting suggestion at a time: keep it (optionally reworded) or let it go.
app.post('/api/memory-hub/review', async (c) => {
  const { kind, id, keep, text } = await c.req.json<{ kind?: string; id?: string; keep?: boolean; text?: string }>();
  if (kind === 'memory') {
    const m = memories.get(String(id ?? ''));
    if (!m || m.status !== 'proposed') return c.json({ error: 'That suggestion was already answered.' }, 409);
    memories.update(m.id, { status: keep ? 'saved' : 'dismissed', text: keep ? text?.trim().slice(0, 400) || undefined : undefined });
    return c.json({ ok: true });
  }
  if (kind === 'fluent') {
    const l = fluentLessons.get(String(id ?? ''));
    if (!l || l.status !== 'proposed') return c.json({ error: 'That suggestion was already answered.' }, 409);
    fluentLessons.update(l.id, { status: keep ? 'approved' : 'dismissed' });
    audit.add(null, null, 'fluent lesson', { rule: l.rule }, keep ? 'approved' : 'dismissed');
    return c.json({ ok: true });
  }
  return c.json({ error: 'kind is memory or fluent' }, 400);
});

// Investigation board: one per project, or per chat when the chat has no project.
const BOARD_KINDS: BoardKind[] = ['error', 'record', 'log', 'doc', 'hypothesis', 'note'];
const BOARD_STATUS: BoardStatus[] = ['open', 'tested', 'ruled_out', 'confirmed'];
const boardFor = (projectId?: string | null, chatId?: string | null) => {
  const chat = chatId ? chats.get(chatId) : undefined;
  const pid = projectId && projects.get(projectId) ? projectId : chat?.project_id ?? null;
  if (!pid && !chat) return null;
  return { key: boardKey(pid, chat?.id ?? null), chatId: chat?.id ?? null };
};
app.get('/api/board', (c) => {
  const b = boardFor(c.req.query('project_id'), c.req.query('chat_id'));
  return b ? c.json(board.list(b.key)) : c.json([]);
});
app.post('/api/board', async (c) => {
  const x = await c.req.json<{ project_id?: string; chat_id?: string; kind?: BoardKind; title?: string; detail?: string; link?: string; status?: BoardStatus }>();
  const b = boardFor(x.project_id, x.chat_id);
  if (!b) return c.json({ error: 'Open a chat or project first.' }, 400);
  if (!x.title?.trim()) return c.json({ error: 'title is required' }, 400);
  const link = x.link && /^https:\/\//.test(x.link) ? x.link.slice(0, 1000) : null;
  return c.json(board.add({ board: b.key, kind: x.kind && BOARD_KINDS.includes(x.kind) ? x.kind : 'note', title: x.title.trim().slice(0, 140), detail: (x.detail ?? '').slice(0, 4000), link, status: x.status && BOARD_STATUS.includes(x.status) ? x.status : 'open', author: 'you', chat_id: b.chatId }));
});
app.patch('/api/board/:id', async (c) => {
  const x = await c.req.json<{ title?: string; detail?: string; status?: BoardStatus; kind?: BoardKind }>();
  board.update(c.req.param('id'), {
    title: x.title?.trim().slice(0, 140) || undefined, detail: x.detail === undefined ? undefined : x.detail.slice(0, 4000),
    status: x.status && BOARD_STATUS.includes(x.status) ? x.status : undefined, kind: x.kind && BOARD_KINDS.includes(x.kind) ? x.kind : undefined,
  });
  return c.json(board.get(c.req.param('id')));
});
app.delete('/api/board/:id', (c) => { board.remove(c.req.param('id')); return c.json({ ok: true }); });

// Features panel: search the instance's plugins and Store apps; turning one on is a click by the user.
app.get('/api/features', async (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ error: 'Connect a PDI in Settings first.' }, 400);
  try { return c.json(await findFeatures(inst, c.req.query('q') ?? '', 25)); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
app.post('/api/features/activate', async (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ error: 'Connect a PDI in Settings first.' }, 400);
  const b = await c.req.json<{ kind?: 'plugin' | 'store_app'; id?: string; version?: string; name?: string; demo_data?: boolean }>();
  if (!b.id || !b.kind) return c.json({ error: 'kind and id are required' }, 400);
  try {
    const started = b.kind === 'plugin' ? await activatePlugin(inst, b.id) : await batchInstall(inst, b.id, b.version ?? '', b.demo_data === true);
    const progressId = started.links?.progress?.id;
    audit.add(null, inst.id, b.kind === 'plugin' ? 'features: activate plugin' : 'features: install store app', b, 'approved (clicked in Features panel)');
    if (!progressId) return c.json({ error: `The instance didn't start it: ${started.status_message ?? started.status_label ?? 'no progress id'}` }, 502);
    return c.json(jobs.add({ instance_id: inst.id, chat_id: null, kind: b.kind, target: b.kind === 'plugin' ? b.id : `${b.name ?? b.id}@${b.version ?? ''}`, progress_id: progressId }));
  } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});

// Instances. Three ways to sign in: client credentials (an integration user, the default), username + password
// (opt-in, stores a password), or "sign in as me" (OAuth authorization code with PKCE: Wayfinder acts as you, with
// your roles, and only a refresh token is stored).
const publicInstance = (i: ReturnType<typeof instances.get>) => {
  if (!i) return i;
  const { profile, ...rest } = i;
  const access = parseAccess(i);
  return { ...rest, has_secret: !!secrets.clientSecret(i.id) || !!secrets.password(i.id) || !!secrets.refreshToken(i.id), access, can: can(access), chat_count: chats.idsOn(i.id).length };
};
// An instance that's still in Settings (removed ones keep their row only to label old chats).
const live = (id: string) => { const i = instances.get(id); return i && i.status !== 'removed' ? i : undefined; };
app.get('/api/instances', (c) => c.json(instances.list().filter((i) => i.status !== 'removed').map(publicInstance)));
app.route('/api/instances', scriptRunnerSettings);
app.post('/api/instances', async (c) => {
  const b = await c.req.json<{ name?: string; url?: string; auth?: string; client_id?: string; client_secret?: string; username?: string; password?: string; login_user?: string; allow_non_pdi?: boolean }>();
  const auth = b.auth === 'basic' || b.auth === 'oauth_user' ? b.auth : 'client_credentials';
  if (!b.url) return c.json({ error: 'url is required' }, 400);
  if (auth === 'client_credentials' && (!b.client_id || !b.client_secret)) return c.json({ error: 'client ID and client secret are required' }, 400);
  if (auth === 'basic' && (!b.username || !b.password)) return c.json({ error: 'username and password are required' }, 400);
  if (auth === 'oauth_user' && !b.client_id) return c.json({ error: 'client ID is required' }, 400);
  const parsed = parseInstanceUrl(b.url);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const { url } = parsed;
  // Anything that isn't a personal developer instance is an explicit opt-in, and stays labelled.
  const isPdi = isPdiUrl(url);
  if (!isPdi && b.allow_non_pdi !== true) return c.json({ error: 'This is not a personal developer instance. Tick "This is a production or vendor instance" to connect it anyway.', needs_opt_in: true }, 400);
  const signIn = {
    client_id: (b.client_id ?? '').trim(), login_user: b.login_user?.trim() || (auth === 'basic' ? b.username!.trim() : 'admin'),
    kind: (isPdi ? 'pdi' : 'other') as 'pdi' | 'other', auth: auth as AuthMethod, auth_user: auth === 'basic' ? b.username!.trim() : null,
  };
  // An address that's already here gets the new sign-in on the same instance (its chats and history stay with it), but
  // only once the new sign-in works: until then the old one stays. "Sign in as me" swaps when the sign-in comes back.
  const existing = instances.byUrl(url)[0];
  if (existing && auth === 'oauth_user') {
    pendingReconnects.set(existing.id, { fields: { ...signIn, name: b.name?.trim() || undefined }, client_secret: b.client_secret?.trim() || null, at: Date.now() });
    return c.json({ instance: publicInstance(existing), needs_login: true, reconnected: true });
  }
  if (existing) {
    try { await testSignIn(url, { auth: auth as 'client_credentials' | 'basic', client_id: signIn.client_id, client_secret: b.client_secret?.trim(), username: b.username?.trim(), password: b.password }); }
    catch (e) {
      const err = e as InstanceError;
      return c.json({ error: `${err.message} Your current sign-in for this instance is unchanged.`, kind: err.kind }, err.kind === 'hibernating' ? 409 : 400);
    }
  }
  const inst = existing
    ? reconnect(existing, { ...signIn, name: b.name?.trim() || undefined })
    : instances.create({ name: b.name?.trim() || new URL(url).hostname.split('.')[0], url, ...signIn });
  if (!isPdi && !existing) audit.add(null, inst.id, 'instance', { url }, 'connected a non-PDI instance (opted in)');
  if (b.client_secret) secrets.setClientSecret(inst.id, b.client_secret.trim());
  if (auth === 'basic') { secrets.setPassword(inst.id, b.password!); audit.add(null, inst.id, 'instance', { url, auth }, 'connected with a username and password'); }
  if (auth === 'oauth_user') return c.json({ instance: publicInstance(inst), needs_login: true, reconnected: !!existing });
  const status = await pdiStatus(inst);
  if (status.state === 'awake') await checkAccess(inst).catch(() => null);
  checkNow().catch(() => {});
  return c.json({ instance: publicInstance(instances.get(inst.id)), status, reconnected: !!existing });
});

// "Set up my PDI for me": the PDI's admin login, once. Without confirm it only reads and returns the plan with a plan
// id; confirm needs that id, issued for the same address and admin user (10 minutes, used once), so it can never run
// against an instance the user wasn't shown. Each change is audited as it happens; the admin password isn't kept.
const setupPlans = new Map<string, { url: string; admin: string; at: number }>();
app.post('/api/instances/pdi-setup', async (c) => {
  const b = await c.req.json<{ url?: string; username?: string; password?: string; login_user?: string; name?: string; confirm?: boolean; plan_id?: string; keep_extra_roles?: boolean }>().catch(() => null);
  if (!b?.url || !b.username?.trim() || !b.password) return c.json({ error: 'The address, admin username and password are required.' }, 400);
  const parsed = parseInstanceUrl(b.url);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const { url } = parsed;
  const username = b.username.trim();
  for (const [k, v] of setupPlans) if (Date.now() - v.at > 600_000) setupPlans.delete(k);
  try {
    if (b.confirm !== true) {
      const plan = await planPdiSetup(url, username, b.password);
      const plan_id = randomBytes(18).toString('base64url');
      setupPlans.set(plan_id, { url, admin: username, at: Date.now() });
      return c.json({ plan, plan_id });
    }
    const issued = b.plan_id ? setupPlans.get(b.plan_id) : undefined;
    if (!issued || issued.url !== url || issued.admin !== username)
      return c.json({ error: 'Check what it will do first: the plan was for a different address or admin, or it expired.', kind: 'stale' }, 409);
    setupPlans.delete(b.plan_id!);
    const existing = instances.byUrl(url)[0];
    const done = await applyPdiSetup(url, username, b.password, {
      keepExtraRoles: b.keep_extra_roles !== false,
      onStep: (st) => audit.add(null, existing?.id ?? null, 'pdi_setup', { url, admin: username, step: st.key }, `PDI setup: ${st.label}`),
    });
    // The new sign-in works (setup signed in with it), so an instance already here at this address takes it over.
    const signIn = { client_id: done.client_id, login_user: b.login_user?.trim() || username, kind: 'pdi' as const, auth: 'client_credentials' as const, auth_user: null };
    const inst = existing
      ? reconnect(existing, { ...signIn, name: b.name?.trim() || undefined })
      : instances.create({ name: b.name?.trim() || new URL(url).hostname.split('.')[0], url, ...signIn });
    secrets.setClientSecret(inst.id, done.client_secret);
    audit.add(null, inst.id, 'instance', { url, admin: username, user: INTEGRATION_USER, client_id: `${done.client_id.slice(0, 6)}…` },
      'set up the PDI for Wayfinder with the admin login (used once, not stored)');
    const status = await pdiStatus(inst);
    if (status.state === 'awake') await checkAccess(inst).catch(() => null);
    checkNow().catch(() => {});
    return c.json({ instance: publicInstance(instances.get(inst.id)), status, reconnected: !!existing, plan: { steps: done.steps, admin: done.admin } });
  } catch (e) {
    const err = e as SetupError;
    const setup = err instanceof SetupError;
    if (setup && err.done?.length) audit.add(null, null, 'pdi_setup', { url, admin: username, done: err.done, left: err.left }, 'PDI setup stopped partway');
    return c.json({ error: err.message, kind: setup ? err.kind : 'error', done: setup ? err.done : undefined, left: setup ? err.left : undefined }, setup && err.kind === 'hibernating' ? 409 : 502);
  }
});

// "Sign in as me": start the OAuth authorization-code flow with PKCE, then finish it on the callback.
// A new "Sign in as me" for an address that's already here waits here until the sign-in comes back (10 minutes).
type Pending = { fields: Parameters<typeof reconnect>[1]; client_secret: string | null; at: number };
const pendingReconnects = new Map<string, Pending>();
const pendingLogins = new Map<string, { instanceId: string; verifier: string; redirect: string; at: number; reconnect?: Pending }>();
app.post('/api/instances/:id/oauth/start', async (c) => {
  const inst = live(c.req.param('id'));
  if (!inst) return c.json({ error: 'not found' }, 404);
  const waiting = pendingReconnects.get(inst.id);
  const pending = waiting && Date.now() - waiting.at < 600_000 ? waiting : undefined;
  if (inst.auth !== 'oauth_user' && !pending) return c.json({ error: 'not an OAuth sign-in instance' }, 400);
  const { origin } = await c.req.json<{ origin?: string }>();
  if (!origin || origin !== c.req.header('origin')) return c.json({ error: 'origin mismatch' }, 400);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const redirect = `${origin}/api/oauth/callback`;
  for (const [k, v] of pendingLogins) if (Date.now() - v.at > 600_000) pendingLogins.delete(k);
  pendingLogins.set(state, { instanceId: inst.id, verifier, redirect, at: Date.now(), reconnect: pending });
  const q = new URLSearchParams({ response_type: 'code', client_id: pending?.fields.client_id ?? inst.client_id, redirect_uri: redirect, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  return c.json({ url: `${inst.url}/oauth_auth.do?${q}`, redirect });
});
app.get('/api/oauth/callback', async (c) => {
  const page = (msg: string, ok: boolean) => c.html(`<!doctype html><meta charset="utf-8"><title>Wayfinder sign-in</title><body style="font:15px system-ui;background:#08090b;color:#f4f4f5;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:460px;text-align:center"><p>${msg.replace(/[<>&]/g, '')}</p><p><a style="color:#6e8fff" href="/">Back to Wayfinder</a></p></div>${ok ? '<script>setTimeout(()=>location.replace("/"),1200)</script>' : ''}</body>`, ok ? 200 : 400);
  const state = c.req.query('state') ?? '';
  const login = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!login || Date.now() - login.at > 600_000) return page('That sign-in link expired. Start again from Settings.', false);
  if (c.req.query('error')) return page(`The instance said: ${c.req.query('error_description') ?? c.req.query('error')}`, false);
  let inst = live(login.instanceId);
  if (!inst) return page('That instance is gone.', false);
  const re = login.reconnect;
  try {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: c.req.query('code') ?? '', redirect_uri: login.redirect, client_id: re?.fields.client_id ?? inst.client_id, code_verifier: login.verifier });
    const secret = re ? re.client_secret : secrets.clientSecret(inst.id);
    if (secret) body.set('client_secret', secret);
    const json = await tokenRequest(inst, body);
    if (!json.refresh_token) return page('Signed in, but the instance gave no refresh token; check the OAuth app allows refresh tokens.', false);
    if (instances.get(inst.id)?.url !== inst.url) return page('The instance address changed during sign-in. Start again from Settings.', false);
    // A reconnect only now replaces the old sign-in.
    if (re) {
      pendingReconnects.delete(inst.id);
      inst = reconnect(inst, re.fields);
      if (re.client_secret) secrets.setClientSecret(inst.id, re.client_secret);
    }
    secrets.setRefreshToken(inst.id, json.refresh_token);
    clearInsights(inst.id);
    const profile = await checkAccess(inst).catch(() => null);
    audit.add(null, inst.id, 'instance', { url: inst.url, auth: 'oauth_user', user: profile?.user }, 'signed in as the user (OAuth)');
    checkNow().catch(() => {});
    return page(`Signed in${profile ? ` as ${profile.user}` : ''}. Taking you back…`, true);
  } catch (e) { return page(`Sign-in failed: ${(e as Error).message}`, false); }
});
app.post('/api/instances/:id/access', async (c) => {
  const inst = live(c.req.param('id'));
  if (!inst) return c.json({ error: 'not found' }, 404);
  try { return c.json(await checkAccess(inst)); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
app.put('/api/instances/:id', async (c) => {
  const id = c.req.param('id');
  const inst = live(id);
  if (!inst) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<{ name?: string; url?: string; client_id?: string; client_secret?: string; login_user?: string; allow_non_pdi?: boolean; full_permissions?: boolean }>();
  if (b.full_permissions !== undefined && typeof b.full_permissions !== 'boolean') return c.json({ error: 'Full permissions must be on or off.' }, 400);
  if (b.full_permissions === true && inst.kind !== 'pdi')
    return c.json({ error: 'Full permissions is only available for personal developer instances.' }, 400);
  if (b.url) {
    const parsed = parseInstanceUrl(b.url);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    if (b.full_permissions === true && !isPdiUrl(parsed.url)) return c.json({ error: 'Full permissions is only available for personal developer instances.' }, 400);
    const other = instances.byUrl(parsed.url).find((i) => i.id !== id);
    if (other) return c.json({ error: `"${other.name}" already uses ${parsed.url}. Make that one active instead, or remove it first.` }, 400);
    const refused = changeInstanceUrl(inst, parsed.url, b.allow_non_pdi === true);
    if (refused) return c.json(refused, 400);
  }
  instances.update(id, { name: b.name?.trim() || undefined, client_id: b.client_id, login_user: b.login_user });
  if (b.full_permissions !== undefined) {
    instances.update(id, { full_permissions: b.full_permissions ? 1 : 0 });
    audit.add(null, id, 'full permissions', {}, b.full_permissions ? 'turned on' : 'turned off');
  }
  if (b.client_secret) secrets.setClientSecret(id, b.client_secret.trim());
  if (b.client_secret || b.url || b.client_id) clearInsights(id);
  return c.json(publicInstance(instances.get(id)));
});
app.post('/api/instances/:id/activate', (c) => {
  const inst = instances.get(c.req.param('id'));
  if (!inst || inst.status === 'removed') return c.json({ error: 'not found' }, 404);
  instances.activate(inst.id); clearInsights(inst.id); checkNow().catch(() => {}); return c.json({ ok: true });
});
// Remove a retired instance: its sign-in is deleted; its chats stay readable unless delete_chats is set.
app.post('/api/instances/:id/remove', async (c) => {
  const b = await c.req.json<{ delete_chats?: boolean }>().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Send { "delete_chats": true or false }.' }, 400);
  const r = removeInstance(c.req.param('id'), b.delete_chats === true);
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400);
});
app.post('/api/instances/:id/test', async (c) => {
  const inst = live(c.req.param('id'));
  if (!inst) return c.json({ error: 'not found' }, 404);
  const st = await pdiStatus(inst);
  if (st.state === 'awake') await checkAccess(inst).catch(() => null);
  return c.json(st);
});
app.post('/api/instances/:id/backup', async (c) => {
  const inst = live(c.req.param('id'));
  if (!inst) return c.json({ error: 'not found' }, 404);
  try { return c.json(await backupUpdateSets(inst)); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});

// Status banner, settings, audit
app.get('/api/status', (c) => {
  const st = currentStatus();
  const inst = st ? instances.get(st.instanceId) : undefined;
  const access = parseAccess(inst);
  let deploy: unknown = null;
  try { deploy = JSON.parse(readFileSync(join(DATA_DIR, 'deploy-status.json'), 'utf8')); } catch { /* no auto-deploy here */ }
  return c.json(st ? { ...st, kind: inst?.kind ?? 'pdi', name: inst?.name, auth: inst?.auth, user: access?.user, can: can(access), deploy } : st);
});
app.post('/api/status/check', async (c) => c.json(await checkNow()));
// How many answers are running, so an update can wait for them before it restarts the app (ops/auto-deploy.sh).
app.get('/api/busy', (c) => c.json({ answering: answering() }));
app.get('/api/settings', (c) => c.json(settings.get()));
app.get('/api/tool-servers', (c) => c.json(toolServers.publicList()));
app.post('/api/tool-servers', async (c) => {
  try { toolServers.save(await c.req.json()); return c.json(toolServers.publicList()); }
  catch { return c.json({ error: 'Invalid tool server or duplicate key. Use a short lowercase key with single underscores; built-in names are reserved.' }, 400); }
});
app.put('/api/tool-servers/:key', async (c) => {
  try {
    const body = await c.req.json();
    if (body.key !== c.req.param('key')) return c.json({ error: 'The server key cannot change.' }, 400);
    toolServers.save(body, true); return c.json(toolServers.publicList());
  } catch { return c.json({ error: 'Invalid tool server. Check the fields.' }, 400); }
});
app.patch('/api/tool-servers/:key', async (c) => {
  const body = await c.req.json();
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'Choose enabled or disabled.' }, 400);
  try { toolServers.enable(c.req.param('key'), body.enabled); return c.json(toolServers.publicList()); }
  catch { return c.json({ error: 'No such tool server.' }, 404); }
});
app.delete('/api/tool-servers/:key', (c) => {
  toolServers.remove(c.req.param('key')); return c.json(toolServers.publicList());
});
app.post('/api/tool-servers/:key/test', async (c) => {
  const server = toolServers.get(c.req.param('key'));
  if (!server) return c.json({ error: 'No such tool server.' }, 404);
  try { return c.json({ tools: await discoverTools(serverConfig(server)) }); }
  catch { return c.json({ error: 'Server unavailable. Check its command or URL and saved credentials.' }, 502); }
});
// Routines: questions Pip answers on a schedule, each run a chat of its own (routines.ts).
app.get('/api/routines', (c) => c.json(routines.list()));
app.get('/api/routines/templates', (c) => c.json(routineTemplates()));
app.post('/api/routines', async (c) => {
  try { saveRoutine(await c.req.json()); return c.json(routines.list()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.put('/api/routines/:id', async (c) => {
  try { saveRoutine(await c.req.json(), c.req.param('id')); return c.json(routines.list()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.delete('/api/routines/:id', (c) => { routines.remove(c.req.param('id')); return c.json(routines.list()); });
// Run now: the answer carries on in the background; the chat it opened is returned so the page can show it.
app.post('/api/routines/:id/run', async (c) => {
  const r = routines.get(c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  if (r.last_chat_id && chats.get(r.last_chat_id)?.answering_since) return c.json({ error: 'Its last run is still answering.' }, 409);
  return c.json({ chat_id: runRoutine(r).chatId });
});
// Today's estimated spend, for the spending limit card.
app.get('/api/usage', (c) => c.json({ today: spentToday(), limit: settings.get().dailyBudgetUsd, choices: BUDGET_CHOICES }));
app.put('/api/settings', async (c) => {
  const b = await c.req.json<Partial<Settings>>();
  const patch: Partial<Settings> = {};
  if (Array.isArray(b.allowlist)) patch.allowlist = [...new Set(b.allowlist.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
  if (typeof b.writeEnabled === 'boolean') patch.writeEnabled = b.writeEnabled;
  if (typeof b.scriptingEnabled === 'boolean') patch.scriptingEnabled = b.scriptingEnabled;
  if (typeof b.model === 'string' && /^[a-z0-9.\-]+$/i.test(b.model)) patch.model = b.model;
  if (b.presence === 'alive' || b.presence === 'still' || b.presence === 'off') patch.presence = b.presence;
  if (typeof b.docsRelease === 'string' && /^(auto|[a-z]{3,20})$/.test(b.docsRelease)) patch.docsRelease = b.docsRelease;
  if (b.smallModel === 'haiku' || b.smallModel === 'sonnet') patch.smallModel = b.smallModel;
  if (typeof b.dailyBudgetUsd === 'number' && BUDGET_CHOICES.includes(b.dailyBudgetUsd)) patch.dailyBudgetUsd = b.dailyBudgetUsd;
  if (typeof b.reminderDays === 'number' && b.reminderDays >= 0 && b.reminderDays <= 10) patch.reminderDays = Math.floor(b.reminderDays);
  if (validZone(b.timeZone)) patch.timeZone = b.timeZone;
  settings.set(patch);
  return c.json(settings.get());
});
app.get('/api/audit', (c) => c.json(audit.recent()));
app.get('/api/jobs', (c) => c.json(jobs.recent()));

// Live updates: one stream per open browser tab. Each event names what changed; the page refetches just that.
app.get('/api/events', (c) => streamSSE(c, async (stream) => {
  let alive = true;
  const send = (e: Record<string, unknown>) => { stream.writeSSE({ data: JSON.stringify(e) }).catch(() => { alive = false; }); };
  bus.on('change', send);
  stream.onAbort(() => { alive = false; });
  try {
    while (alive) { await stream.writeSSE({ event: 'ping', data: '' }).catch(() => { alive = false; }); await stream.sleep(25_000); }
  } finally { bus.off('change', send); }
}));

// First-run setup.
app.get('/api/setup', (c) => c.json(setupState()));
app.post('/api/setup/claude', async (c) => {
  const b = await c.req.json<{ api_key?: string; clear?: boolean }>();
  if (b.clear) secrets.setAnthropicKey(null);
  else if (b.api_key?.trim()) {
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(b.api_key.trim())) return c.json({ error: "That doesn't look like an Anthropic API key (it starts with sk-ant-)." }, 400);
    secrets.setAnthropicKey(b.api_key.trim());
    audit.add(null, null, 'claude', {}, 'saved an Anthropic API key');
  }
  return c.json(await testClaude());
});
app.post('/api/setup/done', (c) => { settings.set({ setupDone: true }); return c.json(setupState()); });

// Suggestions from what's on the instance (custom tables, products, update sets, errors, urgent incidents).
app.get('/api/suggestions', async (c) => {
  const chat = c.req.query('chat_id') ? chats.get(c.req.query('chat_id')!) : undefined;
  const inst = chat?.instance_id ? instances.get(chat.instance_id) : instances.active();
  return c.json(await suggestionsFor(inst, c.req.query('mode') ?? chat?.mode ?? 'explore', chat?.project_id ?? null));
});
// Insights: what developers changed (window, person, update set) and which log errors are new. Read-only, cached.
// What one Insights change touches, on demand (the search runs only when a row asks for it).
app.get('/api/pulse/impact', async (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ error: 'No instance connected.' }, 400);
  let target: ImpactTarget;
  try { target = JSON.parse(c.req.query('target') ?? ''); } catch { return c.json({ error: 'target must be JSON' }, 400); }
  try { return c.json(await impactLine(inst, target)); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.get('/api/pulse', async (c) => c.json(await instancePulse(instances.active(), cleanFilter({ days: c.req.query('days'), by: c.req.query('by'), set: c.req.query('set') }))));

// Docs release: what the docs server has, the setting, and what answers use right now.
app.get('/api/docs/releases', async (c) => {
  const available = await docReleases();
  const inst = instances.active();
  const facts = inst ? await instanceFacts(inst).catch(() => null) : null;
  return c.json({ available, setting: settings.get().docsRelease, effective: docsRelease(facts, available), instanceRelease: facts?.release ?? null });
});

// The local docs index: what's on this machine, the setup in progress, the Download / Update buttons and the daily
// check's last result. Setup only downloads ServiceNow's public docs repository; Pip can't start it (no tool does).
app.get('/api/docs/local', (c) => {
  let free: number | null = null;
  try { free = freeBytes(); } catch { /* unknown */ }
  return c.json({ source: docsSource(), releases: localInfo(), job: docsJob(), auto: docsAuto(), free, need: NEED_BYTES });
});
app.post('/api/docs/local', async (c) => {
  // A body that isn't JSON is refused (writes are JSON-only), so nothing but the app's own button starts a download.
  const b = await c.req.json<{ release?: string; update?: boolean }>().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'Send a JSON body.' }, 400);
  const inst = instances.active();
  const facts = inst ? await instanceFacts(inst).catch(() => null) : null;
  try {
    const job = startDocsSetup({ release: b.release || null, instance: facts?.release ?? null, update: !!b.update }, (j) => announce('docs', { job: j }));
    audit.add(null, null, 'docs_setup', { release: b.release ?? 'auto', update: !!b.update }, b.update ? 'Updated the local ServiceNow docs' : 'Downloaded the ServiceNow docs');
    return c.json({ job });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

// The update set this account's changes go into, read-only: Pip picks and switches sets (use_update_set), so the app
// only shows it, with when and why Pip last switched.
app.get('/api/updatesets/current', async (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ current: null, last_switch: null });
  try {
    const facts = await instanceFacts(inst);
    const id = facts.updateSet?.sys_id;
    let current = null;
    if (id && /^[0-9a-f]{32}$/.test(id)) {
      const [[set], count] = await Promise.all([
        table(inst, 'sys_update_set', `sys_id=${id}`, 'sys_id,name,state,application.name,application.scope', 1),
        sn(inst, `/api/now/stats/sys_update_xml?sysparm_count=true&sysparm_query=${encodeURIComponent(`update_set=${id}`)}`).then((r) => Number(r.result?.stats?.count ?? 0)).catch(() => null),
      ]);
      if (set) current = { sys_id: set.sys_id, name: set.name, state: set.state || 'in progress', app: set['application.name'] || 'Global', scope: set['application.scope'] || 'global', changes: count, link: `${inst.url}/sys_update_set.do?sys_id=${set.sys_id}` };
    }
    const last = audit.latest(inst.id, 'update set');
    let why: string | null = null;
    try { why = last ? (JSON.parse(last.input).why ?? null) : null; } catch { /* older entry */ }
    return c.json({ current, last_switch: last ? { at: last.at, why, chat_id: last.chat_id, by: last.decision === 'switched by Pip' ? 'pip' : 'you' } : null });
  } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});

// The Fluent cheat sheet: which SDK it was verified on, its health on the installed SDK, and lessons from real builds.
// What Pip learned from failed tool calls that later worked (in its prompt), and failures still unexplained.
// Your conventions (opt-in): a read-only scan proposes naming rules from the instance; only the rules the user
// approves go into Pip's prompt. Turning it off clears them.
app.get('/api/conventions', (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ instance: false, status: 'off', proposed: [], rules: [], scanned_at: null });
  const cv = conventions.get(inst.id);
  return c.json({ instance: true, status: cv?.status ?? 'off', proposed: cv?.proposed ?? [], rules: cv?.rules ?? [], scanned_at: cv?.scanned_at ?? null });
});
app.post('/api/conventions/scan', async (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ error: 'Connect an instance in Settings first.' }, 400);
  try {
    const r = await scanConventions(inst);
    audit.add(null, inst.id, 'conventions', { read: r.read, proposed: r.proposed.length, skipped: r.skipped }, 'scanned');
    return c.json(r);
  } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
// Pip's skills: what each is for, where it comes from, and any file of yours that couldn't be used. Read-only.
app.get('/api/skills', (c) => {
  const set = loadSkills();
  const { skills } = set;
  // A placement skill that parses but has a broken rule is flagged here too.
  const warnings = [...set.warnings, ...placementRules(set).warnings];
  return c.json({ folder: SKILLS_DIR, warnings, skills: skills.map(({ name, description, mode, modes, origin }) => ({ name, description, mode: mode ?? null, modes: modes ?? null, origin })) });
});
// One skill's file, and your own copy of it: saved from the page (checked first), or removed to go back to the shipped one.
app.get('/api/skills/:name', (c) => { const f = readSkillFile(c.req.param('name')); return f ? c.json(f) : c.json({ error: 'not found' }, 404); });
app.put('/api/skills/:name', async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  if (typeof text !== 'string') return c.json({ error: 'text is required' }, 400);
  try { saveUserSkill(c.req.param('name'), text); audit.add(null, null, 'skill', { name: c.req.param('name'), bytes: Buffer.byteLength(text) }, 'saved'); return c.json(readSkillFile(c.req.param('name'))); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.delete('/api/skills/:name', (c) => {
  try { removeUserSkill(c.req.param('name')); audit.add(null, null, 'skill', { name: c.req.param('name') }, 'your copy removed'); return c.json(readSkillFile(c.req.param('name')) ?? { gone: true }); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.post('/api/conventions/save', async (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ error: 'Connect an instance in Settings first.' }, 400);
  const { ids } = await c.req.json<{ ids?: string[] }>();
  const cv = conventions.get(inst.id);
  if (!cv || !Array.isArray(ids)) return c.json({ error: 'Nothing to save: learn from the instance first.' }, 400);
  const pool = [...cv.proposed, ...cv.rules];
  const rules = ids.map((id) => pool.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r).slice(0, 12);
  if (!rules.length) { conventions.clear(inst.id); audit.add(null, inst.id, 'conventions', {}, 'off'); return c.json({ ok: true, rules: [] }); }
  conventions.approve(inst.id, rules);
  audit.add(null, inst.id, 'conventions', { rules: rules.map((r) => r.rule) }, 'approved');
  return c.json({ ok: true, rules });
});
app.post('/api/conventions/off', (c) => {
  const inst = instances.active();
  if (!inst) return c.json({ error: 'No instance connected.' }, 400);
  conventions.clear(inst.id);
  audit.add(null, inst.id, 'conventions', {}, 'off');
  return c.json({ ok: true });
});
app.get('/api/lessons', (c) => {
  const all = toolLessons.list();
  return c.json({ learned: all.filter((l) => l.status === 'learned'), misses: all.filter((l) => l.status === 'miss').slice(0, 20), fixed: all.filter((l) => l.status === 'fixed').length });
});
app.post('/api/lessons/:id/remove', (c) => {
  const l = toolLessons.get(c.req.param('id'));
  if (!l) return c.json({ error: 'not found' }, 404);
  toolLessons.update(l.id, { status: 'removed' });
  audit.add(null, null, 'tool lesson', { rule: l.rule }, 'removed');
  return c.json({ ok: true });
});
app.get('/api/fluent', (c) => {
  const all = fluentLessons.list();
  const count = (st: string) => all.filter((l) => l.status === st).length;
  return c.json({ health: sheetHealth, misses: count('miss'), fixed: count('fixed'), proposed: all.filter((l) => l.status === 'proposed'), approved: all.filter((l) => l.status === 'approved') });
});
app.post('/api/fluent/lessons/:id', async (c) => {
  const { status } = await c.req.json<{ status?: string }>();
  if (status !== 'approved' && status !== 'dismissed') return c.json({ error: 'approved or dismissed' }, 400);
  const l = fluentLessons.get(c.req.param('id'));
  if (!l) return c.json({ error: 'not found' }, 404);
  fluentLessons.update(l.id, { status });
  audit.add(null, null, 'fluent lesson', { rule: l.rule }, status);
  return c.json({ ok: true });
});
app.post('/api/fluent/review', async (c) => c.json({ proposed: await reviewLessons(buildScratch) }));
app.post('/api/fluent/verify', async (c) => c.json(await checkSheet(buildScratch, true)));

// Speed: time to the first word and the slowest tools over recent answers.
app.get('/api/perf', (c) => {
  const all = perf.recent(200);
  // Small jobs (titles, summaries, lessons) show as their own rows in the matrix, but aren't answers.
  const rows = all.filter((r) => !r.mode.startsWith('job:'));
  const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const first = rows.map((r) => r.first_word_ms).filter((x): x is number => x !== null);
  const start = rows.map((r) => r.start_ms).filter((x): x is number => x !== null);
  const byTool = new Map<string, number[]>();
  for (const r of rows) for (const t of r.tools) byTool.set(t.name, [...(byTool.get(t.name) ?? []), t.ms]);
  const tools = [...byTool.entries()].map(([name, ms]) => ({ name, calls: ms.length, p50: pct(ms, 0.5), p90: pct(ms, 0.9) }))
    .sort((a, b) => (b.p90 ?? 0) - (a.p90 ?? 0)).slice(0, 12);
  // The efficiency matrix: per mode, how fast, how many model turns, how many failed tool calls, what it cost.
  const modes = [...new Set(all.map((r) => r.mode))].map((m) => {
    const rs = all.filter((r) => r.mode === m);
    const avg = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === 'number'); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
    const calls = rs.reduce((n, r) => n + r.tools.length, 0);
    return { mode: m, answers: rs.length, first_p50: pct(rs.map((r) => r.first_word_ms).filter((x): x is number => x !== null), 0.5),
      turns: avg(rs.map((r) => r.turns)), tool_calls: avg(rs.map((r) => r.tools.length)),
      error_rate: calls ? Math.round((rs.reduce((n, r) => n + (r.tool_errors ?? 0), 0) / calls) * 1000) / 10 : null, cost: avg(rs.map((r) => r.cost_usd)) };
  });
  return c.json({ answers: rows.length, first_word: { p50: pct(first, 0.5), p90: pct(first, 0.9) }, start: { p50: pct(start, 0.5), p90: pct(start, 0.9) }, tools, modes });
});
// Only app installs can be cancelled (they run here); ServiceNow finishes plugin, Store and test runs itself.
app.post('/api/jobs/:id/cancel', (c) => {
  const job = jobs.get(c.req.param('id'));
  if (!job || job.status !== 'running') return c.json({ error: 'That job is not running.' }, 404);
  if (job.kind !== 'app_install') return c.json({ error: 'ServiceNow runs this one; it can only be stopped on the instance.' }, 409);
  return cancelInstall(job.id) ? c.json({ ok: true }) : c.json({ error: 'It already finished.' }, 409);
});

// The built web app
const WEB = join(process.cwd(), 'dist', 'web');
app.use('/assets/*', serveStatic({ root: './dist/web' }));
app.get('*', (c: Context) => {
  const index = join(WEB, 'index.html');
  if (!existsSync(index)) return c.text('Web app not built. Run npm run build.', 503);
  c.header('Content-Security-Policy', CSP);
  c.header('X-Frame-Options', 'DENY');
  return c.html(readFileSync(index, 'utf8'));
});

failOrphanedInstalls();
mergeDuplicates();
noteCutOff();
clearUpdating();   // this server is the new one, so any update's restart window is over
// A sealed secrets file whose key can't be reached (keychain.ts) stops the start here, with the reason, not at the first request.
try { secrets.appToken(); } catch (e) { console.error((e as Error).message); process.exit(1); }
startMonitor();
startJobPoller();
startRoutines();
// The docs follow their upstream daily, keeping the newest release and the selected one: the setting, else the
// connected instance's (facts.ts).
startDocsAutoUpdate(async () => { const want = settings.get().docsRelease; return want !== 'auto' ? want : (await activeFacts())?.release ?? null; }, (d) => announce('docs', d));
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => console.log(`Wayfinder on http://${HOST}:${PORT}`));
// systemd (a restart, an update) and Ctrl-C: end running answers so each keeps what it did and says it was cut off.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { void stopAllForRestart().finally(() => process.exit(0)); });
// After an SDK upgrade, compile the cheat sheet once in the background (skipped when the versions match).
setTimeout(() => { void checkSheet(buildScratch).catch(() => {}); }, 15_000);
