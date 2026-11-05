# Agent guide

Conventions for AI agents (and people) changing this repo. What Wayfinder is, how to install it and the credits are in
[README.md](README.md); running and operating it is in [docs/RUNBOOK.md](docs/RUNBOOK.md); licenses are in
[LICENSE](LICENSE) and [NOTICE](NOTICE). Don't repeat those here; link to them.

## Stack
Node 22.13+ + Hono server (`src/server`), React 19 + Vite front end (`src/web`, built to `dist/web`), TypeScript, zod, ESM.
SQLite through `node:sqlite`. The brain is the Claude Agent SDK (`query()`), run with `settingSources: []` and
`strictMcpConfig: true`: built-in tools are only WebFetch, WebSearch, Agent and Skill; everything else is an MCP server.

## Server map (`src/server`)
- `main.ts`: routes and auth. Its first import is `nodeCheck.ts` (refuses Node < 22.13 with a plain message), and
  `db.ts` loads `node:sqlite` lazily so that check runs first. `config.ts`: paths and `envVar()` (`WAYFINDER_*`, old
  `SNW_*` as aliases). App token as cookie `snw_session` or Bearer. The status token reads only
  `GET /api/status`. Writes are JSON-only and same-origin. `/api/events` is the SSE bus.
- `agent.ts`: runChat. Builds the MCP servers per answer (docs, instance, pdi, project, build in Build mode),
  streams SSE events, records timings, learns 403 refusals into the access profile.
- `skills.ts` + `skills/<name>/SKILL.md`: Pip's know-how. A skill with `mode:` is that mode's rules, inlined in its
  prompt; the rest (e.g. `fluent`, which carries `fluent-cheatsheet.md`) load on demand through the Skill tool from a local
  plugin written to the data dir, with an explicit `skills` list (the CLI's own skills stay hidden). User overrides in
  `<config>/skills/`. Put new mode or domain guidance in a skill, not in prompts.ts.
- `placement.ts`: where work lives. `place(facts, rules)` is pure; the rules are the `placement` skill; the `pdi placement`
  tool shows the card and stops, the click (`POST /api/chats/:id/placement`) switches the update set and wakes Pip, and
  policy.ts refuses instance writes in a chat until it's settled. Scenarios: `tests/fixtures/placement-scenarios.json`.
- `memoryHub.ts`: the Memory page. One list of every rule Pip follows (memories, conventions, tool and Fluent lessons),
  pause (`rule_pauses` table), delete, review queue, conflict labels, word budget. Prompt builders read its `active*`
  lists, so a paused rule is out of every prompt; `guidedCount` is the "Guided by N rules" under each answer.
- `prompts.ts`: Pip's persona and the always-on rules, plus what gets injected: instance
  and access profile, project brief, saved items, memories, board, the OOB-first rule.
- `policy.ts`: **every tool call goes through `canUseTool` here.** Reads run; instance writes ask (approval cards,
  audited); WebFetch is allowlisted and public addresses only (checked after DNS); access-profile gating; install
  approvals bound to the build commit, change summary and risky-code scan; auto mode rules.
- `sn.ts` sign-in methods (client_credentials, basic, oauth_user with PKCE); `access.ts` access profile;
  `buildTools.ts` Build mode (Fluent apps in `apps/<scope>`, one git repo each, bubblewrap sandbox on Linux);
  `pdiTools.ts`, `insights.ts` (Insights: changes, new log errors) + `impact.ts` (what references a table, field, script include or ACL) + `ownership.ts` (which scope owns what), `features.ts`, `showme.ts`, `projectTools.ts` (saved items, memory gates, board), `jobs.ts`,
  `events.ts`, `voice.ts`, `monitor.ts`, `backup.ts`, `config.ts` (env and paths), `secrets.ts`, `token.ts`.
- `docsIndex.ts` (pure: parse, chunk, index a docs clone, search), `docsLocal.ts` (setup/update, the in-process `sndocs`
  tool), `docsDb.ts`, `docsCli.ts` (`wayfinder docs`), `docs.ts` (`docsSource()`: a docs server if its token file exists, else the local index).
- `db.ts`: all tables. New columns via `hasColumn` + `ALTER`; never drop or rewrite existing data.

## Packaging (`packaging/`)
`install.sh` (POSIX sh, arrives through `curl | sh`), `install.ps1` (Windows → WSL), `wayfinder` (the command; bash
3.2-safe for macOS), `pack.sh` (release files + SHA256SUMS + formula), `homebrew/wayfinder.rb.tmpl`, and
`test/linux-install.sh`. `CapitalX/wayfinder-app` is filled in by pack.sh from the repo that builds the release.
`.github/workflows/release.yml` publishes when a `release X.Y.Z` commit lands on main (or on a `vX.Y.Z` tag), in the public repo only. Installs run
`npm ci --omit=dev --ignore-scripts`, so anything the server imports at run time must be a dependency, not a devDependency.

## Web map (`src/web`)
- `App.tsx` (rail, list, topbar, work area, ⌘K, home), `components/HomeStart.tsx` (home box, mode buttons, Auto via `route.ts`), `components/ChatView.tsx` (Pip seat, memory clouds,
  pills, approval dial, build steps, queue/interrupt/mic), `components/Pip.tsx` (states and presence).
- Panels: `FeaturesPanel`, `BoardPanel`, `MemoryView`, `ProjectView`, `AppCards`, `SettingsView`, `WhatsNew`.
- Plumbing: `live.ts` (SSE hook), `work.ts`, `useVoice.ts`, `api.ts`. Design tokens live in `styles.css`.

**The UI framework is fixed:** icon rail · list · conversation · one work area on the right; Pip by the composer;
smart pills above the box; the approval dial; memory clouds; ⌘K. New features slot into it; don't redesign it.

## How to test
- Every change: `npx tsc -p . --noEmit`, `npm test` and `npm run build`.
- `npm test` covers the pure parts with no instance and no network (see `tests/`); add tests with your change.
- `npm test` also checks what each mode sends before the first word (system prompt + tool definitions, `ops/context-size.ts`):
  more than 15% over `tests/fixtures/context-baseline.json` fails. If the growth is intended, `npm run eval:baseline` and
  commit the new baseline with your change.
- Local copy with throwaway data, no instance:
  ```sh
  export WAYFINDER_DATA_DIR=<scratch>/data WAYFINDER_CONFIG_DIR=<scratch>/config WAYFINDER_PORT=8798 WAYFINDER_SANDBOX=off
  npx tsx src/server/main.ts      # server
  npm run -s token                # login token, same env
  ```
  Drive it with curl (SSE send; approve with `POST /api/chats/:chatId/approvals/:id {"allow":true}`), then `npm run smoke`.
- UI changes: `npm run build && npm run test:ui` (`ops/ui/flows.mjs`: headless Chrome, real clicks, throwaway server,
  fake instance, sends answered in the browser). Add a flow for new UI; see docs/RUNBOOK.md for Chrome setup.
- Changes that touch the instance (Build, install, Show me, remove) also need a run against a real instance. Say in
  the PR that it's needed.

## Test set and scoreboard
The test set is what `npm test` runs (tests/, pure parts, no instance) plus the context-size check against
`tests/fixtures/context-baseline.json`, the UI flows (`npm run test:ui`), the cheat sheet build (`npm run
check:fluent`), the placement scenarios (`npm run eval:placement`, `tests/fixtures/placement-scenarios.json`) and the
speed budget (`npm run smoke`). A Simplify PR keeps every one of them as it was and reports a scoreboard: lines of
code, dependencies, build time, `dist/web` size, test count, per-mode context size.

## Release rules
- Ordinary PRs don't change versions or the changelog. Explain the user-facing change and validation in the PR.
- Maintainers prepare a release PR updating the package version, lockfile and changelog, then publish a `vX.Y.Z`
  tag on the merged commit. See [Publishing a release](docs/RUNBOOK.md#publishing-a-release-maintainers).
- One PR to `main` per change; never push to `main`.

## Hard rules
- **Public-ready repo:** no personal infrastructure names (hosts, tailnet names, IPs, instance ids, usernames) in code,
  comments, docs, tests or commit messages. Use placeholders like `dev12345.service-now.com`, `203.0.113.10`.
- **No secrets in the repo,** and no real instance credentials in tests. Secrets live only in the secrets file.
- **Security posture is a product feature:** allowlist, approvals, build sandbox, access profile, audit. Anything that
  loosens it is a trust change: say so plainly in the PR so it gets a human review.
- Instance credentials stay local. The built-in `instance` MCP server uses `sn.ts`; it has no external tool-server license.
- Tool results are clipped to 6000 chars (pdi `show`: 40 000). Agent SDK tool names are `mcp__<server>__<tool>`.
- `instanceTools.ts` runs in process; reads are explicit in `instanceReads.ts`, and writes require policy approval.
- Fluent: export a Table under its table name.
- `/api/now/v2/user` does not exist; identity comes from `javascript:gs.getUserID()`.
- Stage files by name; no `git add -A` in a shared checkout.
- No process files in git: new plans, loop reports, process and infrastructure notes live outside the repo, in the
  maintainers' own notes. Docs that describe how Wayfinder works stay here.

## How to write the change
Follow the Ponytail ruleset below. Where it disagrees with a house rule above, the house rule wins: comments match the
surrounding code's density (not one line only), and every change runs the full test set and adds its tests (none are
"trivial").

---

<!-- Vendored from DietrichGebert/ponytail AGENTS.md (blob ee5d6f1, MIT License, see notice at the end). Update deliberately, never auto-sync. -->

# Ponytail, lazy senior dev mode

You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

## Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

## The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for.

(Yes, this file also applies to agents working on the ponytail repo itself. Especially to them.)

---

Ponytail ruleset: MIT License. Copyright (c) 2026 DietrichGebert
