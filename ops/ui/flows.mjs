// UI flows in headless Chrome with real mouse clicks and keys, against a throwaway copy of Wayfinder.
//   npm run test:ui [-- <flow> ...]       flows: whatsnew setup waking guided memory dial cards composer mobile popovers features palette settings conventions jobs … budget (default: all)
// Starts its own server (empty data, sandbox off) and a fake instance on 127.0.0.1, so nothing real is touched.
// Sending a message never reaches Claude: the browser answers /api/chats/:id/send itself and the flow checks what
// would have been sent. Chrome: $CHROME, else chrome-headless-shell under ~/.cache/wayfinder-chs
// (npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/wayfinder-chs), else Google Chrome.
// Screenshots of failures go to $UI_OUT (default: a temp folder, printed at the end).
// README captures only: npm run build && UI_README=docs/images npm run test:ui -- readme
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';

// Always in this order: setup needs a fresh install, and features connects an instance (which also counts as set up).
const ALL = ['whatsnew', 'setup', 'waking', 'guided', 'memory', 'dial', 'cards', 'composer', 'mobile', 'popovers', 'features', 'palette', 'settings', 'toolservers', 'routines', 'instances', 'conventions', 'jobs', 'clarity', 'pdisetup', 'setpill', 'insights', 'placement', 'memoryhub', 'budget', 'freshchat', 'cutoff', 'updating', 'rejoin', 'setnote', 'timeline', 'boardcomes', 'docs', 'preview', 'screenkit', 'openpage', 'plangate', 'scriptrunner', 'fullpermissions', 'readme'];
const asked = process.argv.slice(2);
const wanted = asked.length ? ALL.filter((f) => asked.includes(f)) : ALL;
for (const w of asked) if (!ALL.includes(w)) { console.error(`unknown flow: ${w} (flows: ${ALL.join(' ')})`); process.exit(2); }

if (!existsSync('dist/web/index.html')) { console.error('Build the web app first: npm run build'); process.exit(2); }

const scratch = mkdtempSync(join(tmpdir(), 'wayfinder-ui-'));
const outDir = process.env.UI_OUT ?? join(scratch, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const children = [];
const cleanup = () => { for (const c of children) try { c.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// A fake instance: just enough of the Table API for status, the access check and the Features search.
const PLUGINS = [{ id: 'com.example.catalog_builder', name: 'Catalog Builder', description: 'Build catalog items without code', active: 'inactive', requires: '', block_install: 'false', indicators: '', version: '1.0.0', has_demo_data: 'false', help: '' }];
const REMOTE = [{ sys_id: 'r1', name: 'Catalog Insights', scope: 'sn_cat_insights', short_description: 'Reports on catalog use', latest_version: '2.0.0', block_install: 'true', indicators: JSON.stringify([{ tooltip: 'Unavailable on developer instances' }]), dependencies: '', price_type: 'free', demo_data: 'no_demo_data' }];
const CUSTOM = {
  sys_update_set: ['STRY0010231 - Loaner reminders', 'STRY0010198 - Asset intake form', 'CHG0030012 - Patch catalog', 'STRY0010150 - Fix SLA timer'].map((name) => ({ name })),
  sys_scope: ['x_acme_loan', 'x_acme_intake', 'x_acme_slafix'].map((scope) => ({ scope })),
  sys_script_include: ['LoanerUtils', 'AssetIntakeUtils', 'CatalogUtils'].map((name) => ({ name })),
  sys_script: ['Loaner - Set due date', 'Loaner - Notify overdue', 'Asset - Default owner'].map((name) => ({ name })),
};
const CURRENT_SET = { sys_id: 'c'.repeat(32), name: 'STRY0010231 - Loaner reminders', state: 'in progress', 'application.name': 'Loaner', 'application.scope': 'x_acme_loan' };
// Development work on the fake instance, for Insights: a new script error, a field that changed type, a changed
// script include and ACL, and two update sets sharing a record.
const hex = (n) => n.toString(16).padStart(32, '0');
const utc = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const DAY = 86_400_000;
const versionOf = (type) => `<record_update><sys_dictionary><element>u_status</element><internal_type>${type}</internal_type></sys_dictionary></record_update>`;
const xmlRow = (n, name, target, by, set) => ({ sys_id: hex(1000 + n), name, type: '', target_name: target, action: 'INSERT_OR_UPDATE', update_set: set, sys_updated_by: by, sys_updated_on: utc(DAY) });
const DEV = {
  syslog: [1, 2, 3].map((n) => ({ sys_created_on: utc(n * 3_600_000), source: 'Evaluator', message: `RhinoEcmaError: "due" is not defined. sys_script.${hex(900)} : Line(4)` })),
  sys_metadata: [{ sys_id: hex(900), sys_name: 'Loan - set due date', sys_class_name: 'sys_script', sys_scope: hex(950) }],
  sys_scope: [{ sys_id: hex(950), scope: 'x_acme_loan', name: 'Loans' }],
  sys_dictionary: [{ sys_id: hex(701), name: 'x_acme_loan', element: 'u_status', internal_type: 'integer', reference: '', sys_created_on: utc(60 * DAY), sys_updated_by: 'alice' }],
  sys_update_version: [{ name: 'sys_dictionary_x_acme_loan_u_status', payload: versionOf('integer') }, { name: 'sys_dictionary_x_acme_loan_u_status', payload: versionOf('string') }],
  sys_update_xml: [
    xmlRow(1, `sys_script_${hex(900)}`, 'Loan - set due date', 'alice', hex(500)), xmlRow(2, `sys_script_include_${hex(901)}`, 'LoanUtils', 'alice', hex(500)),
    xmlRow(3, `sys_script_client_${hex(902)}`, 'Loan status onChange', 'bob', hex(501)), xmlRow(4, `sys_security_acl_${hex(30)}`, 'x_acme_loan.u_status', 'bob', hex(500)),
    xmlRow(5, `sys_script_${hex(900)}`, 'Loan - set due date', 'bob', hex(501)),
  ],
  sys_update_set: [{ sys_id: hex(500), name: 'Loans: due dates', sys_created_by: 'alice' }, { sys_id: hex(501), name: 'Loans: status UI', sys_created_by: 'bob' }],
  sys_script: [{ sys_id: hex(905), name: 'Loan - flag overdue', collection: 'x_acme_loan', script: "if (current.u_status == 3) {}", condition: '', filter_condition: '' }],
  sys_script_include: [{ sys_id: hex(906), name: 'Caller', script: 'new LoanUtils().due();' }],
  sys_security_acl: [{ sys_id: hex(30), name: 'x_acme_loan.u_status', operation: 'write', active: 'true', admin_overrides: 'false', condition: '', script: '' }],
};
const fakePort = await freePort();
let asleep = false; // a hibernating PDI answers every request with the developer site's HTML page
let readmeDemo = false;
// What "Set up my PDI for me" creates: the property, the integration user, its roles and the OAuth app.
const made = { sys_properties: [], sys_user: [], sys_user_has_role: [], oauth_entity: [] };
const runnerRecords = { sys_ws_definition: [], sys_ws_operation: [], sys_security_acl: [] };
const runnerWrites = [];
const runnerPrefs = [
  { sys_id: hex(21000), user: hex(1), name: 'apps.current_app', value: hex(950) },
  { sys_id: hex(21001), user: hex(1), name: 'sys_update_set', value: CURRENT_SET.sys_id },
];
const SETUP_TABLES = { sys_dictionary: [{ element: 'user' }], sys_user_role: [{ sys_id: 'r-admin', name: 'admin' }, { sys_id: 'r-cicd', name: 'sn_cicd.sys_ci_automation' }] };
const canaryHits = []; // anything a mockup preview manages to load from the network lands here
let controlPage = ''; // the preview fixture, served plainly (no preview policy) for the positive control
const fake = createServer((req, res) => {
  { const u = new URL(req.url, 'http://x');
    if (u.pathname === '/control') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(controlPage); }
    if (u.pathname.startsWith('/canary/')) { canaryHits.push(u.pathname); res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); return res.end(''); } }
  if (asleep) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>Your instance is hibernating. Wake it at developer.servicenow.com.</body></html>'); return; }
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  // One password the fake refuses, to check that a failed reconnect leaves the old sign-in alone.
  if ((req.headers.authorization ?? '') === `Basic ${Buffer.from('admin:wrong-password').toString('base64')}`) return json(401, { error: { message: 'User Not Authenticated' } });
  const table = url.pathname.match(/^\/api\/now\/table\/([^/]+)/)?.[1];
  const query = url.searchParams.get('sysparm_query') ?? '';
  if (url.pathname === '/oauth_token.do') return json(200, { access_token: 'fake-token', expires_in: 1800 });
  if (table === 'sys_scope' && query === 'sys_id=global') return json(200, { result: [{ sys_id: 'global', scope: 'test_namespace' }] });
  if (table === 'sys_update_set' && query === 'is_default=true^state=in progress^application=global') return json(200, { result: [{ sys_id: hex(22000) }] });
  if (table === 'sys_user_preference') {
    if (req.method === 'PATCH') {
      let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => {
        const row = runnerPrefs.find((r) => r.sys_id === url.pathname.split('/')[5]);
        Object.assign(row, JSON.parse(raw)); json(200, { result: row });
      });
      return;
    }
    return json(200, { result: runnerPrefs.filter((r) => query.split('^').every((part) => { const [key, value] = part.split('='); return r[key] === value; })) });
  }
  if (runnerRecords[table] && (table !== 'sys_security_acl' || req.method !== 'GET' || query.startsWith('sys_id='))) {
    const rows = runnerRecords[table];
    if (req.method === 'DELETE') {
      const id = url.pathname.split('/')[5];
      runnerWrites.push({ method: 'DELETE', table, id });
      runnerRecords[table] = rows.filter((r) => r.sys_id !== id);
      return json(200, {});
    }
    if (req.method === 'POST') {
      let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => {
        const body = JSON.parse(raw);
        const row = { ...body, sys_id: hex(20000 + runnerWrites.length), ...(table === 'sys_ws_definition' ? { base_uri: '/api/test_namespace/wayfinder_script_runner' } : {}) };
        runnerWrites.push({ method: 'POST', table, body }); rows.push(row); json(201, { result: row });
      });
      return;
    }
    return json(200, { result: rows.filter((r) => query.split('^').every((part) => { const [key, value] = part.split('='); return String(r[key]) === value; })) });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => {
      const body = JSON.parse(raw || '{}'); const rows = made[table] ?? [];
      const id = url.pathname.split('/')[5];
      const i = id ? rows.findIndex((r) => r.sys_id === id) : -1;
      const row = { ...(i >= 0 ? rows[i] : {}), ...body, sys_id: id ?? `${table}-${rows.length + 1}` };
      if (i >= 0) rows[i] = row; else rows.push(row);
      json(id ? 200 : 201, { result: row });
    });
    return;
  }
  if (table === 'sys_dictionary' && query.includes('name=oauth_entity')) return json(200, { result: SETUP_TABLES.sys_dictionary });
  if (table === 'sys_user_role') return json(200, { result: SETUP_TABLES.sys_user_role.filter((r) => query === `name=${r.name}`) });
  if (table === 'sys_user_has_role') return json(200, { result: query.includes('role.name=admin') ? [{ sys_id: 'h-admin' }] : made.sys_user_has_role.filter((h) => query === `user=${h.user}^role=${h.role}`) });
  if (table === 'oauth_entity') return json(200, { result: made.oauth_entity });
  if (table === 'sys_properties' && query.includes('glide.oauth')) return json(200, { result: made.sys_properties });
  if (table === 'sys_user' && query.includes('wayfinder.integration')) return json(200, { result: made.sys_user });
  if (url.pathname === '/api/now/stats/sys_update_xml') return json(200, { result: { stats: { count: '7' } } });
  // Custom apps, for the placement card's "Another app".
  if (table === 'sys_app') return json(200, { result: [{ scope: 'x_acme_loan', name: 'Loaner' }, { scope: 'x_acme_intake', name: 'Intake' }] });
  if (url.pathname.startsWith('/api/now/stats/')) return json(200, { result: { stats: { count: '0' } } });
  if (url.pathname.startsWith('/api/sn_cicd/progress/')) return json(404, { error: { message: 'not found' } });
  // Insights: development changes (the second log window, the day before, is empty: so the errors are new).
  if (table === 'syslog' && query.includes('hoursAgo(48)')) return json(200, { result: [] });
  if (table === 'syslog' && query.startsWith('level=2^')) return json(200, { result: DEV.syslog });
  if (table === 'sys_dictionary' && (query.includes('sys_updated_on>=') || query.startsWith('reference='))) return json(200, { result: query.startsWith('reference=') ? [] : DEV.sys_dictionary.filter((r) => !query.includes('sys_updated_by=') || query.includes(`sys_updated_by=${r.sys_updated_by}`)) });
  if (['sys_metadata', 'sys_scope', 'sys_update_version', 'sys_update_xml', 'sys_script_include', 'sys_security_acl'].includes(table) && !query.includes('ORDERBYDESCsys_created_on')) return json(200, { result: DEV[table] });
  if (table === 'sys_update_set' && query.startsWith('state=in progress')) return json(200, { result: DEV.sys_update_set });
  if (table === 'sys_script' && (query.startsWith('collection=') || query.includes('sys_idIN'))) return json(200, { result: query.includes('sys_idIN') ? [{ sys_id: hex(900), collection: 'x_acme_loan' }] : DEV.sys_script });
  if (table === 'sys_properties') return json(200, { result: [{ value: readmeDemo ? 'Brazil' : 'fake-build' }] });
  if (table === 'sys_user') return json(200, { result: [{ sys_id: hex(1), user_name: 'admin', last_login_time: readmeDemo ? utc(0) : '' }] });
  // The update set the account's changes go into (read-only in the header).
  if (table === 'sys_update_set' && query === `sys_id=${CURRENT_SET.sys_id}`) return json(200, { result: [CURRENT_SET] });
  if (table === 'v_plugin') return json(200, { result: query.startsWith('idIN') ? [] : PLUGINS });
  if (table === 'sys_remote_app') return json(200, { result: REMOTE });
  // Existing customizations, for the conventions scan (only its queries sort by creation date).
  if (query.includes('ORDERBYDESCsys_created_on') && CUSTOM[table]) return json(200, { result: CUSTOM[table] });
  return json(200, { result: [] });
});
await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));

// A one-page stand-in for ServiceNow's docs repository, so the Download button runs for real without the network.
const docsRepo = join(scratch, 'docs-upstream');
mkdirSync(join(docsRepo, 'markdown', 'itsm'), { recursive: true });
writeFileSync(join(docsRepo, 'markdown', 'itsm', 'sla-timer.md'), '---\ntitle: SLA timer\ncanonical_url: https://www.servicenow.com/docs/r/itsm/sla-timer.html\n---\n\n# SLA timer\n\nThe SLA timer pauses when the pause condition matches.\n');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'flows', GIT_AUTHOR_EMAIL: 'flows@example.com', GIT_COMMITTER_NAME: 'flows', GIT_COMMITTER_EMAIL: 'flows@example.com' };
for (const args of [['init', '-q', '-b', 'brazil'], ['add', 'markdown/itsm/sla-timer.md'], ['commit', '-q', '-m', 'docs']]) execFileSync('git', args, { cwd: docsRepo, env: gitEnv, stdio: 'ignore' });

// The throwaway server. The docs server and the Claude API point at a closed port, as a second guard.
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WAYFINDER_') && !k.startsWith('SNW_'))), // never the real data
  WAYFINDER_DATA_DIR: join(scratch, 'data'), WAYFINDER_CONFIG_DIR: join(scratch, 'config'), WAYFINDER_PORT: String(port), WAYFINDER_SANDBOX: 'off', WAYFINDER_KEYCHAIN: 'off',
  WAYFINDER_ALLOW_HTTP_LOOPBACK: '1', // the fake instance is plain http on 127.0.0.1
  WAYFINDER_SMALL_JOBS: 'off', // titles and summaries would call Claude; the flows check the free fallbacks
  SNDOCS_URL: 'http://127.0.0.1:9/mcp', SNDOCS_TOKEN_FILE: join(scratch, 'no-sndocs-token'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  WAYFINDER_DOCS_REPO: `file://${docsRepo}`,
};
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(server);
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 120; i++) { try { await fetch(`${base}/api/session`); break; } catch { await sleep(250); } }
const token = JSON.parse(readFileSync(join(scratch, 'config', 'secrets.json'), 'utf8')).appToken;
const api = async (path, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.error ?? ''}`);
  return j;
};

// Chrome over the DevTools protocol.
const findShell = () => {
  const root = join(homedir(), '.cache', 'wayfinder-chs', 'chrome-headless-shell');
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort().reverse()) for (const d of readdirSync(join(root, v))) { const p = join(root, v, d, 'chrome-headless-shell'); if (existsSync(p)) return p; }
  return null;
};
const chromeBin = process.env.CHROME ?? findShell() ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// CI runs in a rootless container where Chrome can't create its user-namespace sandbox (AppArmor); the browser only
// loads this throwaway local server there, so CI drops the sandbox. Local runs keep it.
const chrome = spawn(chromeBin, ['--headless=new', ...(process.env.CI ? ['--no-sandbox'] : []), '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'profile')}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
children.push(chrome);
const browserWs = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  chrome.on('exit', (code) => reject(new Error(`Chrome exited (${code}): ${buf.slice(-400)}`)));
  setTimeout(() => reject(new Error(`Chrome did not start: ${buf.slice(-400)}`)), 20_000);
});
const debugBase = browserWs.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
let pageWs;
for (let i = 0; i < 40 && !pageWs; i++) { try { pageWs = (await (await fetch(`${debugBase}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ } if (!pageWs) await sleep(250); }
const sock = new WebSocket(pageWs);
await new Promise((r) => (sock.onopen = r));
let id = 0;
const pending = new Map();
const sent = []; // messages the app tried to send: { chatId, text }
// While holdSends is on, sends stay open (the answer is "in progress") until release() answers them.
let holdSends = false;
const held = [];
// What the next answers stream (a flow can set it, e.g. to show a tool starting); a short text reply otherwise.
let answerEvents = null;
// Hold the post-answer reload when a flow needs to inspect the draft before supplying the saved history.
let holdChatReload = null;
const heldChatReloads = [];
const answer = (requestId) => {
  const body = [...(answerEvents ?? [{ t: 'text', d: 'Test reply.' }]), { t: 'done' }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  cdp('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }], body: Buffer.from(body).toString('base64') });
};
const release = () => { holdSends = false; while (held.length) answer(held.shift()); };
// How the next sends are refused before one is answered: 'updating' (the 503 an update's restart window gives) or
// 'down' (nothing listening, mid-restart).
const sendReplies = [];
// Rejoin: a chat the server "is still answering" (its GET says running while fakeRunning names it) and the live stream
// that replays its answer (liveEvents, held open in heldLive until the flow finishes it).
let fakeRunning = null, liveEvents = [], liveReply = null;   // liveReply: 'empty' (just done) or 'error' (a 500)
const heldLive = [];
const fulfillLive = (requestId, events) => cdp('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }], body: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')).toString('base64') });
const PATTERNS = [{ urlPattern: '*/api/chats/*/send', requestStage: 'Request' }];
const cdp = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params, sessionId })); });
const browserLog = []; // console and security messages (CSP refusals land here)
sock.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? { error: d.error }); pending.delete(d.id); return; }
  if (d.method === 'Log.entryAdded') browserLog.push(d.params.entry.text);
  // Sandboxed previews run in their own process (an out-of-process frame); listen to their log too.
  if (d.method === 'Target.attachedToTarget') { cdp('Log.enable', {}, d.params.sessionId); cdp('Runtime.runIfWaitingForDebugger', {}, d.params.sessionId); }
  if (d.method === 'Fetch.requestPaused') {
    const { requestId, request } = d.params;
    // The demo address is only presentation: the setup preview still reads our loopback fixture, never a real PDI.
    if (readmeDemo && new URL(request.url).pathname === '/api/instances/pdi-setup') {
      const body = { ...JSON.parse(request.postData), url: `http://127.0.0.1:${fakePort}` };
      if (body.confirm) cdp('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      else cdp('Fetch.continueRequest', { requestId, postData: Buffer.from(JSON.stringify(body)).toString('base64') });
      return;
    }
    if (request.method === 'GET' && request.url === holdChatReload) { heldChatReloads.push(requestId); return; }
    if (d.params.responseStatusCode) {   // a chat's GET, at the response: say it's running while fakeRunning names it
      void cdp('Fetch.getResponseBody', { requestId }).then(({ body, base64Encoded }) => {
        const j = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString() : body);
        if (fakeRunning && j.chat?.id === fakeRunning) j.running = true;
        cdp('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(j)).toString('base64') });
      });
      return;
    }
    if (/\/live$/.test(request.url)) {
      if (liveReply === 'empty') fulfillLive(requestId, [{ t: 'done' }]);
      else if (liveReply === 'error') cdp('Fetch.fulfillRequest', { requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"boom"}').toString('base64') });
      else heldLive.push(requestId);
      return;
    }
    sent.push({ chatId: request.url.match(/chats\/([^/]+)\/send/)?.[1], text: JSON.parse(request.postData ?? '{}').text });
    const refuse = sendReplies.shift();
    if (refuse === 'updating') cdp('Fetch.fulfillRequest', { requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'Wayfinder is updating, starting in a moment.', updating: true })).toString('base64') });
    else if (refuse === 'down') cdp('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
    else if (holdSends) held.push(requestId); else answer(requestId);
  }
};
const val = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const q = (sel) => JSON.stringify(sel);
// The first visible element matching the selector (and containing the text, if given).
const find = (sel, text) => `[...document.querySelectorAll(${q(sel)})].find((e) => e.getClientRects().length && (${text === undefined} || e.textContent.includes(${q(text ?? '')})))`;
// A real mouse click at the element's centre, so anything covering it blocks it like it would for a person.
const click = async (sel, text) => {
  const box = await val(`(()=>{const e=${find(sel, text)}; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if (!box) throw new Error(`nothing to click: ${sel}${text ? ` "${text}"` : ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(350);
};
const type = async (text) => { await cdp('Input.insertText', { text }); await sleep(150); };
const KEYS = { Enter: 13, Escape: 27, k: 75, ArrowRight: 39 };
const key = async (k, modifiers = 0) => {
  for (const t of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type: t, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: KEYS[k], modifiers, ...(t === 'keyDown' && k === 'Enter' ? { text: '\r' } : {}) });
  await sleep(300);
};
const waitFor = async (expr, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await val(expr); if (v) return v; await sleep(100); } return false; };
const waitUntil = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return false; };
const desktop = () => cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const open = async () => { await desktop(); await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.rail')`, 10_000); await sleep(400); };
// Opens a chat from the list by its title.
const openChat = async (title) => {
  if (!(await val(`document.querySelector('.shell2').classList.contains('list-open')`))) await click('.rail-btn', 'Chats');
  await click('.chat-link', title);
  await waitFor(`document.querySelector('.chat-head h2')?.textContent === ${q(title)}`);
};

// UI_SHOTS=1 also saves a screenshot at a few named points, for a look at the result.
const shot = async (name) => {
  if (!process.env.UI_SHOTS) return;
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, `shot-${current}-${name}.png`), Buffer.from(data, 'base64'));
};

// Anything visible poking past the right edge, by its class, so a failure says what spilled.
const spillExpr = `(()=>{const w=innerWidth; const out=[...document.querySelectorAll('body *')].filter((e)=>{const r=e.getBoundingClientRect(); if(!r.width||!r.height||r.right<=w+1) return false; const s=getComputedStyle(e); if(s.visibility==='hidden'||e.closest('.list,.rail')&&!document.querySelector('.mobile-nav')) return false; return !e.closest('pre, table, .build-steps, .work-tabs, .home-modes, .home-examples, .pills, iframe');}).map((e)=>(e.className&&typeof e.className==='string'?e.className.split(' ')[0]:e.tagName.toLowerCase())); return [...new Set(out)].slice(0,6).join(', ');})()`;

let fails = 0;
let current = '';
const expect = async (name, ok) => {
  if (!ok) {
    fails++;
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = join(outDir, `${current}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${current}: ${name}`);
};

await cdp('Network.enable');
await cdp('Network.setCookie', { name: 'snw_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true });
await cdp('Fetch.enable', { patterns: PATTERNS });
await cdp('Page.enable');
// UI_DARK=1 runs the flows (and their screenshots) in the dark theme, the design system's own; the default is light.
if (process.env.UI_DARK) await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
// Deleting a chat asks with confirm(); no flow needs it, so dialogs are dismissed rather than left hanging.
sock.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: false }); });
mkdirSync(outDir, { recursive: true });

const flows = {
  async fullpermissions() {
    await api('/setup/done', {});
    const { instance: inst } = await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true, name: 'Permissions check' });
    const put = (body, headers = {}) => fetch(`${base}/api/instances/${inst.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
    await expect('non-PDI cannot enable full permissions through the API', (await put({ full_permissions: true })).status === 400);
    await open(); await click('.rail-btn', 'Settings');
    await expect('non-PDI toggle is disabled with a reason', await waitFor(`document.querySelector('.full-permissions-setting input')?.disabled && document.querySelector('.full-permissions-setting').textContent.includes('Personal developer instances only')`));
    // Only the fixture is labelled PDI: its calls still go to the local fake instance.
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare("UPDATE instances SET kind = 'pdi', full_permissions = 0 WHERE id = ?").run(inst.id);
    await open(); await click('.rail-btn', 'Settings'); await click('.set-nav-item', 'Safety');
    await expect('full permissions is below the existing switches and starts off', await waitFor(`document.querySelectorAll('.set-card .toggle')[2]?.textContent.includes('Full permissions') && document.querySelector('.full-permissions-setting input')?.checked === false`));
    await click('.full-permissions-setting input');
    await expect('enabling explains changes, scripts, installs and logging', await waitFor(`(()=>{const d=document.querySelector('.full-permissions-setting [role=dialog]'); return d && ['Changes, scripts and installs run without asking', 'chat and the approval log', 'Personal developer instances only'].every(t=>d.textContent.includes(t));})()`));
    await expect('the flag stays off until confirmed', (await api('/instances')).find(i => i.id === inst.id).full_permissions === 0);
    await click('.full-permissions-setting button', 'Cancel');
    await expect('cancel leaves it off', !(await val(`document.querySelector('.full-permissions-setting input').checked`)));
    await click('.full-permissions-setting input'); await click('.full-permissions-setting button', 'Turn on Full permissions');
    await expect('confirm persists the flag', await waitUntil(async () => (await api('/instances')).find(i => i.id === inst.id).full_permissions === 1));
    await expect('the settings change is audited', (await api('/audit')).some(a => a.tool === 'full permissions' && a.decision === 'turned on'));
    await expect('cross-origin changes are refused', (await put({ full_permissions: false }, { Origin: 'https://example.com' })).status === 403);
    await expect('non-boolean flags are refused', (await put({ full_permissions: 'yes' })).status === 400);
    await expect('changing to a non-PDI cannot also enable it', (await put({ url: 'https://company.service-now.com', allow_non_pdi: true, full_permissions: true })).status === 400);
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Full permissions check' }, 'PATCH');
    await open(); await openChat('Full permissions check');
    const chip = `[...document.querySelectorAll('.auto-chip')].some(e => e.textContent === 'Full permissions')`;
    await expect('a chat without apps still shows the persistent chip', await waitFor(chip));
    answerEvents = [
      { t: 'approval', id: 'fp1', tool: 'mcp__pdi__activate_plugin', input: { plugin_id: 'com.snc.test' }, auto: true, full_permissions: true },
      { t: 'approval_done', id: 'fp1', decision: 'allow' },
      { t: 'text', d: 'The change was auto-approved.' },
    ];
    // The fake send closes immediately and saves nothing. Hold the reload so the draft remains observable;
    // otherwise ChatView correctly replaces it with the empty server history before the assertion runs.
    holdChatReload = `${base}/api/chats/${chat.id}`;
    await cdp('Fetch.enable', { patterns: [...PATTERNS, { urlPattern: holdChatReload, requestStage: 'Request' }] });
    try {
      const before = sent.length;
      await click('.composer-box textarea'); await type('Make the change'); await key('Enter');
      await expect('the send reaches the fake answer for this chat', await waitUntil(() => sent.length === before + 1 && sent[before].chatId === chat.id && sent[before].text === 'Make the change'));
      await expect('the pending user message stays visible', await waitFor(`!!${find('.msg.user', 'Make the change')}`));
      await expect('streamed auto card names full permissions', await waitFor(`document.querySelector('.approval.auto')?.textContent.includes('✓ Auto-approved (full permissions)')`));
      await expect('the rest of the answer renders', await waitFor(`!!${find('.msg.assistant', 'The change was auto-approved.')}`));
      await expect('completion waits for the saved history', await waitUntil(() => heldChatReloads.length > 0));
      const add = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
      add.run(randomUUID(), chat.id, 'user', JSON.stringify([{ type: 'text', text: 'Make the change' }]), Date.now());
      add.run(randomUUID(), chat.id, 'assistant', JSON.stringify([
        { type: 'approval', id: 'fp1', tool: 'mcp__pdi__activate_plugin', input: { plugin_id: 'com.snc.test' }, auto: true, full_permissions: true, decision: 'allow' },
        { type: 'text', text: 'The change was auto-approved.' },
      ]), Date.now() + 1);
    } finally {
      answerEvents = null; holdChatReload = null;
      while (heldChatReloads.length) await cdp('Fetch.continueRequest', { requestId: heldChatReloads.shift() });
      await cdp('Fetch.enable', { patterns: PATTERNS });
    }
    await expect('completion keeps both saved messages and the auto card', await waitFor(`!document.querySelector('.composer-box .round.stop') && document.querySelectorAll('.msg').length === 2 && document.querySelector('.approval.auto')?.textContent.includes('✓ Auto-approved (full permissions)')`));
    await open(); await openChat('Full permissions check');
    await expect('the saved auto card keeps its label on reload', await waitFor(`document.querySelector('.approval.auto')?.textContent.includes('✓ Auto-approved (full permissions)')`));
    await shot('full-permissions-desktop');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await expect('the chip remains on phone', await waitFor(chip)); await shot('full-permissions-phone'); await desktop();
    await put({ full_permissions: false });
    await expect('turning it off updates an open chat live', await waitFor(`!(${chip})`));
    await put({ full_permissions: true });
    await api(`/instances/${inst.id}`, { url: 'https://company.service-now.com', allow_non_pdi: true }, 'PUT');
    await expect('changing kind turns full permissions off', (await api('/instances')).find(i => i.id === inst.id).full_permissions === 0);
    db.close();
  },
  // What's new: opens from the rail and closes every way; on a phone it closes the sidebar and sits on top.
  async whatsnew() {
    const sheet = `!!document.querySelector('.sheet')`;
    await open();
    await click('.rail .info-btn'); await expect('desktop: panel opens from the rail', await val(sheet));
    await click('.sheet .primary'); await expect('desktop: Got it closes it', !(await val(sheet)));
    await click('.rail .info-btn');
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: 30, y: 450, button: 'left', clickCount: 1 });
    await sleep(400); await expect('desktop: clicking outside closes it', !(await val(sheet)));
    await click('.rail .info-btn'); await key('Escape'); await expect('desktop: Escape closes it', !(await val(sheet)));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.menu-btn')`, 10_000); await sleep(400);
    const navOpen = `document.querySelector('.shell2').classList.contains('mobile-nav')`;
    await click('.menu-btn'); await expect('phone: sidebar opens', await val(navOpen));
    await click('.rail .info-btn');
    await expect('phone: sidebar closes when ⓘ is tapped', !(await val(navOpen)));
    await expect('phone: panel is on top', await val(`(()=>{const r=document.querySelector('.sheet')?.getBoundingClientRect(); if(!r) return false; const e=document.elementFromPoint(r.left+r.width/2, r.top+40); return !!e && !!e.closest('.sheet');})()`));
    await click('.sheet-x'); await expect('phone: × closes it', !(await val(sheet)));
    await click('.menu-btn'); await expect('phone: sidebar opens again after', await val(navOpen));
  },

  // First run: a fresh install shows the three setup steps; Skip for now goes to the home box and sticks.
  async setup() {
    await open();
    await expect('a fresh install shows the setup steps', await waitFor(`document.body.textContent.includes('Three quick steps')`));
    await expect('it says up front that an Anthropic API key can connect Claude', await val(`(()=>{const t=document.querySelector('.claude-options')?.textContent??''; return t.includes('Anthropic API key');})()`));
    await expect('without docs it offers to download them', await waitFor(`!!${find('.extras button', 'Download ServiceNow docs')}`));
    await shot('setup');
    await click('button', 'Skip for now');
    await expect('Skip for now shows the home box', await waitFor(`!!document.querySelector('.home-box textarea')`));
    await expect('the server remembers it', (await api('/settings')).setupDone === true);
    await open();
    await expect('it stays skipped after a reload', await waitFor(`!!document.querySelector('.home-box textarea')`));
  },

  // A PDI that is asleep: connecting says it's waking up (not an error), the banner says so with a way to check, and
  // once it's awake the banner clears.
  async waking() {
    await api('/setup/done', {});
    asleep = true;
    await open();
    await click('.rail-btn', 'Settings');
    await click('button', 'Connect an instance');
    await click('.connect-card .seg-row button', 'Username & password');
    await click('.connect-card input[placeholder^="https://dev"]'); await type(`http://127.0.0.1:${fakePort}`);
    await val(`(()=>{const f=[...document.querySelectorAll('.connect-card .field')]; const set=(label,v)=>{const i=f.find((x)=>x.querySelector('label')?.textContent.startsWith(label))?.querySelector('input'); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true}));}; set('Username','admin'); set('Password','not-a-real-password');})()`);
    await click('.connect-card .optin input');
    await click('.connect-card button[type=submit]');
    await expect('connecting says the PDI is waking up', await waitFor(`(document.querySelector('.toast')?.textContent ?? '').includes('waking up')`, 15_000));
    await expect('and not as an error', !(await val(`!!document.querySelector('.toast.bad')`)));
    await expect('the banner says it is waking up, with a way to check', await waitFor(`!!document.querySelector('.banner.waking') && document.querySelector('.banner.waking').textContent.includes('waking up')`, 10_000));
    await shot('waking');
    asleep = false;
    await click('.banner.waking button', 'Check now');
    await expect('once awake, the banner clears', await waitFor(`!document.querySelector('.banner.waking') && !!document.querySelector('.banner.ok')`, 15_000));
  },

  // Home: one box. Auto guesses the mode; a guessed Build asks first; a picked mode starts straight away; after the
  // first answer the chat offers to keep it in a project.
  async guided() {
    await api('/setup/done', {});
    await open();
    await shot('home');
    await expect('the home box is there with Auto selected', await waitFor(`document.querySelector('.home-modes .mode-pick.on')?.textContent === 'Auto'`));
    await expect('examples show under it', await waitFor(`document.querySelectorAll('.home-examples .pill').length > 0`));
    let before = sent.length;
    await click('.home-box textarea'); await type('Build an app to track loaner laptops with due dates');
    await expect('Auto shows its guess', await waitFor(`(document.querySelector('.home-guess')?.textContent ?? '').includes('Build')`));
    await key('Enter');
    await shot('confirm');
    await expect('a guessed Build asks first, nothing sent', await waitFor(`!!document.querySelector('.home-confirm')`) && sent.length === before);
    await click('.home-confirm button', 'Plan an app');
    await waitUntil(() => sent.length > before);
    let msg = sent.at(-1);
    await expect('the message is sent as written', msg?.text === 'Build an app to track loaner laptops with due dates');
    let chat = msg && (await api(`/chats/${msg.chatId}`)).chat;
    await expect('the chat is in Build mode, titled with the idea, no project', chat?.mode === 'build' && chat?.title.startsWith('Build an app to track') && !chat?.project_id);
    await expect('the chat opens with Build selected', await waitFor(`document.querySelector('select[aria-label="Mode"]')?.value === 'build'`));
    // The browser answers sends itself here, so the stored answer goes straight into the throwaway database.
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), msg.chatId, 'assistant', JSON.stringify([{ type: 'text', text: 'Here is a plan.' }]), Date.now());
    db.close();
    await open();
    await openChat(chat.title);
    await expect('after the answer it offers a project', await waitFor(`!!document.querySelector('.keep-bar')`));
    await click('.keep-bar button', 'New project from this chat');
    await expect('New project keeps the chat in it', await waitUntil(async () => !!(await api(`/chats/${msg.chatId}`)).chat.project_id));
    await expect('the offer goes away', await waitFor(`!document.querySelector('.keep-bar')`));
    // A picked mode skips the guess.
    await open();
    await click('.home-modes .mode-pick', 'Debug');
    before = sent.length;
    await click('.home-box textarea'); await type('Emails stopped sending');
    await key('Enter');
    await waitUntil(() => sent.length > before);
    msg = sent.at(-1);
    chat = msg && (await api(`/chats/${msg.chatId}`)).chat;
    await expect('a picked mode starts that chat directly', chat?.mode === 'debug');
    await open();
    await click('.home-modes .mode-pick', 'Auto');
  },

  // Memory clouds: ✓ keeps a suggestion, × dismisses it; both leave the seat.
  async memory() {
    const chat = await api('/chats', { mode: 'explore' });
    await api(`/chats/${chat.id}`, { title: 'Cloud check' }, 'PATCH');
    // Pip proposes memories during an answer; here they go straight into the throwaway database.
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const add = db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const keep = randomUUID(), drop = randomUUID(), now = Date.now();
    // Put the dismissal first in the API's newest-first order: actions must target a suggestion, not its position.
    add.run(keep, 'Prefer Flow Designer subflows over legacy workflows for new catalog items.', 'From the docs', 'core', null, 'proposed', chat.id, now, now);
    add.run(drop, 'Use a scheduled job for nightly loan reminders.', 'From the chat', 'core', null, 'proposed', chat.id, now + 1, now + 1);
    db.close();
    await open();
    await openChat('Cloud check');
    await expect('two clouds float by Pip', await waitFor(`document.querySelectorAll('.cloud').length === 2`));
    await expect('the suggestion to dismiss comes first', await val(`document.querySelector('.cloud .cloud-text')?.title === 'From the chat'`));
    await expect('the clouds finish arriving before clicking', await waitFor(`[...document.querySelectorAll('.cloud')].every((c) => c.getAnimations().filter((a) => a.animationName === 'cloudUp').every((a) => a.playState === 'finished'))`));
    await click('.cloud:has(.cloud-text[title="From the docs"]) .cloud-yes');
    await expect('✓ saves the memory', await waitUntil(async () => (await api(`/memories/${keep}`)).status === 'saved'));
    await expect('the other memory is still proposed', (await api(`/memories/${drop}`)).status === 'proposed');
    await click('.cloud:has(.cloud-text[title="From the chat"]) .cloud-no');
    await expect('× dismisses the other', await waitUntil(async () => (await api(`/memories/${drop}`)).status === 'dismissed'));
    await expect('the saved memory stays saved', (await api(`/memories/${keep}`)).status === 'saved');
    await expect('both clouds leave', await waitFor(`document.querySelectorAll('.cloud').length === 0`));
  },

  // The approval dial: Auto · project turns on auto mode for 2 hours and is audited; Ask turns it off.
  async dial() {
    const project = await api('/projects', { name: 'Dial check', brief: '' });
    const chat = await api('/chats', { mode: 'build', project_id: project.id });
    await api(`/chats/${chat.id}`, { title: 'Dial chat' }, 'PATCH');
    await open();
    await click('.project-row .chat-link', 'Dial check');
    await click('.chat-link', 'Dial chat').catch(async () => { await click('.project-row .chev-btn'); await click('.chat-link', 'Dial chat'); });
    await waitFor(`!!document.querySelector('.dial')`);
    await expect('the dial starts on Ask', await val(`document.querySelector('.dial button.on')?.textContent === 'Ask'`));
    await click('.dial button', 'Auto · project');
    const on = await waitUntil(async () => { const c = (await api(`/chats/${chat.id}`)).chat; return c.auto_mode === 'project' ? c : null; });
    await expect('Auto · project turns auto mode on', !!on);
    await expect('it lasts about two hours', !!on && Math.abs(on.auto_until - Date.now() - 2 * 3_600_000) < 60_000);
    await expect('the dial shows it', await waitFor(`document.querySelector('.dial button.on')?.textContent === 'Auto · project'`));
    await expect('it is in the approval log', (await api('/audit')).some((a) => a.tool === 'auto mode' && a.chat_id === chat.id));
    await click('.dial button', 'Ask');
    await expect('Ask turns it off', await waitUntil(async () => (await api(`/chats/${chat.id}`)).chat.auto_mode === 'ask'));
  },

  // Chat cards: steps fold into one row, a decided record approval folds to one line, an install result is a card,
  // and the interview form sends one answer message. Then → accepts ghost text in the composer.
  async cards() {
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Card check' }, 'PATCH');
    const questions = { title: 'Two quick things', questions: [{ id: 'who', text: 'Who uses it?', kind: 'choice', options: ['IT staff', 'Everyone'], default: 'IT staff' }, { id: 'remind', text: 'Send reminders?', kind: 'yesno' }], exits: [{ label: 'Use what is built in', reply: 'Show me the built-in option.' }] };
    const blocks = [
      { type: 'tool', id: 't1', name: 'mcp__instance__query_records', input: { table: 'incident' }, status: 'done', result: '[]', ms: 120 },
      { type: 'tool', id: 't2', name: 'mcp__nowaikit__get_table_schema', input: { table: 'incident' }, status: 'done', result: '{}', ms: 90 },
      { type: 'tool', id: 't3', name: 'mcp__nowaikit__run_tool', input: { name: 'get_record', arguments: { table: 'incident' } }, status: 'done', result: '[]', ms: 300 },
      { type: 'approval', id: 'a1', tool: 'mcp__instance__update_record', input: { kind: 'record', action: 'update', tool: 'update_record', table: 'incident', sys_id: '0123456789abcdef0123456789abcdef', record: 'INC0010001 · Email down', changes: { priority: '1' }, also: { data: { priority: '4' } }, unused: { args: { table: 'sys_note' } } }, decision: 'allow' },
      { type: 'approval', id: 'a2', tool: 'mcp__build__enable_atf', input: { kind: 'property', property: 'sn_atf.runner.enabled', from: 'false', to: 'true', why: 'Lets the app tests run.' }, decision: 'deny' },
      { type: 'notice', level: 'info', text: 'Installed.', card: { kind: 'install', title: 'Loaner app installed', ok: true, stats: [{ label: 'Tables', value: 2 }], links: [{ label: 'Open the app', href: 'https://example.com' }] } },
      { type: 'text', text: 'Chart: ![incident chart](https://example.com/x.png?d=secret)' },
      { type: 'text', text: '```html\n<!doctype html><p id="hi">Loaner list</p>\n```' },
      { type: 'text', text: 'Before I plan it:\n\n```questions\n' + JSON.stringify(questions) + '\n```' },
    ];
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'user', JSON.stringify([{ type: 'text', text: 'Mock up the loaner list with due dates' }]), Date.now() - 1000);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify(blocks), Date.now());
    db.close();
    await open();
    await openChat('Card check');
    await expect('three steps fold into one row', await waitFor(`document.querySelectorAll('.step-group').length === 1 && document.querySelector('.step-group .tool-state')?.textContent.includes('3 steps')`));
    await expect('the steps start folded', await val(`!document.querySelector('.step-group .subtools')`));
    await click('.step-group .tool-head');
    await expect('a click shows each step', await waitFor(`document.querySelectorAll('.step-group .subtools .tool').length === 3`));
    await expect('new and saved legacy calls show instance labels', await val(`(()=>{const t = document.querySelector('.step-group .subtools').textContent; return ['instance · query_records', 'instance · get_table_schema', 'instance · get_record'].every(n => t.includes(n)) && !t.includes('nowaikit');})()`));
    await expect('the approved change is one line', await val(`!!${find('.approval.done .approval-line', 'INC0010001')} && !document.querySelector('.approval.done .approval-record')`));
    await click('.approval.done .approval-line');
    await expect('opening it shows table, sys_id and fields', await waitFor(`(document.querySelector('.approval-record')?.textContent ?? '').includes('0123456789abcdef0123456789abcdef') && document.querySelector('.approval-record .changes')?.textContent.includes('priority')`));
    await expect('it also lists every other argument sent', await val(`(()=>{const t=document.querySelector('.approval-record')?.textContent ?? ''; return t.includes('Also sent') && t.includes('Sent but not used') && t.includes('sys_note');})()`));
    await expect('the ATF switch reads as a property change', await val(`!!${find('.approval.done .approval-line', 'Set sn_atf.runner.enabled to true')}`));
    await expect('the install result is a card with a link', await val(`!!document.querySelector('.result-card.ok .result-links a')`));
    await expect('a live view loads in a blob frame', await waitFor(`(document.querySelector('.rb-html iframe')?.src ?? '').startsWith('blob:')`));
    await expect('a web image is a link, not a fetch', await val(`!document.querySelector('.md img[src^="https:"]') && !!${find('.md a[href^="https://example.com/x.png"]', 'incident chart')}`));
    await expect('the questions render as a form', await waitFor(`document.querySelectorAll('.qform fieldset').length === 2`));
    await click('.qform .qchip', 'Yes');
    const before = sent.length;
    await click('.qform button[type=submit]');
    const msg = await waitUntil(async () => sent.length > before && sent[sent.length - 1]);
    await expect('Send answers sends one message with every answer', !!msg && msg.text.includes('Who uses it? → IT staff') && msg.text.includes('Send reminders? → Yes'));
    await waitFor(`!document.querySelector('.composer-box button.stop')`);
    await click('.composer-box textarea');
    await type('Mock up the loa');
    await shot('chat');
    await expect('ghost text offers the rest', await waitFor(`(document.querySelector('.ghost-rest')?.textContent ?? '') === 'ner list with due dates'`));
    await shot('ghost');
    await key('ArrowRight');
    await expect('→ accepts it', await waitFor(`document.querySelector('.composer-box textarea').value === 'Mock up the loaner list with due dates'`));
  },

  // The composer: Pip centred on top of the box with its thought, a one-line box as tall as the round send button,
  // growing with the text, Stop while answering, and the same layout on a phone.
  async composer() {
    const chat = await api('/chats', { mode: 'explore' });
    await api(`/chats/${chat.id}`, { title: 'Composer check' }, 'PATCH');
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'user', JSON.stringify([{ type: 'text', text: 'How do ACLs on incident work?' }]), Date.now() - 1000);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify([{ type: 'text', text: 'Short version: **table** rules first, then **field** rules.\n\n- `incident` decides the row\n- `incident.*` covers every field\n\n```js\ngs.hasRole("itil")\n```' }]), Date.now());
    db.close();
    await open();
    await openChat('Composer check');
    const geo = `(()=>{const r=(s)=>document.querySelector(s)?.getBoundingClientRect(); const b=r('.composer-box'), p=r('.pip-seat .pip-btn'), t=r('.composer-box textarea'), s=r('.composer-box .round'); if(!b||!p||!t||!s) return null; return {box:b.left+b.width/2, pip:p.left+p.width/2, gap:b.top-p.bottom, text:t.height, send:s.height, wide:document.documentElement.scrollWidth>innerWidth};})()`;
    let g = await waitFor(geo);
    await expect('Pip sits centred on top of the box', !!g && Math.abs(g.box - g.pip) <= 2 && g.gap >= 0 && g.gap < 24);
    await expect('the box is one line, as tall as the send button', !!g && Math.abs(g.text - g.send) <= 1);
    await expect('send is an up-arrow icon', await val(`(()=>{const b=document.querySelector('.composer-box .round.primary'); return !!b && b.getAttribute('aria-label')==='Send' && !!b.querySelector('svg') && !b.textContent.trim();})()`));
    await shot('idle');
    await click('.composer-box textarea');
    await type('First line'); await type('\n'); await type('Second line'); await type('\n'); await type('Third line');
    await expect('the box grows with the text', await waitFor(`document.querySelector('.composer-box textarea').getBoundingClientRect().height > 60`));
    await shot('lines');
    holdSends = true;
    await key('Enter');
    await expect('Stop shows while Pip answers', await waitFor(`!!document.querySelector('.composer-box .round.stop[aria-label=Stop]')`));
    await expect('Pip says what it is doing', await waitFor(`/thinking/i.test(document.querySelector('.pip-seat .pip-state')?.textContent ?? '')`));
    await expect('the box is back to one line', await waitFor(`Math.abs(document.querySelector('.composer-box textarea').getBoundingClientRect().height - 36) <= 1`));
    await shot('busy');
    release();
    await expect('the answer lands', await waitFor(`!document.querySelector('.composer-box .round.stop')`));
    await click('.pip-seat .pip-btn');
    const pop = await waitFor(`(()=>{const p=document.querySelector('.pip-pop')?.getBoundingClientRect(), b=document.querySelector('.composer-box').getBoundingClientRect(); return p && Math.abs((p.left+p.width/2)-(b.left+b.width/2)) <= 2 && p.bottom <= b.top;})()`);
    await expect('Pip\'s card opens centred above it', !!pop);
    await shot('pip');
    await click('.pip-pop button', 'Close');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    g = await waitFor(geo);
    await expect('phone: Pip stays centred and nothing scrolls sideways', !!g && Math.abs(g.box - g.pip) <= 2 && !g.wide);
    await shot('phone');
    await desktop();
    if (process.env.UI_SHOTS) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await sleep(400); await shot('light');
      await cdp('Emulation.setEmulatedMedia', { features: [] });
    }
  },

  // Phone: every screen fits the width (nothing spills sideways), the menu opens and closes, and chats read cleanly.
  async mobile() {
    const project = await api('/projects', { name: 'Loaner laptops', brief: 'Track loaner laptops and due dates for the IT desk.' });
    const chat = await api('/chats', { mode: 'build', project_id: project.id });
    await api(`/chats/${chat.id}`, { title: 'Plan the loaner app with reminders and approvals' }, 'PATCH');
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const blocks = [
      { type: 'tool', id: 't1', name: 'mcp__instance__query_records', input: { table: 'alm_hardware' }, status: 'done', result: '[]', ms: 120 },
      { type: 'tool', id: 't2', name: 'mcp__sndocs__search_docs', input: { query: 'asset loaner' }, status: 'done', result: '[]', ms: 300 },
      { type: 'approval', id: 'a1', tool: 'mcp__instance__update_record', input: { kind: 'record', action: 'update', tool: 'update_record', table: 'incident', sys_id: '0123456789abcdef0123456789abcdef', record: 'INC0010001 · Email down for the whole floor', changes: { priority: '1', assignment_group: 'Service Desk' } }, decision: 'allow' },
      { type: 'notice', level: 'info', text: 'Installed.', card: { kind: 'install', title: 'Loaner app installed', ok: true, stats: [{ label: 'Tables', value: 2 }, { label: 'Tests', value: '4/4' }, { label: 'Took', value: '48 s' }], links: [{ label: 'Open the app', href: 'https://example.com' }, { label: 'Update set', href: 'https://example.com' }] } },
      { type: 'text', text: 'Here is the plan:\n\n| Table | What it holds |\n|---|---|\n| x_acme_loan_request | One loan: who, which laptop, due date, status and the approver |\n| x_acme_loan_device | The pool of loaner laptops |\n\n```js\nvar gr = new GlideRecord(\'x_acme_loan_request\'); gr.addQuery(\'due_date\', \'<\', gs.daysAgo(0)); gr.query();\n```' },
    ];
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'user', JSON.stringify([{ type: 'text', text: 'Build a loaner laptop app with due-date reminders and manager approval' }]), Date.now() - 1000);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify(blocks), Date.now());
    db.close();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.rail')`, 10_000); await sleep(600);
    // Anything visible poking past the right edge, by its class, so a failure says what spilled.
    const spill = spillExpr;
    const fits = async (name) => { await sleep(500); const s = await val(spill); await expect(`${name}: fits the phone${s ? ` (spills: ${s})` : ''}`, !s && !(await val('document.documentElement.scrollWidth > innerWidth'))); await shot(name.replace(/\W+/g, '-')); };
    await fits('setup');
    await api('/setup/done', {});
    await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.home-box')`, 10_000);
    await fits('home');
    await click('.menu-btn');
    await expect('the menu opens', await waitFor(`!!document.querySelector('.mobile-nav')`));
    await shot('menu');
    await click('.chat-link', 'Loaner laptops');
    await expect('picking a project closes the menu', await waitFor(`!document.querySelector('.mobile-nav')`));
    await fits('project');
    await click('.menu-btn'); await sleep(400);
    if (!(await val(`!!${find('.chat-link', 'Plan the loaner app')}`))) await click('.project-row .chev-btn');
    await click('.chat-link', 'Plan the loaner app');
    await waitFor(`!!document.querySelector('.composer-box')`);
    await fits('chat');
    await val(`document.querySelector('.messages').scrollTop = 0`); await sleep(300); await shot('chat-top');
    await click('.menu-btn'); await sleep(400); await click('.rail-btn', 'Settings');
    await waitFor(`!document.querySelector('.mobile-nav')`);
    await fits('settings');
    await click('.menu-btn'); await sleep(400); await click('.rail-btn', 'Memory');
    await fits('memory');
    await click('.menu-btn'); await sleep(400); await click('.rail-btn', 'Features');
    await waitFor(`!!document.querySelector('.work')`);
    await fits('features');
    // With an instance connected, the docs and update set pickers live in the drawer, not the title bar.
    await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.home-box')`, 10_000);
    await fits('home with an instance');
    await click('.menu-btn');
    await expect('the instance tools are in the drawer', await waitFor(`!!document.querySelector('.drawer-tools .pop')`));
    await shot('menu-instance');
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: 380, y: 420, button: 'left', clickCount: 1 }); // the dimmed strip beside the drawer
    await expect('tapping outside closes the menu', await waitFor(`!document.querySelector('.mobile-nav')`));
    await desktop();
  },

  // Phone: Insights and the header menus open as a sheet across the bottom that fits the screen, rows wrap instead of
  // being cut off, and × or tapping outside closes them. On a desktop they stay small menus under their button.
  async popovers() {
    await api('/setup/done', {});
    await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    const phone = () => cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    // The open panel's box, and any row whose text is cut off (wider than its row, or clipped by an ellipsis).
    const panel = `(()=>{const p=document.querySelector('.pop-panel'); if(!p) return null; const r=p.getBoundingClientRect(); const cut=[...p.querySelectorAll('.pop-item, .pop-item > span')].filter((e)=>e.scrollWidth>e.clientWidth+1).length; return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:innerWidth,h:innerHeight,cut,sheet:p.classList.contains('sheet-mode')};})()`;
    // Against the real screen size: on a phone, anything spilling sideways widens the page (innerWidth grows with it).
    const inside = (g, w = 390, h = 844) => !!g && g.l >= -0.5 && g.t >= -0.5 && g.r <= w + 0.5 && g.b <= h + 0.5; // half a pixel for sub-pixel rounding
    const settled = async () => { await waitFor(`!!document.querySelector('.pop-panel')`); await sleep(500); return val(panel); }; // after the slide-in
    await phone();
    await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.home-box')`, 10_000);
    await expect('phone: Insights shows on home', await waitFor(`!!document.querySelector('.insights .head-chip')`, 10_000));
    await sleep(800); // the instance status lands just after and redraws the home title
    await click('.insights .head-chip');
    let g = await settled();
    await expect(`phone: Insights fits inside the screen ${JSON.stringify(g)}`, inside(g));
    await expect('phone: Insights opens as a full-width sheet', !!g?.sheet && g.l === 0 && g.r === 390);
    await expect('phone: no Insights row is cut off', g?.cut === 0);
    await shot('insights-phone');
    // A long row (a long instance name, a long finding) wraps onto more lines instead of running off.
    await val(`document.querySelector('.pop-panel .pop-item span').textContent = 'Scheduled job "Nightly CMDB reconciliation for the North America data centres" failed 14 times since Monday'`);
    g = await val(panel);
    await expect('phone: a long row wraps and still fits', inside(g) && g.cut === 0);
    await click('.pop-close');
    await expect('phone: × closes Insights', await waitFor(`!document.querySelector('.pop-panel')`));
    await click('.insights .head-chip'); await waitFor(panel);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: 195, y: 60, button: 'left', clickCount: 1 });
    await expect('phone: tapping above the sheet closes it', await waitFor(`!document.querySelector('.pop-panel')`));
    // The pickers in the drawer (update set; docs when releases are indexed) open the same way.
    await click('.menu-btn'); await waitFor(`!!document.querySelector('.drawer-tools .pop')`);
    const chips = await val(`document.querySelectorAll('.drawer-tools .pop .head-chip').length`);
    for (let i = 0; i < chips; i++) {
      if (!(await val(`!!document.querySelector('.mobile-nav')`))) { await click('.menu-btn'); await sleep(400); }
      await val(`document.querySelectorAll('.drawer-tools .pop .head-chip')[${i}].scrollIntoView({block:'center'})`);
      const box = await val(`(()=>{const r=document.querySelectorAll('.drawer-tools .pop .head-chip')[${i}].getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      g = await settled();
      await expect(`phone: drawer menu ${i + 1} fits inside the screen ${JSON.stringify(g)}`, inside(g) && !!g.sheet);
      await expect(`phone: drawer menu ${i + 1} is on top`, await val(`(()=>{const r=document.querySelector('.pop-panel').getBoundingClientRect(); const e=document.elementFromPoint(r.left+r.width/2, r.top+20); return !!e && !!e.closest('.pop-panel');})()`));
      await shot(`drawer-menu-${i + 1}`);
      await key('Escape');
      await expect(`phone: Escape closes drawer menu ${i + 1}`, await waitFor(`!document.querySelector('.pop-panel')`));
    }
    await expect('phone: the drawer has at least one menu', chips > 0);
    // The other floating panels on a phone: the search bar and Pip's card stay inside the screen.
    const box = (sel) => `(()=>{const r=document.querySelector(${q(sel)})?.getBoundingClientRect(); return r && {l:r.left,r:r.right,t:r.top,b:r.bottom};})()`;
    if (!(await val(`!!document.querySelector('.mobile-nav')`))) { await click('.menu-btn'); await sleep(400); }
    await click('.rail-btn', 'Search'); await sleep(500);
    await expect('phone: the search bar fits inside the screen', inside(await waitFor(box('.palette'))));
    await key('Escape');
    const chat = await api('/chats', { mode: 'explore' });
    await api(`/chats/${chat.id}`, { title: 'Phone Pip card' }, 'PATCH');
    await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.menu-btn')`, 10_000); await sleep(400);
    await click('.menu-btn'); await sleep(400); await click('.chat-link', 'Phone Pip card');
    await waitFor(`!!document.querySelector('.pip-seat .pip-btn')`);
    await click('.pip-seat .pip-btn'); await sleep(500);
    await expect('phone: Pip\'s card fits inside the screen', inside(await waitFor(box('.pip-pop'))));
    await shot('pip-phone');
    // Desktop keeps the small menu under its button.
    await open();
    await waitFor(`!!document.querySelector('.insights .head-chip')`, 10_000); await sleep(800);
    await click('.insights .head-chip');
    g = await settled();
    const chip = await val(`(()=>{const r=document.querySelector('.insights .head-chip').getBoundingClientRect(); return {r:r.right,b:r.bottom};})()`);
    await expect(`desktop: Insights is a menu under its button ${JSON.stringify({ g, chip })}`, inside(g, 1440, 900) && !g.sheet && Math.abs(g.r - chip.r) <= 1 && g.t >= chip.b && !(await val(`!!document.querySelector('.pop-close')?.getClientRects().length`)));
    await shot('insights-desktop');
    await key('Escape');
  },

  // Features: search the (fake) instance, read the statuses, and Guide me starts a chat with the right ask.
  async features() {
    await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    await open();
    const before = sent.length;
    await click('.rail-btn', 'Features');
    await expect('the panel opens in the work area', await waitFor(`!!document.querySelector('.work .features')`));
    await expect('it says what it is', await val(`!!document.querySelector('.features .panel-intro')`));
    await click('.features textarea'); await type('catalog'); await key('Enter', 4);
    await expect('results show', await waitFor(`document.querySelectorAll('.feature').length === 2`));
    await expect('the plugin is ready to turn on', await val(`${find('.feature', 'Catalog Builder')}?.querySelector('.status-chip').textContent === 'Ready to turn on'`));
    await expect('each result says in one line what it does', await val(`!!${find('.feature', 'Catalog Builder')}?.querySelector('.feature-plain')`));
    await expect('the Store app is marked not on PDIs', await val(`${find('.feature', 'Catalog Insights')}?.querySelector('.status-chip').textContent === 'Not on PDIs'`));
    await click('.feature button', 'Guide me');
    await waitUntil(() => sent.length > before);
    await expect('Guide me asks Pip for the walkthrough', !!sent.at(-1)?.text?.startsWith('Walk me through turning on "Catalog Builder" (plugin com.example.catalog_builder)'));
    await expect('the work area closes for the chat', await waitFor(`!document.querySelector('.work')`));
  },

  // ⌘K: opens anywhere, finds a project, starts a chat in a mode, and Escape closes it.
  async palette() {
    await api('/setup/done', {});
    await api('/projects', { name: 'Palette target', brief: '' });
    await open();
    const palette = `!!document.querySelector('.palette')`;
    await key('k', 4);
    await expect('⌘K opens the command bar', await waitFor(palette));
    await key('Escape'); await expect('Escape closes it', await waitFor(`!document.querySelector('.palette')`));
    await key('k', 2);
    await expect('Ctrl+K opens it too', await waitFor(palette));
    await type('Palette target');
    await expect('the project is the top hit', await waitFor(`document.querySelector('.palette-item.on')?.textContent.includes('Palette target')`));
    await key('Enter');
    await expect('Enter opens the project', await waitFor(`!document.querySelector('.palette') && document.querySelector('.project-title .title-input')?.value === 'Palette target'`));
    await click('.rail-btn', 'Search');
    await type('new debug');
    await key('Enter');
    await expect('"new debug" starts a Debug chat', await waitFor(`document.querySelector('select[aria-label="Mode"]')?.value === 'debug'`));
  },

  // User MCP servers: local discovery, secret status, edits, failures and removal.
  async toolservers() {
    await api('/setup/done', {});
    await open(); await click('.rail-btn', 'Settings'); await click('.set-nav-item', 'Tool servers');
    await click('button', 'Add tool server');
    const field = (name) => `(()=>{const l=[...document.querySelectorAll('.tool-server-form label')].find(e=>e.textContent.startsWith(${q(name)})); return l?.querySelector('input,textarea,select');})()`;
    const fill = async (name, value) => {
      await val(`(()=>{const e=${field(name)}; const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${q(value)}); e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
    };
    await expect('local program warning is visible', await val(`document.querySelector('.tool-server-form').textContent.includes('local program with Wayfinder’s permissions')`));
    await fill('Server key', 'sample'); await fill('Label', 'Sample tools');
    await fill('Command', process.execPath);
    await fill('Arguments', JSON.stringify([join(process.cwd(), 'tests/fixtures/toolServer.mjs')]));
    await fill('Environment', JSON.stringify({ EXAMPLE_KEY: 'ui-example-secret' }));
    await click('button', 'Save tool server');
    await expect('server saved disabled by default', await waitFor(`!!${find('.set-card h3', 'Sample tools')} && !document.querySelector('.set-card .toggle input').checked`));
    let rows = await api('/tool-servers');
    await expect('API reports set without the secret', rows[0]?.env.EXAMPLE_KEY === 'set' && !JSON.stringify(rows).includes('ui-example-secret'));
    await expect('saved secret is absent from the page', await val(`!document.body.textContent.includes('ui-example-secret')`));
    await click('button', 'Test Sample tools');
    await expect('Test starts the fixture and lists its tool', await waitFor(`document.querySelector('.set-card [role=status]')?.textContent.includes('lookup')`, 12000));
    await click('.set-card .toggle input');
    await expect('enable persists', (await api('/tool-servers'))[0]?.enabled === true);
    await click('button', 'Edit Sample tools');
    await expect('editing never fills the saved secret', await val(`${field('Environment')}.value === ''`));
    await fill('Label', 'Renamed tools'); await click('button', 'Save tool server');
    await expect('edit preserves secrets', (await api('/tool-servers'))[0]?.env.EXAMPLE_KEY === 'set');
    await click('button', 'Edit Renamed tools');
    await fill('Command', 'missing-wayfinder-fixture-command'); await click('button', 'Save tool server');
    await click('button', 'Test Renamed tools');
    await expect('failed test is a safe inline error', await waitFor(`document.querySelector('[role=alert]')?.textContent.includes('Server unavailable')`, 12000));
    await click('button', 'Remove Renamed tools');
    await expect('remove deletes config and secrets', (await api('/tool-servers')).length === 0 && !readFileSync(join(scratch, 'config', 'secrets.json'), 'utf8').includes('ui-example-secret'));
    await click('button', 'Add tool server');
    await fill('Server key', 'remote'); await fill('Label', 'Remote tools'); await fill('Transport', 'http');
    await fill('Server URL', 'https://example.com/mcp'); await fill('Headers', JSON.stringify({ Authorization: 'ui-header-secret' }));
    await click('button', 'Save tool server');
    rows = await api('/tool-servers');
    await expect('HTTP config saves with secret header status', rows[0]?.transport === 'http' && rows[0]?.headers.Authorization === 'set' && !JSON.stringify(rows).includes('ui-header-secret'));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await expect('phone: tool server section fits', !(await val(spillExpr)));
    await sleep(400);   // the phone relayout settles before the click lands
    await click('button', 'Edit Remote tools');
    await expect('phone: the edit form opens', await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Cancel')`));
    await expect('phone: tool server form fits', !(await val(spillExpr)));
    await shot('mobile-tool-server');
    await click('button', 'Cancel'); await click('button', 'Remove Remote tools');
  },

  // Routines: a scheduled check is added from an Insights template, paused, edited and removed; Build is never offered.
  async routines() {
    await api('/setup/done', {});
    await open(); await click('.rail-btn', 'Settings'); await click('.set-nav-item', 'Routines');
    await click('button', 'Add routine');
    const field = (name) => `(()=>{const l=[...document.querySelectorAll('.routine-form label')].find(e=>e.textContent.startsWith(${q(name)})); return l?.querySelector('input,textarea,select');})()`;
    const fill = async (name, value) => {
      await val(`(()=>{const e=${field(name)}; const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${q(value)}); e.dispatchEvent(new Event(e.tagName==='SELECT'||e.tagName==='INPUT'&&e.type!=='text'?'change':'input',{bubbles:true}));})()`);
    };
    await expect('Build is not a routine mode', await val(`![...${field('Mode')}.options].some((o) => o.value === 'build')`));
    await fill('Start from', 'q-errors');
    await expect('a template fills the title, prompt and mode', await waitFor(`${field('Title')}.value.length > 0 && ${field('What to ask Pip')}.value.includes('log') && ${field('Mode')}.value === 'debug'`));
    await fill('Title', 'Morning log check'); await fill('Every', 'week'); await fill('On', '1'); await fill('At', '7');
    await click('button', 'Save routine');
    await expect('the routine is listed with its schedule', await waitFor(`!!${find('.set-card', 'every Monday at 07:00')}`));
    const rows = await api('/routines');
    await expect('saved enabled, in Debug, with the next run ahead', rows.length === 1 && rows[0].enabled === 1 && rows[0].mode === 'debug' && rows[0].next_run_at > Date.now());
    await click('.set-card .toggle input');
    await expect('pausing persists', await waitUntil(async () => (await api('/routines'))[0]?.enabled === 0));
    await expect('a paused routine says so', await waitFor(`!!${find('.set-card', 'Paused')}`));
    await click('button', 'Edit Morning log check');
    await fill('Title', 'Weekly log check'); await click('button', 'Save routine');
    await expect('edit renames in place', await waitUntil(async () => { const r = await api('/routines'); return r.length === 1 && r[0].title === 'Weekly log check' && r[0].enabled === 0; }));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await expect('phone: routines fit', !(await val(spillExpr)));
    await sleep(400);
    await click('button', 'Edit Weekly log check');
    await expect('phone: the edit form opens', await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Cancel')`));
    await expect('phone: the routine form fits', !(await val(spillExpr)));
    await shot('mobile-routine');
    await click('button', 'Cancel'); await click('button', 'Remove Weekly log check');
    await expect('remove deletes it', await waitUntil(async () => (await api('/routines')).length === 0));
  },

  // Settings: every group and existing setting stays reachable on desktop and phone.
  async settings() {
    await api('/setup/done', {});
    await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true, name: 'Older instance' });
    await api('/instances', { url: `http://localhost:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const add = db.prepare('INSERT INTO audit (at, chat_id, instance_id, tool, input, decision) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 14; i++) add.run(Date.now() - (14 - i) * 60_000, null, null, 'mcp__instance__update_record', '{}', i % 3 ? 'approved' : 'denied');
    db.close();
    const has = (sel, text) => val(`!!${find(sel, text)}`);
    const group = async (name) => { await click('.set-nav-item', name); return waitFor(`document.querySelector('.set-section h2')?.textContent === ${q(name)}`); };
    // Every setting from the old single page, by the group it now lives in. [selector, text, what it is]
    const REACH = {
      Instances: [['.inst-name', undefined, 'rename'], ['button', 'Test', 'test'], ['button', 'Back up update sets', 'back up'], ['button', 'Make active', 'make active'],
        ['.access-details summary', 'What this account can do', 'access details'], ['label', 'Remind me to log in after', 'login reminder'], ['button', 'Connect an instance', 'connect']],
      Pip: [['.seg-row button', 'Alive', 'presence'], ['.seg-row button', 'Off', 'presence off'], ['label', 'Model', 'model'], ['label', 'Small jobs', 'small jobs model'], ['.conventions button', 'Learn from my instance', 'conventions'], ['.set-card h3', 'What Pip learned', 'what Pip learned'], ['.set-card h3', 'Skills', 'skills'], ['.skill-list code', 'fluent', 'the fluent skill'], ['.skill-list code', 'build-flow', 'the build mode skill']],
      Safety: [['.toggle', 'Allow changes to the instance', 'allow changes'], ['.toggle', 'Allow server-side scripts', 'allow scripts'], ['input[aria-label="Domain to allow"]', undefined, 'allowlist add'],
        ['.chip button', undefined, 'allowlist remove'], ['button', 'Rotate app token', 'rotate token'], ['.set-card h3', 'Approval log', 'approval log']],
      'Tool servers': [['button', 'Add tool server', 'add tool server']],
      Routines: [['button', 'Add routine', 'add routine']],
      Advanced: [['.set-card h3', 'Fluent cheat sheet', 'Fluent cheat sheet'], ['button', 'Check now', 'Fluent check'], ['.set-card h3', 'Speed', 'speed']],
    };
    const shots = !!process.env.UI_SHOTS;
    const full = async (name, w, h, mobile) => {
      if (!shots) return;
      const H = await val(`Math.max(document.querySelector('.settings').scrollHeight, innerHeight)`);
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: H + 40, deviceScaleFactor: 1, mobile });
      await sleep(400); await shot(name);
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
    };

    await open();
    await click('.rail-btn', 'Settings');
    await expect('desktop: six sections in the list', await waitFor(`document.querySelectorAll('.set-nav-item').length === 6`));
    await expect('desktop: Instances opens first', await val(`document.querySelector('.set-nav-item[aria-current=page]')?.textContent.startsWith('Instances')`));
    await expect('each section shows its state in the list', await val(`[...document.querySelectorAll('.set-nav-state')].every((e) => e.textContent.trim().length > 0)`));
    await expect('the connect form is hidden until asked for', !(await val(`!!document.querySelector('.connect-card')`)));
    for (const [name, items] of Object.entries(REACH)) {
      await expect(`desktop: ${name} opens`, await group(name));
      await expect(`desktop: ${name} says what it controls`, !!(await val(`document.querySelector('.set-summary')?.textContent`)));
      for (const [sel, text, what] of items) await expect(`still reachable: ${what} (${name})`, await has(sel, text));
      await full(`desktop-${name.toLowerCase()}`, 1280, 900, false);
    }
    await expect('the section is in the address', await val(`location.hash === '#settings/advanced'`));
    await cdp('Page.reload'); await waitFor(`!!document.querySelector('.set-section')`, 10_000);
    await expect('reloading reopens the same section', await waitFor(`document.querySelector('.set-section h2')?.textContent === 'Advanced'`));

    // Instances: access details fold out; the connect form opens, checks https as you type, masks the secret, cancels.
    await group('Instances');
    await click('.access-details summary');
    await expect('access details show Check again', await has('.access button', 'Check again'));
    await click('button', 'Connect an instance');
    await expect('Connect opens the form', await waitFor(`!!document.querySelector('.connect-card form')`));
    await click('.connect-card input[placeholder^="https://dev"]'); await type('http://acme.service-now.com');
    await expect('an http address is flagged while typing', await waitFor(`!!document.querySelector('.connect-card .field-err[role=alert]')`));
    await expect('and the form cannot be sent', await val(`document.querySelector('.connect-card button[type=submit]').disabled`));
    await shot('connect-http');
    await val(`(()=>{const i=document.querySelector('.connect-card input[placeholder^="https://dev"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'https://dev12345.service-now.com'); i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await expect('https clears the warning', await waitFor(`!document.querySelector('.connect-card .field-err')`));
    await expect('the secret is masked', await val(`document.querySelector('.connect-card .secret input').type === 'password'`));
    await click('.connect-card .reveal');
    await expect('Show reveals it', await val(`document.querySelector('.connect-card .secret input').type === 'text'`));
    await expect('the form has one primary button', await val(`document.querySelectorAll('.connect-card .primary').length === 1`));
    await full('desktop-connect', 1280, 900, false);
    await click('.connect-card button', 'Cancel');
    await expect('Cancel closes the form', await waitFor(`!document.querySelector('.connect-card')`));

    // Pip: the model saves and the list's state follows; a toast says it saved.
    await group('Pip');
    await val(`(()=>{const s=[...document.querySelectorAll('.set-card select')].find((e)=>e.querySelector('option[value=sonnet]')); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'sonnet'); s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await expect('model change is saved', await waitUntil(async () => (await api('/settings')).model === 'sonnet'));
    await expect('a toast confirms it', await waitFor(`document.querySelector('.toast')?.textContent === 'Saved'`));
    await expect('the list shows the new model', await waitFor(`${find('.set-nav-item', 'Pip')}?.textContent.includes('Sonnet')`));
    await api('/settings', { model: 'opus' }, 'PUT');

    // Safety: switches, allowlist add/remove, rotate asks first, the log shows the latest 10 with Show all.
    await group('Safety');
    await click('.toggle', 'Allow changes to the instance');
    await expect('Allow changes saves', await waitUntil(async () => (await api('/settings')).writeEnabled === true));
    await expect('the list says changes ask first', await waitFor(`${find('.set-nav-item', 'Safety')}?.textContent.includes('Changes ask first')`));
    await click('input[aria-label="Domain to allow"]'); await type('docs.example.com'); await key('Enter');
    await expect('a domain is added', await waitUntil(async () => (await api('/settings')).allowlist.includes('docs.example.com')));
    await click('.chip button[aria-label="Remove docs.example.com"]');
    await expect('and removed', await waitUntil(async () => !(await api('/settings')).allowlist.includes('docs.example.com')));
    await click('button', 'Rotate app token');
    await expect('rotating asks next to the button', await waitFor(`!!document.querySelector('.confirm-pop')`));
    await expect('the question has focus on its answer', await val(`document.activeElement?.classList.contains('danger')`));
    await shot('rotate-confirm');
    await key('Escape');
    await expect('Escape closes the question without rotating', await waitFor(`!document.querySelector('.confirm-pop')`) && (await api('/session')).ok === true);
    const rows = `document.querySelectorAll('.log li').length`;
    await expect('the log shows the latest 10', (await val(rows)) === 10);
    await click('.set-card button', 'Show all');
    await expect('Show all shows the rest', (await waitFor(`${rows} > 10 && ${rows}`)) > 10);
    await click('.list-filter');
    await type('denied');
    await expect('the log filters', await waitFor(`[...document.querySelectorAll('.log li')].every((l)=>l.textContent.includes('denied'))`));

    // Keyboard: a section opens from the list with Enter, and focus moves to its heading.
    await val(`${find('.set-nav-item', 'Advanced')}.focus()`); await key('Enter');
    await expect('Enter opens a section and focuses its heading', await waitFor(`document.activeElement?.id === 'set-section-title' && document.activeElement.textContent === 'Advanced'`));

    // Phone: the list first, each section drills in and fits, Back returns to the list.
    await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await cdp('Page.navigate', { url: base }); await waitFor(`!!document.querySelector('.menu-btn')`, 10_000); await sleep(400);
    await click('.menu-btn'); await sleep(400); await click('.rail-btn', 'Settings');
    await expect('phone: the list shows first', await waitFor(`document.querySelectorAll('.set-nav-item').length === 6 && !document.querySelector('.set-section')`));
    const fitsPhone = async (name) => { await sleep(400); const s = await val(spillExpr); await expect(`phone: ${name} fits${s ? ` (spills: ${s})` : ''}`, !s && !(await val('document.documentElement.scrollWidth > innerWidth'))); };
    const small = `[...document.querySelectorAll('.settings2 button, .settings2 select, .settings2 input:not([type=checkbox])')].filter((e)=>{const r=e.getBoundingClientRect(); return r.width && r.height && r.height < 43.5;}).map((e)=>e.textContent.trim()||e.getAttribute('aria-label')||e.tagName).slice(0,5).join(', ')`;
    await fitsPhone('the list');
    await full('phone-list', 375, 812, true);
    for (const name of Object.keys(REACH)) {
      await click('.set-nav-item', name);
      await expect(`phone: ${name} opens`, await waitFor(`document.querySelector('.set-section h2')?.textContent === ${q(name)}`));
      if (name === 'Instances') await click('.access-details summary');
      await fitsPhone(name);
      const tiny = await val(small);
      await expect(`phone: ${name} targets are 44 px${tiny ? ` (small: ${tiny})` : ''}`, !tiny);
      await full(`phone-${name.toLowerCase()}`, 375, 812, true);
      await click('.set-back');
      await expect(`phone: back to the list from ${name}`, await waitFor(`!document.querySelector('.set-section') && document.querySelectorAll('.set-nav-item').length === 6`));
    }
    await click('.set-nav-item', 'Instances'); await click('button', 'Connect an instance');
    await waitFor(`!!document.querySelector('.connect-card')`);
    await fitsPhone('the connect form');
    await full('phone-connect', 375, 812, true);
    await api('/settings', { writeEnabled: false }, 'PUT');
    await desktop();
  },

  // Your conventions: opt-in scan of the (fake) instance's customizations, tick the rules to follow, then turn it off.
  // One row per address: connecting an address again updates it; a retired one can be removed (asked next to its
  // button), its chat stays readable and says where it was; the instance in use can't be removed.
  async instances() {
    const live = () => api('/instances');
    const older = `http://127.0.0.1:${fakePort}`, newer = `http://localhost:${fakePort}`;
    const connect = (url, name) => api('/instances', { url, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true, ...(name ? { name } : {}) });
    await expect('earlier flows connected two addresses many times: still two rows', (await live()).length === 2);
    const again = await connect(older);
    await expect('connecting an address again says so', again.reconnected === true);
    await expect('and updates it instead of adding a row', (await live()).length === 2 && (await live()).find((i) => i.status === 'active')?.url === older);
    // A new sign-in that doesn't work, or a "Sign in as me" that's never finished, leaves the old one in place.
    const before = (await live()).find((i) => i.url === older);
    let bad = '';
    try { await api('/instances', { url: older, auth: 'basic', username: 'admin', password: 'wrong-password', allow_non_pdi: true }); } catch (e) { bad = e.message; }
    await expect('a refused new sign-in says the current one is unchanged', bad.includes('400') && bad.includes('unchanged'));
    const pending = await api('/instances', { url: older, auth: 'oauth_user', client_id: 'new-client', allow_non_pdi: true });
    await expect('a new "Sign in as me" waits for the sign-in', pending.needs_login === true);
    const after = (await live()).find((i) => i.url === older);
    await expect('and until then the old sign-in stays', after.auth === 'basic' && after.auth_user === before.auth_user && after.has_secret === true && after.client_id === before.client_id);
    let gone = '';
    try { await api(`/instances/${before.id}/remove`, null, 'POST'); } catch (e) { gone = e.message; }
    await expect('Remove without a body is a 400, not a crash', gone.includes('400'));
    const chat = await api('/chats', { mode: 'explore' });
    await api(`/chats/${chat.id}`, { title: 'Chat on the old address' }, 'PATCH');
    await connect(newer);
    const old = (await live()).find((i) => i.url === older);
    const active = (await live()).find((i) => i.status === 'active');
    await expect('the old address is retired with its chat counted', old.status === 'retired' && old.chat_count >= 1);
    let refused = '';
    try { await api(`/instances/${active.id}/remove`, {}); } catch (e) { refused = e.message; }
    await expect('the instance in use cannot be removed', refused.includes("can't be removed"));

    await open();
    await click('.rail-btn', 'Settings');
    await waitFor(`!!document.querySelector('.inst-row.retired')`);
    await expect('the instance in use has no Remove', !(await val(`!!${find('.inst-card button', 'Remove')}`)));
    await click('.inst-row.retired button', 'Remove');
    await expect('Remove asks first', await waitFor(`!!document.querySelector('.inst-row.retired .confirm-pop')`));
    await expect('the question sits right under its button', await val(`(() => { const b = [...document.querySelectorAll('.inst-row.retired .danger-btn')][0].getBoundingClientRect(), p = document.querySelector('.inst-row.retired .confirm-pop').getBoundingClientRect(); return p.top >= b.bottom && p.top - b.bottom < 24 && p.right <= b.right + 2; })()`));
    const said = old.chat_count === 1 ? 'Its 1 chat stays readable' : `Its ${old.chat_count} chats stay readable`;
    await expect('it says the chats stay readable', await val(`document.querySelector('.confirm-pop').textContent.includes(${q(said)})`));
    await expect('deleting the chats is a box to tick, off by default', await val(`document.querySelector('.confirm-pop input[type=checkbox]')?.checked === false`));
    await shot('remove-confirm');
    await click('.confirm-pop button.danger', 'Remove');
    await expect('a toast confirms it', await waitFor(`(document.querySelector('.toast')?.textContent ?? '').includes(${q(said.slice(4).replace(/^\d+ chats? /, ''))})`));
    await expect('it leaves Settings', await waitFor(`!document.querySelector('.inst-row.retired')`));
    await expect('the API no longer lists it', !(await live()).some((i) => i.id === old.id));
    await openChat('Chat on the old address');
    await expect('its chat is still there, labelled with the old address', await waitFor(`(document.querySelector('.inst-gone')?.textContent ?? '').includes(${q(older)}) && document.querySelector('.inst-gone').textContent.includes('removed')`));
    await shot('removed-chat');
  },

  async conventions() {
    const inst = (await api('/instances')).find((i) => i.status === 'active');
    if (!inst) await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    await open();
    await click('.rail-btn', 'Settings');
    await click('.set-nav-item', 'Pip');
    await expect('the card starts off', await waitFor(`!!${find('.conventions button', 'Learn from my instance')}`));
    await expect('nothing is learned before you ask', (await api('/conventions')).status === 'off');
    await click('.conventions button', 'Learn from my instance');
    await expect('proposed rules show with a tick box each', await waitFor(`document.querySelectorAll('.conventions input[type=checkbox]').length >= 3`, 60_000));
    await expect('the update set rule uses a real name as its example', await val(`!!${find('.conventions .convention', 'STRY0010231 - Loaner reminders')}`));
    await shot('proposed');
    const total = await val(`document.querySelectorAll('.conventions input[type=checkbox]').length`);
    await click('.conventions input[type=checkbox]');
    await click('.conventions button', 'Follow');
    const on = await waitUntil(async () => { const c = await api('/conventions'); return c.status === 'on' ? c : null; });
    await expect('saving keeps only the ticked rules', !!on && on.rules.length === total - 1);
    await expect('it is in the approval log', (await api('/audit')).some((a) => a.tool === 'conventions' && a.decision === 'approved'));
    await click('.conventions button', 'Turn off');
    await expect('Turn off asks first, next to the button', await waitFor(`!!document.querySelector('.conventions .confirm-pop')`));
    await click('.conventions .confirm-pop button.danger', 'Turn off');
    await expect('Turn off clears them', await waitUntil(async () => (await api('/conventions')).status === 'off'));
  },

  // Finished job pills count down on a ring and leave by themselves after 15 s; hovering holds them.
  async jobs() {
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const ins = db.prepare('INSERT INTO jobs (id, instance_id, chat_id, kind, target, progress_id, status, percent, message, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run('job-done', 'i1', null, 'plugin', 'com.example.done', 'p1', 'successful', 100, 'Done', Date.now() - 60_000, Date.now() - 1000);
    db.close();
    await open();
    await expect('the finished pill shows with a countdown ring', await waitFor(`!!document.querySelector('.job.successful .job-timer .ring')`));
    await shot('pill');
    await expect('no × to click', await val(`![...document.querySelectorAll('.job button')].some((b) => b.textContent.trim() === '×')`));
    await expect('it is still there after 10 s', await (async () => { await sleep(10_000); return val(`!!document.querySelector('.job.successful')`); })());
    await expect('it leaves by itself after 15 s', await waitFor(`!document.querySelector('.job.successful')`, 8000));
  },

  // Clarity: sentence boxes grow, Enter adds a line and ⌘/Ctrl+Enter sends; panels say what they are, with empty states.
  async clarity() {
    await api('/setup/done', {});
    await open();
    await click('.rail-btn', 'Memory');
    await waitFor(`!!document.querySelector('.auto-ta textarea')`);
    const ta = `document.querySelector('.settings .auto-ta textarea')`;
    await expect('Teach Pip says Pip reads it but it never gives permission', await val(`document.querySelector('.settings').textContent.includes('never gives permission')`));
    await expect('it shows how to send', await val(`(document.querySelector('.ta-hint')?.textContent ?? '').match(/(⌘|Ctrl) Enter to add/)`));
    const h1 = await val(`${ta}.getBoundingClientRect().height`);
    await click('.settings .auto-ta textarea'); await type('Name update sets after the story number');
    await key('Enter');
    await type('and keep one story per set');
    await expect('Enter adds a new line', await val(`${ta}.value.includes('\\n')`) && !(await val(`document.querySelector('.memory-row')?.textContent.includes('one story per set') ?? false`)));
    await expect('the box grows with it', (await val(`${ta}.getBoundingClientRect().height`)) > h1 + 8);
    await key('Enter', 4);
    await expect('⌘ Enter saves it, both lines', await waitFor(`[...document.querySelectorAll('.memory-row')].some((r) => r.textContent.includes('one story per set'))`));
    await expect('and empties the box', await val(`${ta}.value === ''`));
    await shot('memory');
    // The board says what it is, explains itself when empty, and shows the statuses once there's a clue.
    const chat = await api('/chats', { mode: 'debug' });
    await open(); await openChat(chat.title);
    await click('.rail-btn', 'Board');
    await waitFor(`!!document.querySelector('.board')`);
    await expect('the board says what it is', await val(`(document.querySelector('.board .panel-intro')?.textContent ?? '').includes('Pip reads the board in every chat')`));
    await expect('an empty board explains itself with an example', await val(`!!document.querySelector('.board-empty .clue.example')`));
    await shot('board-empty');
    await click('.board .auto-ta textarea'); await type('Emails stop after the 2 a.m. job'); await key('Enter', 4);
    await expect('⌘ Enter pins the clue', await waitFor(`[...document.querySelectorAll('.board .clue:not(.example)')].some((c) => c.textContent.includes('Emails stop'))`));
    await expect('with a legend for the statuses', await waitFor(`(document.querySelector('.board-legend')?.textContent ?? '').includes('Ruled out')`));
    await shot('board');
  },
  // Set up my PDI for me: the admin login once, a read-only plan first (nothing is written until Set it up), then the
  // integration user and OAuth app are made, the instance connects with them, and the admin password is gone.
  async pdisetup() {
    const adminPw = `pw-${randomBytes(6).toString('hex')}`; // made up per run, so no credential-like text sits in the repo
    await api('/setup/done', {});
    await open();
    await click('.rail-btn', 'Settings');
    await click('button', 'Connect an instance');
    await expect('it is the first choice', await waitFor(`document.querySelector('.connect-card .seg-row button[aria-pressed=true]')?.textContent === 'Set up my PDI for me'`));
    await expect('it asks for the admin login, not a client ID', await val(`(()=>{const l=[...document.querySelectorAll('.connect-card label')].map((x)=>x.textContent); return l.some((t)=>t.startsWith('Admin password')) && !l.some((t)=>t.startsWith('Client ID'));})()`));
    await click('.connect-card input[placeholder^="https://dev"]'); await type('https://acme.service-now.com');
    await expect('a company address is turned away', await waitFor(`document.querySelector('.connect-card .field-err')?.textContent.includes('personal developer instances') && document.querySelector('.connect-card button[type=submit]').disabled`));
    await val(`(()=>{const set=(i,v)=>{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true}));}; set(document.querySelector('.connect-card input[placeholder^="https://dev"]'), ${q(`http://127.0.0.1:${fakePort}`)}); set(document.querySelector('.connect-card .secret input'), ${q(adminPw)});})()`);
    await click('.connect-card button[type=submit]');
    await expect('it shows what it will do first', await waitFor(`document.querySelectorAll('.setup-plan li').length === 6`, 10_000));
    await shot('plan');
    await expect('and has written nothing yet', Object.values(made).every((rows) => rows.length === 0));
    // Changing the address drops the plan, so Set it up can't run against an instance the plan didn't show.
    const setUrl = (u) => val(`(()=>{const i=document.querySelector('.connect-card input[placeholder^="https://dev"]'); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,${q(u)}); i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await setUrl(`http://localhost:${fakePort}`);
    await expect('changing the address drops the plan', await waitFor(`!document.querySelector('.setup-plan')`));
    await setUrl(`http://127.0.0.1:${fakePort}`);
    await click('.connect-card button[type=submit]');
    await waitFor(`document.querySelectorAll('.setup-plan li').length === 6`, 10_000);
    await click('.setup-plan button', 'Set it up');
    await expect('it says it is set up', await waitFor(`(document.querySelector('.toast')?.textContent ?? '').includes('Set up and connected')`, 15_000));
    await expect('the integration user, its two roles and the OAuth app exist', made.sys_user[0]?.user_name === 'wayfinder.integration' && made.sys_user_has_role.length === 2 && made.oauth_entity[0]?.default_grant_type === 'client_credentials' && made.sys_properties[0]?.value === 'true');
    await expect('the instance signs in with them', await waitFor(`(document.querySelector('.inst-card')?.textContent ?? '').includes('Integration user (OAuth)')`));
    const inst = (await api('/instances')).find((i) => i.status === 'active');
    await expect('with the new client ID', inst?.client_id === made.oauth_entity[0].client_id && inst.auth === 'client_credentials');
    const log = await api('/audit');
    await expect('it is in the activity log, without the password', JSON.stringify(log).includes('set up the PDI') && !JSON.stringify(log).includes(adminPw));
    await expect('the admin password is not kept', !readFileSync(join(scratch, 'config', 'secrets.json'), 'utf8').includes(adminPw));
    await expect('each change is in the log as it happened', ['PDI setup: Allow client-credentials', 'PDI setup: Integration user', 'PDI setup: Role admin', 'PDI setup: OAuth app', 'PDI setup: Sign in with it'].every((t) => JSON.stringify(log).includes(t)));
    // The server only confirms a plan it issued, for that address and admin.
    // The admin login as the setup call expects it. Built from pairs so the request doesn't read like a stored login.
    const adminLogin = Object.fromEntries([['username', 'admin'], ['password', adminPw]]);
    const body = { url: `http://127.0.0.1:${fakePort}`, ...adminLogin, confirm: true };
    const refusal = async (b) => { try { await api('/instances/pdi-setup', b); return ''; } catch (e) { return e.message; } };
    await expect('confirm without a plan is refused', (await refusal(body)).includes('409'));
    const other = await api('/instances/pdi-setup', { ...body, url: `http://localhost:${fakePort}`, confirm: false });
    await expect('a plan for another address is refused', (await refusal({ ...body, plan_id: other.plan_id })).includes('409'));
    // Running it again reconnects the same instance: still one row for the address.
    const again = await api('/instances/pdi-setup', { ...body, confirm: false });
    const second = await api('/instances/pdi-setup', { ...body, plan_id: again.plan_id });
    await expect('running it again updates the same instance', second.reconnected === true && (await api('/instances')).filter((i) => i.url === body.url).length === 1);
    await expect('a plan is used once', (await refusal({ ...body, plan_id: again.plan_id })).includes('409'));
  },

  // The update set pill is read-only: Pip switches sets. It shows the set and its app; clicking says what's in it, and
  // when and why Pip last switched it, with a link to ServiceNow.
  async setpill() {
    await api('/setup/done', {});
    const inst = (await api('/instances')).find((i) => i.status === 'active');
    if (!inst) await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    const active = (await api('/instances')).find((i) => i.status === 'active');
    await api(`/instances/${active.id}/access`, {});
    // Pip switched to it from a chat (the tool writes this audit entry).
    const chat = await api('/chats', { mode: 'build' });
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO audit (at, chat_id, instance_id, tool, input, decision) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now() - 5 * 60_000, chat.id, active.id, 'update set', JSON.stringify({ name: CURRENT_SET.name, why: 'The loaner reminder work belongs to the Loaner app' }), 'switched by Pip');
    db.close();
    await open();
    const pill = '.head-tools .set-pill .head-chip';
    await expect('the pill shows the set and its app', await waitFor(`(document.querySelector(${q(pill)})?.textContent ?? '').includes('STRY0010231 - Loaner reminders') && document.querySelector(${q(pill)}).textContent.includes('Loaner')`, 10_000));
    await click(pill);
    await expect('clicking shows what is in it', await waitFor(`(()=>{const t=document.querySelector('.set-info')?.textContent ?? ''; return t.includes('x_acme_loan') && t.includes('in progress') && t.includes('7');})()`));
    await expect('and when and why Pip switched it', await val(`(document.querySelector('.set-last')?.textContent ?? '').includes('Pip switched to it 5 min ago: The loaner reminder work belongs to the Loaner app')`));
    await expect('with a link to it in ServiceNow', await val(`(document.querySelector('.set-info a')?.getAttribute('href') ?? '').endsWith('/sys_update_set.do?sys_id=${CURRENT_SET.sys_id}')`));
    await expect('nothing in it switches the set', await val(`!document.querySelector('.set-info .pop-item') && ![...document.querySelectorAll('.set-info button')].some((b) => /switch|make current/i.test(b.textContent))`));
    await shot('popover');
    await click('.set-info button', 'Open the chat');
    await expect('Open the chat goes to the chat that switched it', await waitFor(`!!document.querySelector('.chat-head')`));
    let gone = '';
    try { await api('/updatesets/current', { sys_id: CURRENT_SET.sys_id }); } catch (e) { gone = e.message; }
    await expect('there is no route to switch it from the app', /404|405/.test(gone));
  },
  // Insights: development changes and new log errors, not ticket counts; filter by person; Impact opens a chat that maps
  // what a change touches.
  async insights() {
    await api('/setup/done', {});
    if (!(await api('/instances')).some((i) => i.status === 'active')) await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    await open();
    await waitFor(`!!document.querySelector('.insights .head-chip')`, 10_000); await sleep(800);
    await click('.insights .head-chip');
    await waitFor(`!!document.querySelector('.ins-row')`);
    const panelText = `(document.querySelector('.pop-panel')?.textContent ?? '')`;
    await expect('no ticket counts', !(await val(`/P1|incident/i.test(${panelText})`)));
    await expect('new script errors, named by the rule that throws them', await val(`${panelText}.includes('new script errors since yesterday, all from business rule "Loan - set due date" on "x_acme_loan"')`));
    await expect('a field that changed type', await val(`${panelText}.includes('x_acme_loan.u_status changed type (string → integer)')`));
    await expect('what it touches is only searched when asked', !(await val(`${panelText}.includes('1 script and 1 ACL read it')`)));
    await click('.ins-row .ins-touch');
    await expect('then the row says what reads it', await waitFor(`${panelText}.includes('x_acme_loan.u_status: 1 script and 1 ACL read it')`, 8000));
    await expect('update sets in progress, with the shared record', await val(`${panelText}.includes('1 record in two sets')`));
    await expect('each change has an Impact button', await val(`document.querySelectorAll('.ins-impact').length >= 2`));
    await shot('after');
    const person = (v) => val(`(()=>{const s=document.querySelector('.ins-filters select[aria-label=Person]'); s.value=${q(v)}; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await person('bob');
    await expect('filtering by a person narrows the changes', await waitFor(`${panelText}.includes('scripts changed by 1 person') && !${panelText}.includes('changed type')`, 8000));
    await person('');
    await waitFor(`${panelText}.includes('changed type')`, 8000);
    const before = sent.length;
    await click('.ins-row .ins-impact');
    const msg = await waitUntil(async () => sent.length > before && sent[sent.length - 1], 8000);
    await expect('Impact opens a chat that maps what the change touches', !!msg && msg.text.includes('pdi impact') && msg.text.includes('x_acme_loan.u_status') && /read-only/i.test(msg.text));
    await expect('titled as an impact check', await waitFor(`(document.querySelector('.chat-head h2')?.textContent ?? '').startsWith('Impact:')`));
  },

  // Where the work lives: Pip's card before the first change in a chat. It names the home, why, the mismatch and the
  // alternatives; "Another app" lists the instance's apps; Accept switches the update set there and the card folds to one line.
  async placement() {
    await api('/setup/done', {});
    if (!(await api('/instances')).some((i) => i.status === 'active')) await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    const chat = await api('/chats', { mode: 'explore' });
    await api(`/chats/${chat.id}`, { title: 'Placement check' }, 'PATCH');
    const home = { place: 'owning-app', scope: 'x_acme_loan', name: 'Loaner' };
    const rec = { home, rule: 'other-apps-table', why: 'The table belongs to another application, so changes to it belong in that application.', warn: 'Doing it from a different app needs cross-scope access granted on that table.',
      alternatives: [{ place: 'new-app', scope: null, name: 'A new custom app' }, { place: 'global', scope: 'global', name: 'Global' }], mismatch: "You're in Global, but x_acme_loan_request belongs to Loaner." };
    const card = { id: 'card-1', work: 'Due date reminders', update_set: 'Loans: reminders', ...rec };
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const activeId = (await api('/instances')).find((i) => i.status === 'active').id;
    db.prepare('UPDATE chats SET placement = ? WHERE id = ?').run(JSON.stringify({ status: 'pending', id: card.id, instance_id: activeId, work: card.work, update_set: card.update_set, placement: rec, at: Date.now() }), chat.id);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'user', JSON.stringify([{ type: 'text', text: 'Send reminders when a loaner is overdue' }]), Date.now() - 1000);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify([
      { type: 'tool', id: 'tp', name: 'mcp__pdi__placement', input: { work: card.work }, status: 'done', result: JSON.stringify({ placement_card: card, note: 'Stop now.' }), ms: 200 },
      { type: 'text', text: 'Pick where this lives and I will carry on.' },
    ]), Date.now());
    db.close();
    await open();
    await openChat('Placement check');
    const cardText = `(document.querySelector('.approval.placement')?.textContent ?? '')`;
    await expect('the card asks where it should live', await waitFor(`!!${find('.approval.placement.pending .approval-head', 'Where should this live?')}`));
    await expect('with the home and why', await val(`${cardText}.includes('Loaner (x_acme_loan)') && ${cardText}.includes('belong in that application')`));
    await expect('it says when you are in another app', await val(`${cardText}.includes("You're in Global, but x_acme_loan_request belongs to Loaner.")`));
    await expect('and what else is possible', await val(`${cardText}.includes('Also possible: A new custom app · Global (global)')`));
    await expect('and which update set it will use', await val(`${cardText}.includes('Update set: Loans: reminders, in Loaner')`));
    await click('.approval.placement button', 'Another app');
    await expect('Another app lists the apps on the instance', await waitFor(`[...document.querySelectorAll('.place-pick option')].map((o) => o.textContent).join('|') === 'Pick an app…|Global (global)|Loaner (x_acme_loan)|Intake (x_acme_intake)'`));
    await shot('placement');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    await expect('on a phone the card fits the screen', await val(`(()=>{const r=document.querySelector('.approval.placement').getBoundingClientRect(); return r.right <= innerWidth + 0.5 && document.documentElement.scrollWidth <= innerWidth;})()`));
    await shot('placement-phone');
    await desktop();
    await sleep(300);
    await click('.approval.placement button', 'Use Loaner');
    await expect('accepting settles it in one line', await waitFor(`!!${find('.approval.placement .approval-line', 'Loaner (x_acme_loan)')}`, 8000));
    const now = (await api(`/chats/${chat.id}/placement`)).placement;
    await expect('the chat keeps the choice', now?.status === 'settled' && now.home.scope === 'x_acme_loan' && !!now.update_set);
    let again = '';
    try { await api(`/chats/${chat.id}/placement`, { id: card.id, by: 'new-app' }); } catch (e) { again = e.message; }
    await expect('the card can only be answered once', again.includes('already answered'));

    // Settings → Pip → Placement rules: the rules as one file; a broken file is refused with the reason; Reset goes back.
    await click('.rail-btn', 'Settings');
    await waitFor(`!!${find('.set-nav-item', 'Pip')}`, 8000);
    await click('.set-nav-item', 'Pip');
    await expect('the shipped rules show as cards, first match first', await waitFor(`document.querySelectorAll('.rule').length === 8 && document.querySelector('.rule .rule-id')?.value === 'other-apps-table' && !!${find('.set-card', 'Shipped rules')}`));
    // Cards: move the last rule up one and save; Pip's rules file keeps that order.
    await click('.rule:last-child button[aria-label^="Move"][aria-label$="up"]');
    await expect('the card moves up', await val(`[...document.querySelectorAll('.rule .rule-id')].slice(-2).map((e) => e.value).join(',') === 'default,no-table-yet'`));
    await click('.set-card button', 'Save rules');
    await expect('saving the cards writes your rules in order', await waitFor(`!!${find('.set-card', 'Your rules: 8 rules')}`) && (await api('/placement/rules')).list.map((r) => r.id).slice(-2).join(',') === 'default,no-table-yet');
    await click('.set-card .danger-btn', 'Reset to shipped rules');
    await click('.confirm-pop button.danger', 'Reset');
    await expect('Reset brings the shipped order back', await waitFor(`!!${find('.set-card', 'Shipped rules')} && document.querySelector('.rule:last-child .rule-id')?.value === 'default'`));
    // The file behind the cards: a broken file is refused with the reason; Reset goes back.
    await click('.file-fold summary', 'Edit as text');
    await expect('the rules editor shows the shipped rules', await waitFor(`(document.querySelector('#placement-rules')?.value ?? '').includes('## new-data-model')`));
    const setRules = (text) => val(`(()=>{const t=document.querySelector('#placement-rules'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t, ${q(text)}); t.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
    await setRules('---\nname: placement\ndescription: Ours.\n---\n\n## nothing\nplace: nowhere\nwhy: x\n');
    await click('.set-card button', 'Save file');
    await expect('a file with no usable rules is refused, with why', await waitFor(`(document.querySelector('.set-card .error')?.textContent ?? '').includes('No usable rules')`));
    await setRules('---\nname: placement\ndescription: Ours.\n---\n\n## all-global\nif: always\nplace: global\nwhy: We keep it in global.\n');
    await click('.set-card button', 'Save file');
    await expect('saving your rules uses them', await waitFor(`!!${find('.set-card', 'Your rules: 1 rule')}`));
    await click('.set-card .danger-btn', 'Reset to shipped rules');
    await click('.confirm-pop button.danger', 'Reset');
    await expect('Reset goes back to the shipped rules', await waitFor(`!!${find('.set-card', 'Shipped rules')} && (document.querySelector('#placement-rules')?.value ?? '').includes('## new-data-model')`));
    // Skills: edited right here; your copy wins and Reset brings the shipped one back.
    await click('button', 'Edit Debug method');
    await expect('the skill opens in an editor', await waitFor(`(document.querySelector('#skill-text')?.value ?? '').startsWith('---')`));
    await val(`(()=>{const t=document.querySelector('#skill-text'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t, '---\\nname: debug-method\\ndescription: Mine.\\nmode: debug\\n---\\nStart from the log.'); t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('.skill-editor button', 'Save skill');
    await expect('your copy is listed as yours', await waitFor(`!!${find('.skill-row', 'yours')} && !!${find('.skill-row', 'Mine.')}`));
    await click('button', 'Edit Debug method');
    await click('.skill-editor .danger-btn', 'Reset to shipped');
    await click('.confirm-pop button.danger', 'Reset');
    await expect('Reset brings the shipped skill back', await waitFor(`!${find('.skill-row', 'yours')}`));
  },
  // The Memory page: one queue item at a time with a conflict label, rules grouped by where they apply with where they
  // came from, Pause keeps a rule but takes it out of the count, Delete asks first, "Guided by N rules" under an answer
  // opens the page, and it fits a phone.
  async memoryhub() {
    await api('/setup/done', {});
    const ruleText = 'Prefer Flow Designer over business rules for approvals';
    await api('/memories', { text: ruleText });
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), 'Never use business rules for approvals', 'You corrected me in a chat', 'core', null, 'proposed', 'chat-x', Date.now(), Date.now());
    db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), 'Name script includes in PascalCase', 'Seen on the instance', 'core', null, 'proposed', 'chat-x', Date.now() - 1000, Date.now() - 1000);
    const chat = await api('/chats', { mode: 'explore' });
    await api(`/chats/${chat.id}`, { title: 'Guided check' }, 'PATCH');
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify([{ type: 'text', text: 'Use a flow for that.' }, { type: 'guided', count: 3 }]), Date.now());
    db.close();
    await open();
    await openChat('Guided check');
    await expect('an answer says how many rules guided it', await waitFor(`!!${find('.guided', 'Guided by 3 rules')}`));
    await click('.guided');
    await expect('which opens the Memory page', await waitFor(`!!document.querySelector('.memory-hub')`));
    const page = `(document.querySelector('.memory-hub')?.textContent ?? '')`;
    await expect('it says rules never give permission', await val(`${page}.includes('never give permission')`));
    await expect('one suggestion at a time, with how many wait', await val(`document.querySelectorAll('.mem-queue .memory-row').length === 1 && document.querySelector('#mem-queue-h').textContent.includes('1 of 2')`));
    await expect('a suggestion that clashes is labelled', await val(`!!${find('.mem-queue .mem-badge.conflict', 'May conflict with: Prefer Flow Designer')}`));
    await shot('memoryhub-queue');
    await expect('rules are grouped by where they apply, with where they came from', await val(`!!${find('.mem-group h3', 'Every chat')} && [...document.querySelectorAll('.mem-group .memory-row')].some((r) => r.textContent.includes(${q(ruleText)}) && r.querySelector('.origin-you'))`));
    await expect('placement rules are listed read-only, with where to edit them', await val(`(()=>{const g=[...document.querySelectorAll('.mem-group')].find((x) => x.querySelector('h3')?.textContent.startsWith('Where work lives')); return !!g && g.querySelectorAll('.memory-row').length > 3 && !g.querySelector('.memory-row button') && g.textContent.includes('Settings → Pip → Placement rules') && !!g.querySelector('.origin-placement');})()`));
    const count = () => val(`Number((document.querySelector('.mem-budget strong')?.textContent ?? '').match(/\\d+/)?.[0] ?? -1)`);
    const before = await count();
    await click('.mem-queue button', 'Not now');
    await expect('Not now shows the next one', await waitFor(`${page}.includes('Name script includes in PascalCase') && !document.querySelector('#mem-queue-h').textContent.includes('of')`));
    await click('.mem-queue button', 'Keep');
    await expect('Keep adds it to the active rules', await waitFor(`!document.querySelector('.mem-queue') && [...document.querySelectorAll('.mem-group .memory-row')].some((r) => r.textContent.includes('PascalCase'))`));
    await expect('and to what Pip reads', await waitUntil(async () => (await count()) === before + 1));
    const ruleRow = `[...document.querySelectorAll('.mem-group .memory-row')].find((r) => r.textContent.includes(${q(ruleText)}))`;
    await val(`[...${ruleRow}.querySelectorAll('button')].find((b) => b.textContent === 'Pause').click()`);
    await expect('Pause keeps the rule, marked paused', await waitFor(`!!${ruleRow}?.querySelector('.mem-badge.paused')`));
    await expect('and out of what Pip reads', await waitUntil(async () => (await count()) === before));
    await shot('memoryhub');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    await expect('on a phone the page fits the screen', await val(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.memory-hub .card')].every((c) => c.getBoundingClientRect().right <= innerWidth + 0.5)`));
    await shot('memoryhub-phone');
    await desktop();
    await sleep(300);
    await val(`[...${ruleRow}.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click()`);
    await expect('Delete asks first', await waitFor(`!!document.querySelector('.memory-hub .confirm-pop')`));
    await click('.confirm-pop button.danger', 'Delete');
    await expect('then the rule is gone', await waitFor(`!(${ruleRow})`));
  },

  // Under each answer: its steps out of the mode's limit and its estimated cost (no rules link when no rule guided it),
  // and a plain note when it hit the limit. Settings → Pip: the spending limit card shows today's spend and saves a limit.
  async budget() {
    await api('/setup/done', {});
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO perf (at, chat_id, mode, start_ms, first_word_ms, total_ms, tools, turns, tool_errors, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(Date.now(), 'x', 'explore', 1, 1, 1, '[]', 3, 0, 4.2);
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Costs check' }, 'PATCH');
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify([
      { type: 'text', text: 'Built the first table.' },
      { type: 'notice', level: 'warn', text: 'Pip used all 80 steps one answer can take in this mode, so it stopped here. Say "continue" to pick up where it left off.' },
      { type: 'guided', count: 0, steps: 80, limit: 80, cost: 0.042 },
    ]), Date.now());
    db.close();
    await open();
    await openChat('Costs check');
    await expect('an answer shows its steps out of the limit and its cost', await waitFor(`${find('.answer-facts', '80 of 80 steps · ~$0.042')} !== undefined`));
    await expect('with no rules link when no rule guided it', await val(`!document.querySelector('.answer-foot .guided')`));
    await expect('and says plainly that it hit the limit', await val(`!!${find('.notice.warn', 'Say "continue"')}`));
    await shot('budget-footer');
    await click('.rail-btn', 'Settings');
    await click('.set-nav-item', 'Pip');
    const card = `[...document.querySelectorAll('.set-card')].find((c) => c.querySelector('h3')?.textContent === 'Spending limit')`;
    await expect('Settings shows today\'s spend with no limit', await waitFor(`(${card})?.textContent.includes('Off · ~$4.20 today')`));
    await val(`(()=>{const s=(${card}).querySelector('select'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'5'); s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await expect('a limit saves and shows', await waitFor(`(${card})?.textContent.includes('$5 a day · ~$4.20 today')`));
    await expect('and is kept', (await api('/settings')).dailyBudgetUsd === 5);
    await shot('budget-settings');
    await api('/settings', { dailyBudgetUsd: 0 }, 'PUT');
  },

  // A long chat's note offers a fresh chat; it opens with the summary it started from, and the old chat says where it went.
  async freshchat() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'debug' });
    await api(`/chats/${chat.id}`, { title: 'Long investigation' }, 'PATCH');
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const add = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
    add.run(randomUUID(), chat.id, 'user', JSON.stringify([{ type: 'text', text: 'Why did emails stop sending?' }]), Date.now() - 2000);
    add.run(randomUUID(), chat.id, 'assistant', JSON.stringify([{ type: 'text', text: 'The SMTP account was switched off.' },
      { type: 'notice', level: 'info', action: 'fresh-chat', text: 'This chat is getting long: each step now reads about 104k tokens, so answers are slower and cost more. A fresh chat is quicker for new work.' }]), Date.now() - 1000);
    db.close();
    await open();
    await openChat('Long investigation');
    await expect('the long-chat note offers a fresh chat', await waitFor(`!!${find('.notice button', 'Continue in a fresh chat')}`));
    await shot('freshchat-offer');
    await click('.notice button', 'Continue in a fresh chat');
    await expect('which opens a new chat, same title marked continued', await waitFor(`!!${find('.chat-item.active', 'Long investigation (continued)')}`));
    await expect('starting from a summary of the old one', await waitFor(`!!${find('.notice', 'Continued from "Long investigation"')}`));
    await click('.notice .carried summary');
    await expect('that you can open', await waitFor(`!!${find('.notice .carried li', 'The user asked: Why did emails stop sending?')}`));
    await shot('freshchat-new');
    await val(`[...document.querySelectorAll('.chat-link')].find((e) => e.textContent.trim() === 'Long investigation').click()`);
    await waitFor(`document.querySelector('.chat-head h2')?.textContent === 'Long investigation'`);
    await expect('the old chat says where it went', await waitFor(`!!${find('.notice', 'Continued in a fresh chat: "Long investigation (continued)"')}`));
  },

  // An answer a restart cut off: the note says so and Continue asks Pip to pick it up again, in the same chat.
  async cutoff() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Cut off check' }, 'PATCH');
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const add = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
    add.run(randomUUID(), chat.id, 'user', JSON.stringify([{ type: 'text', text: 'Plan approved. Build it.' }]), Date.now() - 2000);
    add.run(randomUUID(), chat.id, 'assistant', JSON.stringify([{ type: 'text', text: 'Writing the script include.' },
      { type: 'notice', level: 'warn', action: 'continue', text: "Pip's answer was cut off: Wayfinder restarted (an update, or the computer restarting) before it finished. 3 steps finished before that." }]), Date.now() - 1000);
    db.close();
    await open();
    await openChat('Cut off check');
    await expect('the note says the answer was cut off', await waitFor(`!!${find('.notice.warn', 'was cut off')}`));
    await expect('and offers Continue', await waitFor(`!!${find('.notice button', 'Continue')}`));
    await shot('cutoff');
    const before = sent.length;
    await click('.notice button', 'Continue');
    for (let i = 0; i < 50 && sent.length === before; i++) await sleep(100);
    await expect('which asks Pip to carry on in this chat', sent.length === before + 1 && sent.at(-1).chatId === chat.id && /Continue where you left off/.test(sent.at(-1).text));
    await waitFor(`!document.querySelector('.composer-box .round.stop')`);
  },

  // A message sent while an update restarts the app: it's held with "updating" (not an error) and goes through to the
  // new server on its own, once.
  async updating() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Updating check' }, 'PATCH');
    await open();
    await openChat('Updating check');
    sendReplies.push('updating', 'down');
    holdSends = true;
    const before = sent.length;
    await click('.composer-box textarea');
    await type('Plan approved. Build it.');
    await key('Enter');
    await expect('the answer says Wayfinder is updating', await waitFor(`!!${find('.notice', 'Wayfinder is updating, starting in a moment')}`));
    await expect('not an error', await val(`!document.querySelector('.notice.error') && !${find('*', 'Failed to fetch')}`));
    for (let i = 0; i < 60 && sent.length < before + 3; i++) await sleep(100);
    await expect('it sends again until the new server takes it', sent.length === before + 3 && sent.slice(before).every((m) => m.chatId === chat.id && m.text === 'Plan approved. Build it.'));
    await expect('shown once in the chat while it waits', await val(`[...document.querySelectorAll('.msg.user')].filter((e) => e.textContent.includes('Plan approved. Build it.')).length === 1`));
    await shot('updating');
    release();
    await expect('and the answer finishes', await waitFor(`!document.querySelector('.composer-box .round.stop')`));
  },

  // Rejoin a running answer: open a chat Pip is still answering (after leaving it, or a hard reload) and the answer so
  // far comes back with its steps and the build timeline, then finishes into the saved answer, once, with no repeats.
  async rejoin() {
    await api('/setup/done', {});
    const other = await api('/chats', { mode: 'explore' });
    await api(`/chats/${other.id}`, { title: 'Somewhere else' }, 'PATCH');
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Rejoin check' }, 'PATCH');
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const add = (role, blocks) => db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, role, JSON.stringify(blocks), Date.now());
    add('user', [{ type: 'text', text: 'Plan approved. Build it.' }]);
    await cdp('Fetch.enable', { patterns: [...PATTERNS, { urlPattern: '*/api/chats/*/live', requestStage: 'Request' }, { urlPattern: `*/api/chats/${chat.id}`, requestStage: 'Response' }] });
    fakeRunning = chat.id;
    liveEvents = [{ t: 'text', d: 'Reading the SDK docs. ' }, { t: 'tool_start', id: 'w1', name: 'mcp__build__write_app_file', input: { path: 'src/fluent/loan.now.ts' } }, { t: 'text', d: 'Writing the script include.' }];
    const stillLive = async () => { for (let i = 0; i < 50 && !heldLive.length; i++) await sleep(100); return heldLive.length > 0; };
    const showsSoFar = `!!${find('.msg.assistant', 'Writing the script include.')} && !${find('.muted', 'Still answering in the background')}`;
    try {
      await open();
      await openChat('Rejoin check');
      await expect('opening a chat mid-answer joins it live', await stillLive());
      heldLive.length = 0;   // leaving the chat drops its stream
      await openChat('Somewhere else');
      await openChat('Rejoin check');
      await expect('coming back joins again', await stillLive());
      heldLive.length = 0;
      await open();   // a hard reload
      await openChat('Rejoin check');
      await expect('so does a hard reload', await stillLive());
      // Replay of everything so far, then the end: the answer is saved and the live view gives way to it.
      add('assistant', [{ type: 'text', text: 'Reading the SDK docs. ' }, { type: 'tool', id: 'w1', name: 'mcp__build__write_app_file', input: { path: 'src/fluent/loan.now.ts' }, status: 'done', result: '{"ok":true}', ms: 40 }, { type: 'text', text: 'Writing the script include. Done.' }]);
      db.close();
      const live = heldLive.shift();
      await fulfillLive(live, liveEvents);   // the answer so far (the stream ends here; the page then loads the saved one)
      fakeRunning = null;
      await expect('the saved answer replaces the live one', await waitFor(`!!${find('.msg.assistant', 'Writing the script include. Done.')}`));
      await expect('with nothing shown twice', await val(`[...document.querySelectorAll('.msg.assistant')].filter((e) => e.textContent.includes('Reading the SDK docs.')).length === 1`));
      await expect('and the build timeline picked it up', await waitFor(`!!document.querySelector('.work .build-timeline')`));
      await shot('rejoin');

      // When joining doesn't work (the stream fails, or ends empty while the chat still says it's answering), the
      // page says it's still answering, polls, and shows the saved answer once it's there.
      for (const kind of ['error', 'empty']) {
        const c2 = await api('/chats', { mode: 'build' });
        await api(`/chats/${c2.id}`, { title: `Fallback ${kind}` }, 'PATCH');
        fakeRunning = c2.id; liveReply = kind;
        await cdp('Fetch.enable', { patterns: [...PATTERNS, { urlPattern: '*/api/chats/*/live', requestStage: 'Request' }, { urlPattern: `*/api/chats/${c2.id}`, requestStage: 'Response' }] });
        await open();
        await openChat(`Fallback ${kind}`);
        await expect(`a ${kind} join falls back to "still answering"`, await waitFor(`!!${find('.muted', 'Still answering in the background')}`));
        const db2 = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
        db2.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), c2.id, 'assistant', JSON.stringify([{ type: 'text', text: `Saved after a ${kind} join.` }]), Date.now());
        db2.close();
        fakeRunning = null;
        await expect('and polls until the saved answer shows', await waitFor(`!!${find('.msg.assistant', `Saved after a ${kind} join.`)} && !${find('.muted', 'Still answering in the background')}`, 8000));
      }
    } finally {
      fakeRunning = null; heldLive.length = 0; liveReply = null;
      await cdp('Fetch.enable', { patterns: PATTERNS });
    }
  },

  // The update-set note's card: which set, and the exact text that gets appended (shown again when folded and opened).
  async setnote() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Note check' }, 'PATCH');
    const note = '[Wayfinder 2026-10-10]\nWhat changed:\n- Business rule Set loan due date on x_acme_loan_request\nWhy: Loans need a due date.\nRisk: Low: new rule only.';
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify([
      { type: 'text', text: 'The rule is in. Want a note of it in the update set?' },
      { type: 'approval', id: randomUUID(), tool: 'mcp__pdi__note_update_set', input: { kind: 'update-set-note', update_set: 'Loans: due dates', note }, decision: 'allow' },
    ]), Date.now());
    db.close();
    await open();
    await openChat('Note check');
    await expect('the card names the set', await waitFor(`!!${find('.approval .tool-name', 'Note in update set · Loans: due dates')}`));
    await click('.approval-line');
    await expect('and shows the exact text, line by line', await waitFor(`document.querySelector('.approval .note-text')?.textContent === ${q(note.replace(/\\n/g, '\n'))}`));
    await expect('and says nothing is replaced', await val(`!!${find('.approval-record', 'nothing there is replaced')}`));
    await shot('setnote');
  },
  // Build timeline: the steps standing up in the work area beside a Build chat. It opens by itself on Pip's first build
  // step, the plan included (once per chat; closing it keeps it closed); while it's closed a chip in the chat header
  // says where the build is and opens it again; nothing sits above the chat on a wide screen. It ends in the test score,
  // it only claims the sandbox when the build ran in one, and phones keep just the strip.
  async timeline() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Timeline check' }, 'PATCH');
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const add = (role, blocks, at = Date.now()) => db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, role, JSON.stringify(blocks), at);
    const t = (id, name, result, status = 'done') => ({ type: 'tool', id, name: `mcp__build__${name}`, input: {}, status, result: JSON.stringify(result), ms: 100 });
    add('user', [{ type: 'text', text: 'Build a loaner tracker' }], Date.now() - 60_000);
    add('assistant', [t('p1', 'propose_app', { app_id: 'a1' }), { type: 'text', text: 'Here is the plan.' }], Date.now() - 50_000);
    await open();
    await openChat('Timeline check');
    await expect('a Build chat shows the chip in its header', await waitFor(`document.querySelector('.chat-head .build-chip')?.textContent === 'Build · 1 of 5 ›'`));
    await expect('and no strip above the chat on a wide screen', !(await val(`!!document.querySelector('.build-steps')`)));
    await expect('an old chat does not open the timeline by itself', !(await val(`!!document.querySelector('.build-timeline')`)));
    await shot('chip');

    // The plan: propose_app is done before the screen can catch it running, and it still opens the timeline.
    answerEvents = [{ t: 'tool_start', id: 'p2', name: 'mcp__build__propose_app', input: {} }, { t: 'tool_result', id: 'p2', status: 'done', result: JSON.stringify({ app_id: 'a1' }), ms: 5 }, { t: 'text', d: 'Here is the new plan.' }];
    await click('.composer-box textarea');
    await type('Change the plan: add reminders.');
    await key('Enter');
    await expect('Pip\'s plan opens the timeline', await waitFor(`!!document.querySelector('.work .build-timeline') && document.querySelector('.work-tabs button.on')?.textContent === 'Build'`));
    await expect('with every step, in plain words', await waitFor(`[...document.querySelectorAll('.bt-step strong')].map((e) => e.textContent).join('|') === 'Plan|Write the app|Build|Install|Run tests'`));
    await expect('and nothing above the chat while it is open', !(await val(`!!document.querySelector('.build-steps, .build-chip')`)));
    await waitFor(`!document.querySelector('.composer-box .round.stop')`);
    await click('.build-timeline .icon-btn');
    await expect('closing it brings the chip back', await waitFor(`!document.querySelector('.work') && !!document.querySelector('.chat-head .build-chip') && !document.querySelector('.build-steps')`));
    answerEvents = [{ t: 'tool_start', id: 'w1', name: 'mcp__build__write_app_file', input: { path: 'src/fluent/index.now.ts' } }];
    await click('.composer-box textarea');
    await type('Keep going');
    await key('Enter');
    await waitFor(`!document.querySelector('.composer-box .round.stop')`);
    await sleep(300);
    await expect('once closed, it stays closed in this chat', !(await val(`!!document.querySelector('.work')`)));
    answerEvents = null;

    // The rest of the build happened: written, built in the sandbox, installed, tests finished with one failure.
    add('assistant', [t('w2', 'write_app_file', { ok: true }), t('b1', 'build_app', { ok: true, seconds: 12, sandboxed: true }), t('i1', 'install_app', { started: true })], Date.now() - 20_000);
    add('assistant', [{ type: 'notice', level: 'info', text: 'Loaner is installed on the PDI.' }], Date.now() - 15_000);
    add('assistant', [t('r1', 'run_app_tests', { started: true })], Date.now() - 10_000);
    add('assistant', [{ type: 'notice', level: 'error', text: 'Loaner tests finished after 2 min. 4 passed, 1 failed.', card: { kind: 'atf', ok: false, title: 'Loaner tests: 1 failed', stats: [{ label: 'Passed', value: 4, tone: 'good' }, { label: 'Failed', value: 1, tone: 'bad' }] } }], Date.now() - 5_000);
    db.close();
    await open();
    await openChat('Timeline check');
    await expect('the chip says where it stopped', await waitFor(`document.querySelector('.build-chip.st-error')?.textContent === 'Build · 5 of 5 ›'`));
    await click('.build-chip');
    await expect('the chip opens the timeline', await waitFor(`!!document.querySelector('.work .build-timeline')`));
    const steps = `[...document.querySelectorAll('.bt-step')].map((e) => e.className.replace('bt-step ', '') + ':' + e.querySelector('strong').textContent + ':' + e.querySelector('.bt-detail').textContent).join('|')`;
    await expect('each step shows what happened', await waitFor(`${steps} === 'st-done:Plan approved:by you|st-done:Write the app:ServiceNow SDK|st-done:Build in a sandbox:no keys, no network|st-done:Install:on your instance|st-error:Run tests:4 of 5 tests passed'`));
    await expect('and it ends in the test score', await val(`document.querySelector('.bt-score.bad')?.textContent === '4 of 5 tests passed'`));
    await shot('timeline');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await expect('Reduce Motion stills it', await waitFor(`getComputedStyle(document.querySelector('.bt-step')).animationName === 'none'`));
    await cdp('Emulation.setEmulatedMedia', { features: [] });

    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await open();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    await click('.menu-btn');
    await click('.chat-link', 'Timeline check');
    await waitFor(`document.querySelector('.chat-head h2')?.textContent === 'Timeline check'`);
    await expect('a phone keeps just the strip, not a button', await waitFor(`!!document.querySelector('div.build-steps') && !document.querySelector('.work')`));
    await expect('and nothing spills sideways', await val(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('timeline-phone');
    await desktop();
  },
  // The board comes to you: in Debug, Pip's first pinned clue opens it (once per chat; closing it keeps it closed). New
  // clues grow in, status shows as a chip, a clue's controls only appear when you open it, ruled-out clues stay in
  // place struck through and the older ones fold past five, and the header counts the clues.
  async boardcomes() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'debug' });
    await api(`/chats/${chat.id}`, { title: 'Board comes check' }, 'PATCH');
    const pin = (title, status = 'open', kind = 'hypothesis') => api('/board', { chat_id: chat.id, kind, title, status });
    for (let i = 1; i <= 7; i++) { await pin(`Ruled out guess ${i}`, 'ruled_out'); await sleep(5); }
    await pin('The 2 a.m. job holds a lock', 'tested');
    await pin('Mail server rejects after 500 sends', 'confirmed', 'error');
    await open();
    await openChat('Board comes check');
    await expect('the board stays closed until Pip pins something', !(await val(`!!document.querySelector('.work')`)));

    answerEvents = [
      { t: 'tool_start', id: 'bp1', name: 'mcp__project__board_pin', input: { kind: 'log', title: 'Queue stalls at 02:00' } },
      { t: 'tool_result', id: 'bp1', status: 'done', result: '{"pinned":true}', ms: 40 },
    ];
    await click('.composer-box textarea');
    await type('Emails stop every night');
    await key('Enter');
    await expect('Pip pinning a clue opens the board', await waitFor(`!!document.querySelector('.work .board') && document.querySelector('.work-tabs button.on')?.textContent === 'Board'`));
    await waitFor(`!document.querySelector('.composer-box .round.stop')`);
    await expect('the header counts the clues', await waitFor(`(document.querySelector('.board .preview-head .ver')?.textContent ?? '').endsWith('· 9 clues')`));
    await pin('Queue stalls at 02:00', 'open', 'log');
    await expect('a new clue grows in', await waitFor(`!!${find('.board .clue.clue-new', 'Queue stalls at 02:00')}`));
    await expect('status shows as a chip', await val(`${find('.board .clue', 'holds a lock')}?.querySelector('.status-chip.sc-tested')?.textContent === 'Testing' && ${find('.board .clue', 'Mail server')}?.querySelector('.status-chip')?.textContent === 'Confirmed'`));
    await expect('controls stay hidden until a clue is opened', !(await val(`!!document.querySelector('.board .clue select, .board .clue textarea')`)));
    await click('.board .clue-head', 'holds a lock');
    await expect('opening a clue shows its status, detail and Remove', await waitFor(`(()=>{const c=${find('.board .clue.open', 'holds a lock')}; return !!c && !!c.querySelector('select[aria-label=Status]') && !!c.querySelector('textarea[aria-label=Detail]') && [...c.querySelectorAll('button')].some((b) => b.textContent === 'Remove');})()`));
    await expect('ruled-out clues stay, struck through', await val(`getComputedStyle(${find('.board .clue-title', 'Ruled out guess 7')}).textDecorationLine === 'line-through'`));
    await expect('the older ruled-out ones fold past five', await val(`document.querySelectorAll('.board .clue.st-c-ruled_out').length === 5 && !${find('.board .clue', 'Ruled out guess 1')} && !!${find('.board button', 'Show 2 older ruled out')}`));
    await shot('boardcomes');
    await click('.board button', 'Show 2 older ruled out');
    await expect('and come back when asked', await waitFor(`document.querySelectorAll('.board .clue.st-c-ruled_out').length === 7`));
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await expect('Reduce Motion stills new clues', await waitFor(`getComputedStyle(document.querySelector('.board .clue.clue-new')).animationName === 'none'`));
    await cdp('Emulation.setEmulatedMedia', { features: [] });

    await click('.board .icon-btn');
    await click('.composer-box textarea');
    await type('Check the queue again');
    await key('Enter');
    await waitFor(`!document.querySelector('.composer-box .round.stop')`);
    await sleep(300);
    await expect('once closed, it stays closed in this chat', !(await val(`!!document.querySelector('.work')`)));
    answerEvents = null;
  },

  // The ServiceNow docs: Settings → Pip downloads and indexes them on this machine, with live progress, and then
  // answers can cite them (the docs release picker and setup both see them).
  async docs() {
    await open();
    await click('.rail-btn', 'Settings');
    await click('.set-nav-item', 'Pip');
    const card = `[...document.querySelectorAll('.set-card')].find((c) => c.querySelector('h3')?.textContent === 'ServiceNow docs')`;
    await expect('Settings offers to download the docs', await waitFor(`!!(${card})?.textContent.includes('Download ServiceNow docs (~1.5 GB)')`));
    await expect('and says where they come from', await val(`(${card}).textContent.includes('ServiceNowDocs (Apache-2.0)')`));
    await shot('docs-before');
    await val(`[...(${card}).querySelectorAll('button')].find((b) => b.textContent.includes('Download'))?.click()`);
    await expect('the download finishes and says so', await waitFor(`(${card})?.textContent.includes('Ready. Pip cites the Brazil docs')`, 30_000));
    await expect('the card shows what is on this machine', await waitFor(`(${card})?.textContent.includes('Brazil docs on this machine: 1 pages')`));
    await expect('it now offers updates instead', await val(`!!${find('.set-card button', 'Check for updates')}`));
    await expect('and says the docs keep themselves current from now on', await val(`(${card}).textContent.includes('Kept current by itself')`));
    await expect('the header picks up the docs release without a reload', await waitFor(`[...document.querySelectorAll('.head-k')].some((k) => k.textContent === 'Docs' && k.parentElement.textContent.includes('Brazil'))`));
    await shot('docs-after');
    // Only the app itself can start a download: a plain-text post, another site, or no login are all refused.
    const post = (headers) => fetch(`${base}/api/docs/local`, { method: 'POST', headers, body: '{"update":true}' }).then((r) => r.status);
    await expect('a text/plain post (what a cross-site form sends) is refused', await post({ Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', Origin: base }) === 415);
    await expect('a post from another site is refused', await post({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }) === 403);
    await expect('a post without the login is refused', await post({ 'Content-Type': 'application/json', Origin: base }) === 401);
    await expect('and none of them started anything', (await api('/docs/local')).job?.state === 'done');
    const rel = await api('/docs/releases');
    await expect('answers can cite them (the release picker sees them)', rel.available.length === 1 && rel.available[0] === 'brazil');
    await expect('setup counts them as cited docs', (await api('/setup')).extras.docsSource === 'local');
  },
  // Previews: a mockup is laid out at its device size whatever the panel width; resizing changes the scale, not the
  // layout. Device, 100% and full screen work, revisions don't leak blob URLs, and the preview can't reach the network.
  async preview() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'mockup' });
    await api(`/chats/${chat.id}`, { title: 'Preview check' }, 'PATCH');
    const c = `http://127.0.0.1:${fakePort}/canary`;
    // Wide layout at 1000px and up; every way a page could reach the network points at the canary.
    const fixture = (n) => `<!doctype html><html><head><title>Fixture ${n}</title><link rel="stylesheet" href="${c}/css"><style>@import url("${c}/import");
      body{margin:0;font:16px system-ui} .wide,.narrow{padding:24px;font-size:48px;color:#fff} .wide{background:#1f6feb;display:none} .narrow{background:#d1242f}
      @media (min-width:1000px){.wide{display:block}.narrow{display:none}} .bg{height:40px;background:url("${c}/bg")} .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:24px}
      .grid div{height:120px;background:#eee}</style><script src="${c}/script"></script></head>
      <body><div class="wide">WIDE layout · revision ${n}</div><div class="narrow">NARROW layout · revision ${n}</div><div class="bg"></div>
      <img src="${c}/img" alt=""><div class="grid"><div></div><div></div><div></div><div></div><div></div><div></div></div>
      <script>fetch("${c}/fetch").catch(()=>{}); new Image().src="${c}/js-img";</script></body></html>`;
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const addMsg = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
    for (let n = 1; n <= 4; n++) addMsg.run(randomUUID(), chat.id, 'assistant', JSON.stringify([{ type: 'text', text: 'Here it is.\n\n```html\n' + fixture(n) + '\n```' }]), Date.now() + n);
    db.close();
    // Count blob URLs the page makes and frees, so revisions can be checked for leaks.
    await cdp('Log.enable');
    await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__blobs={made:0,freed:0};const c=URL.createObjectURL.bind(URL),r=URL.revokeObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.made++;return c(b)};URL.revokeObjectURL=(u)=>{window.__blobs.freed++;return r(u)};` });
    await open();
    await openChat('Preview check');
    await waitFor(`document.querySelectorAll('.rb-html iframe').length === 4`, 8000);
    await sleep(800);
    await shot('inline');
    const frameW = (sel) => `document.querySelector(${q(sel)})?.offsetWidth`;
    await expect('inline: the mockup is laid out at desktop width', (await val(frameW('.rb-html iframe'))) === 1440);
    await click('.rb-html .link', 'Expand');
    await waitFor(`!!document.querySelector('.preview iframe')`);
    await sleep(800);
    await shot('panel-desktop');
    const panelW = await val(`document.querySelector('.preview').clientWidth`);
    await expect(`panel: desktop stays 1440 wide in a ${panelW}px panel`, panelW < 1440 && (await val(frameW('.preview iframe'))) === 1440);
    await expect('panel: the real size is shown', await val(`document.querySelector('.preview .pf-dims')?.textContent.startsWith('1440 × 900')`));
    const scaleBefore = await val(`document.querySelector('.preview .pf-dims').textContent`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    await expect('resizing the window changes the scale', (await val(`document.querySelector('.preview .pf-dims').textContent`)) !== scaleBefore);
    await expect('… but not the layout width', (await val(frameW('.preview iframe'))) === 1440);
    await desktop(); await sleep(400);
    await click('.preview .seg button', 'Tablet');
    await expect('tablet is 820 × 1180', (await val(frameW('.preview iframe'))) === 820 && await val(`document.querySelector('.preview .pf-dims').textContent.startsWith('820 × 1180')`));
    await click('.preview .seg button', 'Phone');
    await sleep(400);
    await shot('panel-phone');
    await expect('phone is 390 × 844', (await val(frameW('.preview iframe'))) === 390);
    await click('.preview .seg button', 'Desktop');
    await click('.preview .seg button', '100%');
    await sleep(300);
    await expect('100% shows full size and scrolls', await val(`(()=>{const s=document.querySelector('.preview .pf-stage'); return s.classList.contains('pf-100') && s.scrollWidth > s.clientWidth && document.querySelector('.preview .pf-dims').textContent.endsWith('100%');})()`));
    await click('.preview .seg button', 'Fit');
    await click('.preview-actions .link', 'Full screen');
    await sleep(500);
    await shot('fullscreen');
    await expect('full screen fills the window at desktop size', await val(`(()=>{const f=document.querySelector('.pf-full'); return !!f && f.offsetWidth === innerWidth && f.querySelector('iframe').offsetWidth === 1440;})()`));
    await key('Escape');
    await expect('Esc closes full screen', await waitFor(`!document.querySelector('.pf-full')`));
    // Revisions: open each version in the panel in turn; only the frames on screen hold a blob URL.
    for (let i = 1; i <= 4; i++) {
      await val(`[...document.querySelectorAll('.rb-html')][${i - 1}].scrollIntoView({block:'center'})`);
      await val(`[...document.querySelectorAll('.rb-html .code-actions')].at(${i - 1}).querySelector('.link:nth-child(2)').click()`);
      await sleep(250);
    }
    await sleep(500);
    const blobs = await val(`({live: window.__blobs.made - window.__blobs.freed, frames: document.querySelectorAll('iframe').length})`);
    await expect(`revisions free their blob URLs (${blobs.live} live for ${blobs.frames} frames)`, blobs.live === blobs.frames);
    await sleep(1000);
    await expect(`the preview never reached the network${canaryHits.length ? ` (hit: ${[...new Set(canaryHits)].join(', ')})` : ''}`, canaryHits.length === 0);
    if (process.env.UI_LOG) console.log(browserLog.filter((t) => /Content Security Policy/.test(t)).slice(0, 8).join('\n'));
    await expect('the browser refused loads under the preview\'s own policy', browserLog.some((t) => t.includes("img-src data: blob:")) && browserLog.some((t) => t.includes("connect-src 'none'") || t.includes('style-src')));
    // Positive control: the same page opened directly, with no preview policy, does reach the canary. Without this,
    // "no hits" could just mean the fixture never asks.
    controlPage = fixture(9);
    await cdp('Page.navigate', { url: `http://127.0.0.1:${fakePort}/control` });
    await sleep(1500);
    await expect(`control: outside the preview the same page reaches the network (${new Set(canaryHits).size} kinds of request)`, canaryHits.length > 0);
  },
  // The screen kit: a ```screen block in a chat is drawn at the spec's viewport, a bad spec shows its problems, and the
  // drawn page holds up at every device size: no sideways overflow, no clipped fields or off-screen buttons, readable
  // text, labelled controls, and the loading/empty/error states.
  async screenkit() {
    const { renderScreen, parseScreen } = await import('../../src/web/screen.ts');
    const fixture = readFileSync('tests/fixtures/screen-loaners.json', 'utf8');
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'mockup' });
    await api(`/chats/${chat.id}`, { title: 'Screen kit check' }, 'PATCH');
    const bad = JSON.stringify({ ...JSON.parse(fixture), surface: 'portal' });
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    const add = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
    add.run(randomUUID(), chat.id, 'assistant', JSON.stringify([{ type: 'text', text: 'Here it is.\n\n```screen\n' + fixture + '\n```' }]), Date.now());
    add.run(randomUUID(), chat.id, 'assistant', JSON.stringify([{ type: 'text', text: '```screen\n' + bad + '\n```' }]), Date.now() + 1);
    db.close();
    await open();
    await openChat('Screen kit check');
    await expect('a screen block is drawn at its desktop viewport', await waitFor(`document.querySelector('.rb-html iframe')?.offsetWidth === 1440`, 8000));
    await expect('its spec is a tab away', await val(`[...document.querySelectorAll('.rb-html .seg button')].some((b) => b.textContent === 'Spec')`));
    await expect('a spec the kit can\'t draw says exactly why', await waitFor(`(document.querySelector('.screen-bad')?.textContent ?? '').includes('surface:')`));
    await shot('chat');

    const spec = parseScreen(fixture).spec;
    const variants = [['ready', spec],
      ['loading', { ...spec, list: { ...spec.list, state: 'loading' }, record: { ...spec.record, state: 'loading' } }],
      ['empty', { ...spec, list: { ...spec.list, state: 'empty', empty_text: 'Nothing due today.' } }],
      ['error', { ...spec, record: { ...spec.record, state: 'error', error_text: 'Could not load the loan.' } }],
      ['dark compact', { ...spec, theme: 'dark', density: 'compact' }]];
    const sizes = [['desktop', 1440, 900], ['tablet', 820, 1180], ['phone', 390, 844]];
    // Contrast of an element's text against the nearest background (WCAG relative luminance).
    const contrast = `((el) => { const rgb = (c) => (c.match(/[\\d.]+/g) || []).map(Number); const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      let bg = el; while (bg && rgb(getComputedStyle(bg).backgroundColor)[3] === 0) bg = bg.parentElement; const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(getComputedStyle(bg || document.body).backgroundColor)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); })`;
    const layoutCheck = (c) => `(() => {
          const out = [];
          if (document.documentElement.scrollWidth > innerWidth + 1) out.push('page scrolls sideways (' + document.documentElement.scrollWidth + 'px)');
          for (const v of document.querySelectorAll('.f .v')) if (v.scrollWidth > v.clientWidth + 1) out.push('clipped field ' + v.parentElement.dataset.id);
          for (const b of document.querySelectorAll('button')) { const x = b.getBoundingClientRect(); if (!b.textContent.trim()) out.push('button with no label'); if (x.right > innerWidth + 1) out.push('button off screen: ' + b.textContent); }
          if (!document.documentElement.lang) out.push('no lang'); if (!document.title.trim()) out.push('no title');
          const c = ${c};
          for (const sel of ['.f label', 'td', 'nav a', '.ph h1', '.note', '.st']) { const el = document.querySelector(sel); if (el && el.offsetParent !== null && c(el) < 4.5) out.push('low contrast: ' + sel + ' ' + c(el).toFixed(2)); }
          return out;
        })()`;
    // Negative control: a deliberately broken page must fail every kind of check, or the checks prove nothing.
    controlPage = '<!doctype html><html><head></head><body style="background:#fff"><div class="f" data-id="x"><div class="v" style="width:80px;white-space:nowrap;overflow:hidden">' + 'W'.repeat(60) + '</div></div><button style="margin-left:2000px"></button><nav><a style="color:#ccc">faint</a></nav></body></html>';
    await desktop(); await cdp('Page.navigate', { url: `http://127.0.0.1:${fakePort}/control` }); await sleep(300);
    const caught = await val(layoutCheck(contrast));
    await expect(`control: the checks catch a broken page (${caught.length} problems)`, ['sideways', 'clipped field', 'no label', 'off screen', 'no lang', 'no title', 'low contrast'].every((k) => caught.some((p) => p.includes(k))));
    for (const [vname, s] of variants) {
      controlPage = renderScreen(s);
      for (const [dname, w, h] of sizes) {
        await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: dname === 'phone' });
        await cdp('Page.navigate', { url: `http://127.0.0.1:${fakePort}/control` });
        await waitFor(`!!document.querySelector('.ws')`);
        const r = await val(layoutCheck(contrast));
        await expect(`${vname} at ${dname} ${w}×${h}: ${r.length ? r.slice(0, 4).join('; ') : 'holds up'}`, r.length === 0);
      }
    }
    for (const [state, text] of [['loading', 'Loading…'], ['empty', 'Nothing due today.'], ['error', 'Could not load the loan.']]) {
      controlPage = renderScreen(variants.find(([n]) => n === state)[1]);
      await cdp('Page.navigate', { url: `http://127.0.0.1:${fakePort}/control` });
      await expect(`the ${state} state shows`, await waitFor(`(document.querySelector('.st')?.textContent ?? '').includes(${q(text)})`));
    }
    controlPage = renderScreen(spec);
    await desktop(); await cdp('Page.navigate', { url: `http://127.0.0.1:${fakePort}/control` }); await sleep(300); await shot('desktop');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await cdp('Page.navigate', { url: `http://127.0.0.1:${fakePort}/control` }); await sleep(300); await shot('phone');
    await desktop();
  },

  // Opening a ServiceNow page: Pip's open_page opens it in a new tab once, as the answer arrives, and leaves a link card
  // (no referrer). Reloading the chat doesn't open it again.
  async openpage() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'explore' });
    await api(`/chats/${chat.id}`, { title: 'Open page check' }, 'PATCH');
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__opened=[];window.open=(u,t,f)=>{window.__opened.push([u,t,f]);return null};` });
    await open();
    await openChat('Open page check');
    const url = 'https://dev12345.service-now.com/incident.do?sys_id=abc';
    answerEvents = [
      { t: 'tool_start', id: 'op1', name: 'mcp__pdi__open_page', input: { page: 'incident.do?sys_id=abc', label: 'INC0010009' } },
      { t: 'tool_result', id: 'op1', status: 'done', result: JSON.stringify({ open: url, label: 'INC0010009' }), ms: 3 },
      { t: 'text', d: 'Opened it for you.' },
    ];
    await click('.composer-box textarea');
    await type('open INC0010009');
    await key('Enter');
    await expect('the page opens in a new tab once', await waitFor(`window.__opened.length === 1 && window.__opened[0][0] === ${q(url)} && window.__opened[0][1] === '_blank' && /noopener/.test(window.__opened[0][2]) && /noreferrer/.test(window.__opened[0][2])`));
    answerEvents = null;
    await waitFor(`!document.querySelector('.composer-box .round.stop')`);
    // Sends in these flows are answered in the browser, so the saved answer goes into the database here.
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify([
      { type: 'tool', id: 'op1', name: 'mcp__pdi__open_page', input: { page: 'incident.do?sys_id=abc' }, status: 'done', result: JSON.stringify({ open: url, label: 'INC0010009' }), parent: null },
      { type: 'text', text: 'Opened it for you.' }]), Date.now());
    db.close();
    await open();
    await openChat('Open page check');
    await expect('a link card stays, with no referrer', await waitFor(`(()=>{const a=document.querySelector('.open-page a'); return !!a && a.href === ${q(url)} && a.target === '_blank' && a.rel.includes('noreferrer') && a.textContent.includes('INC0010009');})()`));
    await sleep(300);
    await expect('reloading the chat does not open it again', (await val(`window.__opened.length`)) === 0);
  },

  // Approve plan is recorded on the server: clicking it on the plan card marks exactly that plan approved, which the
  // build tools wait for.
  async scriptrunner() {
    await api('/setup/done', {});
    await api('/settings', { writeEnabled: true, scriptingEnabled: true }, 'PUT');
    const connected = await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true });
    // Earlier flows can switch placement; restore what this flow inherited, not the fake's startup defaults.
    const placementBefore = JSON.stringify(runnerPrefs);
    await open(); await click('.rail-btn', 'Settings');
    await click('.script-runner-settings button', 'Set up script runner');
    await expect('preview shows exactly two records', await waitFor(`document.querySelectorAll('.script-runner-settings .approval li').length === 2`));
    await expect('the full operation script is visible before approval', await val(`document.querySelector('.script-runner-settings .approval').textContent.includes('GlideEvaluator.evaluateString') && document.querySelector('.script-runner-settings .approval').textContent.includes('})(request, response);')`));
    await expect('preview makes no instance writes', runnerWrites.length === 0);
    await click('.script-runner-settings .approval button', 'Cancel');
    await expect('cancel makes no instance writes', runnerWrites.length === 0);
    await click('.script-runner-settings button', 'Set up script runner');
    await waitFor(`!!document.querySelector('.script-runner-settings .approval')`);
    await click('.script-runner-settings .approval button', 'Approve');
    await expect('approval installs the runner and shows ready', await waitFor(`document.querySelector('.script-runner-settings')?.textContent.includes('Script runner: ready')`));
    await expect('setup restored the account placement', JSON.stringify(runnerPrefs) === placementBefore);
    await expect('exactly two records were created', runnerWrites.length === 2 && runnerWrites.every((w) => w.method === 'POST'));
    const inst = (await api('/instances')).find((i) => i.id === connected.instance.id);
    await expect('the endpoint uses the namespace returned by the instance', inst.script_runner_path === '/api/test_namespace/wayfinder_script_runner/run');
    await click('.script-runner-settings button', 'Remove script runner');
    await expect('removal shows the two stored IDs', await waitFor(`document.querySelectorAll('.script-runner-settings .approval li').length === 2`));
    await expect('preview did not delete anything', runnerWrites.length === 2);
    await click('.script-runner-settings .approval button', 'Approve');
    await expect('approval removes the runner', await waitFor(`document.querySelector('.script-runner-settings')?.textContent.includes('not set up')`));
    await expect('deletes only the two runner records', runnerWrites.length === 4 && runnerWrites.slice(2).every((w) => w.method === 'DELETE'));
    await expect('the account placement was restored', JSON.stringify(runnerPrefs) === placementBefore);
    await expect('no ACL was created', runnerWrites.every((w) => w.table !== 'sys_security_acl'));
    await expect('the stored path and IDs are cleared', (await api('/instances')).find((i) => i.id === inst.id).script_runner_records === null);
  },

  async plangate() {
    await api('/setup/done', {});
    const chat = await api('/chats', { mode: 'build' });
    await api(`/chats/${chat.id}`, { title: 'Plan gate check' }, 'PATCH');
    const spec = { name: 'Loaner Laptops', scope: 'x_12345_loaner', summary: 'Track loaner laptops', tables: [{ name: 'x_12345_loaner_device', label: 'Device', fields: [] }], roles: [], flows: [], sample_data: [], tests: [] };
    const appId = randomUUID();
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    db.prepare("INSERT INTO apps (id, project_id, chat_id, instance_id, name, scope, scope_id, spec, status, last_output, created_at, updated_at) VALUES (?, NULL, ?, NULL, ?, ?, NULL, ?, 'draft', NULL, ?, ?)").run(appId, chat.id, spec.name, spec.scope, JSON.stringify(spec), Date.now(), Date.now());
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), chat.id, 'assistant', JSON.stringify([
      { type: 'tool', id: 'pp1', name: 'mcp__build__propose_app', input: { spec }, status: 'done', result: JSON.stringify({ app_id: appId }), parent: null },
      { type: 'text', text: 'Here is the plan.' }]), Date.now());
    const approved = () => (db.prepare('SELECT plan_approved FROM apps WHERE id = ?').get(appId)).plan_approved;
    await open();
    await openChat('Plan gate check');
    await expect('the plan starts unapproved', !approved());
    await click('.spec-card .approval-actions .primary', 'Approve plan');
    await expect('clicking Approve plan records it on the server', await waitUntil(async () => !!approved()));
    await expect('and says it in the chat', sent.some((m) => m.chatId === chat.id && m.text === 'Plan approved. Build it.'));
    db.close();
  },

  // Launch screenshots: saved demo answers, real cards and panels, no model or live instance calls.
  async readme() {
    if (!process.env.UI_README) return;
    mkdirSync(process.env.UI_README, { recursive: true });
    readmeDemo = true;
    asleep = false;
    const db = new DatabaseSync(join(scratch, 'data', 'workbench.db'));
    try {
      // This flow runs last: remove earlier flows' fixtures from this throwaway database only.
      for (const table of ['messages', 'chats', 'projects', 'board_items', 'artifacts', 'apps', 'memories', 'jobs', 'audit', 'perf', 'routines', 'instances']) db.exec(`DELETE FROM ${table}`);
      for (const rows of Object.values(made)) rows.length = 0;
      await api('/setup/done', {});
      await api('/settings', { presence: 'still', writeEnabled: true, scriptingEnabled: false, dailyBudgetUsd: 0 }, 'PUT');
      const { instance: inst } = await api('/instances', { url: `http://127.0.0.1:${fakePort}`, auth: 'basic', username: 'admin', password: 'not-a-real-password', allow_non_pdi: true, name: 'dev12345' });
      db.prepare("UPDATE instances SET kind = 'pdi', full_permissions = 0 WHERE id = ?").run(inst.id);
      await api('/status/check', {});
      const loaners = await api('/projects', { name: 'Loaner laptops', brief: 'Track the loaner pool, due dates and reminders for the service desk.' });
      const onboarding = await api('/projects', { name: 'Onboarding portal', brief: 'Help new hires request their laptop and access in one place.' });
      const chat = async (title, mode, project) => {
        const c = await api('/chats', { mode, ...(project ? { project_id: project.id } : {}) });
        await api(`/chats/${c.id}`, { title }, 'PATCH');
        return { ...c, title };
      };
      const placement = await chat('Overdue loaner reminders', 'build', loaners);
      const debug = await chat('Why did the 2 a.m. job stop?', 'debug');
      const mockup = await chat('Mock up the loaner list', 'mockup', loaners);
      const catalog = await chat('Catalog item for new hires', 'explore', onboarding);
      const add = (c, role, blocks, offset = 0) => db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(randomUUID(), c.id, role, JSON.stringify(blocks), Date.now() - 60_000 + offset);
      const say = (c, role, text, offset = 0) => add(c, role, [{ type: 'text', text }], offset);
      const home = { place: 'owning-app', scope: 'x_acme_loan', name: 'Loaner' };
      const rec = { home, rule: 'other-apps-table', why: 'The loaner table belongs to this application, so its reminders belong here too.',
        warn: 'Working from another app would need cross-scope access.', alternatives: [{ place: 'new-app', scope: null, name: 'A new custom app' }, { place: 'global', scope: 'global', name: 'Global' }] };
      const card = { id: randomUUID(), work: 'Overdue loaner reminders', update_set: 'Loans: reminders', ...rec };
      db.prepare('UPDATE chats SET placement = ? WHERE id = ?').run(JSON.stringify({ status: 'pending', id: card.id, instance_id: inst.id, work: card.work, update_set: card.update_set, placement: rec, at: Date.now() }), placement.id);
      say(placement, 'user', 'Send a reminder when a loaner laptop is overdue. Keep it with the existing loaner app.');
      add(placement, 'assistant', [
        { type: 'tool', id: 'placement-demo', name: 'mcp__pdi__placement', input: { work: card.work }, status: 'done', result: JSON.stringify({ placement_card: card }), ms: 180 },
        { type: 'text', text: 'The loaner app already owns this table. Pick where the reminder should live and I will plan the change.' },
      ], 1000);
      say(debug, 'user', 'The loaner reminder job stopped at 2 a.m. What happened?');
      say(debug, 'assistant', 'The job started on time, but stopped when it tried to read the due date.\n\nThe log points to **`due` being undefined** in the loaner rule. I pinned the evidence on the board. Next I would compare that line with the last working version; nothing has been changed.', 1000);
      for (const clue of [
        { kind: 'log', title: 'Job started at 02:00, then stopped', status: 'confirmed', detail: 'The scheduler log records a normal start followed by a script error.' },
        { kind: 'error', title: '“due” is not defined · line 4', status: 'open', detail: 'The loaner rule reads a variable before assigning it.' },
        { kind: 'hypothesis', title: 'The schedule was disabled', status: 'ruled_out', detail: 'The job is active and its start appears in the log.' },
      ]) await api('/board', { chat_id: debug.id, ...clue });
      // Reuse the screen kit, replacing its stress-test copy and names with a small demo list.
      const screen = JSON.parse(readFileSync('tests/fixtures/screen-loaners.json', 'utf8'));
      screen.list.rows = [
        { number: 'LOAN0010042', device: 'Laptop 14-inch', borrower: 'alice', due: 'Today 17:00' },
        { number: 'LOAN0010043', device: 'Laptop 13-inch', borrower: 'bob', due: 'Today 17:00' },
      ];
      screen.nav.items[0].count = 2;
      screen.record.subtitle = 'Laptop 14-inch · alice';
      screen.record.tabs[0].sections[0].fields[0].value = 'alice';
      screen.record.tabs[1].activity[0].who = 'alice';
      say(mockup, 'user', 'Show me a loaner list with due dates and the selected loan beside it.');
      say(mockup, 'assistant', 'Here is a first pass: due dates in the list, with Return and Extend on the selected loan. This is a preview with made-up data.\n\n```screen\n' + JSON.stringify(screen) + '\n```', 1000);
      say(catalog, 'user', 'Can we use a catalog item for new hire laptops?');
      say(catalog, 'assistant', 'Start with a catalog item and a Flow Designer flow. Reuse the asset records already on the instance, then add approval and fulfilment tasks.', 1000);

      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await open();
      await val(`localStorage.setItem('snw-list', '1'); localStorage.setItem('snw-home-mode', 'auto')`);
      await open();
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
      if (!(await waitFor(`document.querySelectorAll('.project-row').length === 2`))) throw new Error('demo projects did not load');
      for (const p of [loaners, onboarding]) await val(`${find('.project-row', p.name)}.querySelector('.chev-btn').click()`);
      await click('.new-btn');
      const capture = async (name, ready) => {
        if (!(await waitFor(ready, 15_000))) throw new Error(`${name}: demo view did not become ready`);
        await val('document.fonts.ready');
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1430, y: 890 });
        await sleep(600);
        if (await val(`!!document.querySelector('.prod-chip') || document.body.innerText.includes('fake-build')`)) throw new Error(`${name}: test instance label is visible`);
        const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const png = Buffer.from(data, 'base64');
        if (png.readUInt32BE(16) !== 2880 || png.readUInt32BE(20) !== 1800) throw new Error(`${name}: expected a 2880×1800 PNG`);
        writeFileSync(join(process.env.UI_README, `${name}.png`), png);
        await expect(`${name}: captured at 1440×900 @2x`, true);
      };
      await capture('home', `!!document.querySelector('.insights .head-chip') && document.querySelector('.greet p')?.textContent.length > 5 && document.querySelector('.banner.ok')?.textContent.includes('dev12345')`);
      await click('.insights .head-chip');
      await capture('insights', `document.querySelectorAll('.ins-row').length >= 3`);
      await key('Escape');
      await openChat(placement.title);
      await capture('placement', `!!${find('.approval.placement.pending .approval-head', 'Where should this live?')}`);
      await openChat(debug.title);
      await click('.rail-btn', 'Board');
      await capture('debug-board', `document.querySelector('select[aria-label="Mode"]')?.value === 'debug' && document.querySelectorAll('.work .board .clue:not(.example)').length === 3`);
      await click('.board .icon-btn');
      await openChat(mockup.title);
      if (!(await waitFor(`!!document.querySelector('.rb-html iframe')`))) throw new Error('mockup: screen did not render');
      await click('.rb-html .link', 'Expand');
      await capture('mockup', `!!document.querySelector('.work .preview iframe')`);
      await click('.preview .icon-btn');
      await click('.rail-btn', 'Settings');
      await click('button', 'Connect an instance');
      await click('.connect-card input[placeholder^="https://dev"]'); await type('https://dev12345.service-now.com');
      await click('.connect-card .secret input'); await type('not-a-real-password');
      await cdp('Fetch.enable', { patterns: [...PATTERNS, { urlPattern: `${base}/api/instances/pdi-setup`, requestStage: 'Request' }] });
      await click('.connect-card button[type=submit]');
      if (!(await waitFor(`document.querySelectorAll('.setup-plan li').length === 6`, 10_000))) throw new Error('setup: plan did not load');
      await val(`document.querySelector('.setup-plan').scrollIntoView({block:'center'})`);
      await capture('setup', `!!${find('.setup-plan button', 'Set it up')}`);
      await expect('setup preview made no changes', Object.values(made).every((rows) => rows.length === 0));
    } finally {
      db.close(); readmeDemo = false;
      await cdp('Fetch.enable', { patterns: PATTERNS });
    }
  },
};

for (const name of wanted) {
  current = name;
  try { await flows[name](); } catch (e) { await expect(`ran to the end (${e.message})`, false); }
}
console.log(fails ? `${fails} failed (screenshots in ${outDir})` : `all passed (${wanted.join(', ')})`);
if (fails && process.env.UI_LOG) console.log(serverLog.slice(-3000));
cleanup();
fake.close();
await Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode ? null : new Promise((r) => { c.once('exit', r); setTimeout(r, 3000); }))));
if (!fails && !process.env.UI_OUT) try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS cleans temp */ }
process.exit(fails ? 1 : 0);
