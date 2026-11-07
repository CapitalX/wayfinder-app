# Wayfinder runbook

Day-to-day operation of a self-hosted Wayfinder. Paths below are the defaults; `WAYFINDER_DATA_DIR`,
`WAYFINDER_CONFIG_DIR`, `WAYFINDER_PORT` (8797) and `WAYFINDER_HOST` (127.0.0.1) move them. The older `SNW_*` names still
work. This public release uses only the default folders below or the paths you explicitly configure.

## Where things live
| What | Where |
|---|---|
| App code | installed: `~/.local/share/wayfinder/<version>`, with `current` linking to the one in use (Homebrew: its own prefix); from source: the repo folder |
| The `wayfinder` command | `~/.local/bin/wayfinder` (a link into `current`) |
| Server log | `~/wayfinder-data/wayfinder.log` (background process and Homebrew); the systemd service logs to the journal. `wayfinder logs` shows either. |
| Data: chats, projects, board, memories, audit, timings | `~/wayfinder-data/workbench.db` (SQLite in WAL mode: copy `workbench.db*`, including `-wal`) |
| Built apps (one git repo each) | `~/wayfinder-data/apps/<scope>` |
| Update-set backups (weekly) | `~/wayfinder-data/backups` |
| ServiceNow docs (optional, `wayfinder docs setup`) | `~/wayfinder-data/docs/<release>.db` (the search index) and `docs/repos/<release>` (the download it's built from). Delete both to remove them. A docs server set with `SNDOCS_URL` + `SNDOCS_TOKEN_FILE` takes precedence when its token file exists. |
| Secrets: login token, status token, instance credentials | `~/.config/wayfinder/secrets.json` (mode 600; sealed with a key in the macOS Keychain or Windows Credential Manager where there is one, see below) |
| Your own skills (optional) | `~/.config/wayfinder/skills/<name>/SKILL.md`: same name as a shipped skill replaces it, a new name adds one. Settings → Pip → Skills lists them, edits any of them in place (Save writes your copy here, Reset removes it) and flags a file it can't use. Placement rules are the `placement` skill, edited as cards in Settings → Pip → Placement rules. Wayfinder copies the on-demand ones to `~/wayfinder-data/skills-plugin` each answer. |
| Your placement cases (optional) | `~/.config/wayfinder/placement-scenarios.json`: a list of `{name, facts, expect: {place, rule}}` like `tests/fixtures/placement-scenarios.json`. `npm run eval:placement` runs them and the shipped ones against the placement rules in use. |

## The `wayfinder` command
Installed copies (install.sh, install.ps1, Homebrew) are run with `wayfinder`; `wayfinder help` lists everything.
| Command | Does |
|---|---|
| `start` / `stop` / `restart` | Through the systemd user service if it's installed, `brew services` for Homebrew, otherwise a background process (pid in `~/wayfinder-data/wayfinder.pid`). `start --foreground` runs it in the terminal. |
| `status` | Running or not, versions, address, folders, and how it runs. |
| `token [status]` | The login token, or the read-only status token. |
| `update [--check\|--force]` | Downloads the latest release, checks its SHA-256, installs it next to the current one, switches `current`, restarts and runs the smoke test. If that fails it switches back, restarts, and skips that version from then on (`--force` tries it again). The two newest versions are kept. |
| `doctor` | Node, app files, private folders (700) and keys file (600), disk space, git, bubblewrap and the docs; with Wayfinder running also Claude (one real one-word request), the instance (awake, asleep, sign-in) and the account's roles. Exits non-zero on any failure. |
| `docs setup [--release <family>]` / `docs update` / `docs status` | Downloads one release of ServiceNow's public docs (github.com/ServiceNow/ServiceNowDocs, depth 1) and indexes it (SQLite FTS5) for Pip; it picks the connected instance's release when Wayfinder is running, else the newest. Refuses with less than 2 GB free. `update` fetches and re-indexes only changed pages. The Download button in Settings → Pip does the same, and the app runs `update` by itself every day (see [Upstream services](#upstream-services-and-how-they-stay-current)). No restart needed. |
| `service install [--updates]` / `service remove` | Writes (or removes) the systemd user service, and with `--updates` a daily `wayfinder update` timer. It never overwrites a `wayfinder.service` it didn't write. |
| `logs [-f]`, `open`, `version` | The last 100 log lines, the browser, the installed and latest versions. |

On macOS with Homebrew, `brew services start wayfinder` runs it at login (launchd) and `brew upgrade wayfinder` updates
it. **WSL:** a background process lives as long as WSL runs. With systemd on in WSL (`/etc/wsl.conf`:
`[boot] systemd=true`), `wayfinder service install` makes it start with WSL.

**Uninstall** (keeps your data and settings): `wayfinder service remove; wayfinder stop; rm -rf ~/.local/share/wayfinder ~/.local/bin/wayfinder`
(Homebrew: `brew services stop wayfinder && brew uninstall wayfinder`). Delete `~/wayfinder-data` and
`~/.config/wayfinder` too only if you want your chats and keys gone.

## Upstream services and how they stay current
Wayfinder is built on a few things other people release. Each is pinned, watched, and updated by one path:

| Service | Used for | Pinned in | New release noticed | Updated by |
|---|---|---|---|---|
| ServiceNow SDK (`@servicenow/sdk`, `@servicenow/sdk-api`: Fluent) | Build mode builds, installs and reviews apps; the Fluent cheat sheet | `package.json`, `package-lock.json` | Maintainer checks | Maintainers install the new release, compile the cheat sheet (`npm run check:fluent`) and open a dependency PR; the next version tag releases it; `wayfinder update` (the daily timer from `service install --updates`, or `brew upgrade`) installs the release. After the restart the app compiles the cheat sheet once on the new SDK (Settings → Pip → Fluent cheat sheet). |
| ServiceNow docs (github.com/ServiceNow/ServiceNowDocs, one branch per release family) | The docs Pip cites | `~/wayfinder-data/docs` | The app, daily (`git ls-remote`, two minutes after a start and every 24 h) | The app itself: a release whose branch moved is fetched and re-indexed; the newest release is downloaded when ServiceNow publishes it (and the selected one, Settings → Pip → docs release, else the connected instance's, when it's another); the rest is removed, downloads first so a failed download never leaves fewer docs. Only once docs were set up. Settings → Pip → ServiceNow docs shows the last check; `wayfinder docs update` updates by hand. |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Pip's brain | `package.json`, `package-lock.json` | Maintainer checks | Bump PR (tests run on the new release) → release → `wayfinder update`. |
| MCP SDK (`@modelcontextprotocol/sdk`) | Discovering your tool servers | `package.json`, `package-lock.json` | Maintainer checks | Bump PR → release → `wayfinder update`. |
| Wayfinder itself | | `~/.local/share/wayfinder/current` | `wayfinder version`, `wayfinder update --check` | `wayfinder update`, the daily timer, or `brew upgrade wayfinder`. |
| Node, git, bubblewrap | Running, Build mode, the build sandbox | Your package manager | `wayfinder doctor` | You, with your package manager. |
| A docs server (`SNDOCS_URL`) and your own tool servers | Optional | Yours | | Yours. |

## Run it as a service from a git checkout (Linux, systemd user unit)
```ini
# ~/.config/systemd/user/wayfinder.service
[Unit]
Description=Wayfinder
After=network-online.target

[Service]
WorkingDirectory=%h/wayfinder
ExecStart=/usr/bin/env npx tsx src/server/main.ts
Restart=on-failure

[Install]
WantedBy=default.target
```
```bash
systemctl --user daemon-reload && systemctl --user enable --now wayfinder
loginctl enable-linger "$USER"   # keep it running after you log out
journalctl --user -u wayfinder -f
```

## Update
Installed copies: `wayfinder update` (see above). From a git checkout:
```bash
git pull && npm ci --ignore-scripts && npm run build && systemctl --user restart wayfinder && npm run smoke
```
`--ignore-scripts` keeps dependencies' install scripts from running on the machine that holds your secrets; nothing
Wayfinder uses needs them. `npm run smoke` checks health, version, the live update stream, a board and memory round trip, feature search (when an
instance is connected) and speed budgets. It exits non-zero on any failure. Every release adds an entry to
`changelog.json`, which users see under ⓘ.

### What an update does while Pip is working
`wayfinder update` (and its optional daily timer from `wayfinder service install --updates`) restarts the app. So that a
restart doesn't cut off Pip:

- **Running answers:** the update first waits for running answers to finish (it asks the app, `GET /api/busy`). After
  `WAYFINDER_UPDATE_WAIT` seconds (default 1800) it goes ahead anyway. An answer a restart does cut off keeps what it did and ends with
  a note and **Continue**; if the app couldn't save it (killed, crashed), the note appears at the next start.
- **The restart window:** once no answers are running, the update writes `~/wayfinder-data/updating.json` and checks
  once more (an answer that started in between is waited for too). While that file is there, the app doesn't start new
  answers: a message sent in those seconds shows "Wayfinder is updating, starting in a moment" and the page sends it
  again as soon as the new server answers. The new server removes the file when it starts; it also expires after two
  minutes. A file the app can't read holds answers until it's removed (the update removes it when it ends, and a
  restart does too). If Claude can't be started at all (its files missing or busy), the answer says so in plain words,
  with **Continue**.

## Publishing a release (maintainers)
Releases are built in the public repo by `.github/workflows/release.yml`; it doesn't publish from a private copy.
CI and releases use GitHub's `ubuntu-latest` Linux runner only, including fork PRs.
Hosted Linux includes Chrome on PATH; CI falls back to installing the headless shell if needed. UI failures block CI.

0. Once, in the public repo's settings: a tag ruleset for `v*` that only maintainers may create, update or delete,
   so nobody else can start a release. The workflow also refuses a tag that isn't on main.
1. Prepare and merge a release PR with the version in `package.json`, `package-lock.json` and a matching top entry
   in `changelog.json`. Ordinary feature and fix PRs don't change versions.
2. Push a `vX.Y.Z` tag pointing to that merged commit on `main`. The workflow checks that the tag, package version
   and changelog agree, runs the type check, tests and build, then publishes `wayfinder-X.Y.Z.tgz`, `install.sh`,
   `install.ps1` and `SHA256SUMS` (`packaging/pack.sh` fills in the repo name). An already published version is skipped.
3. Homebrew is optional: first create `<owner>/homebrew-tap`. The release step then updates `Formula/wayfinder.rb` in `<owner>/homebrew-tap`. That needs the Actions secret **`TAP_TOKEN`**: a
   fine-grained personal access token with access to **only** the tap repo and **Contents: read and write**, nothing
   else; give it an expiry and renew it. Without the secret the release still publishes and the job warns that the
   formula wasn't updated.

To try packing locally: `npm run build && bash packaging/pack.sh <owner>/<repo> /tmp/wf-release`. The install test
`bash packaging/test/linux-install.sh` packs two releases and runs install, start, doctor, reinstall, update and stop
in a clean `ubuntu:24.04` container (`--host`: the same on this machine, with an empty home and Node hidden).

## Security tasks
- **Rotate the login token:** Settings → Security → Rotate app token. This signs out every other browser; the new token
  shows once (`npm run token` prints it later).
- **Status-only token** (for external reminder watchers, read-only `GET /api/status`): `wayfinder token status` (from a git checkout: `npm run token -- status`).
- **Re-check what the instance account can do:** Settings → Instance → Access → Check again. This refreshes on its own
  every 6 hours.
- **Audit:** Settings → Approval log lists every approval card decision, auto-approval and security change. Policy
  refusals that never reach a card are not logged yet.

## Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| Banner says the PDI is hibernating | Wake it at developer.servicenow.com, then log in once interactively. |
| "Sign-in to the instance failed (401)" | Wrong or rotated client secret; Settings → Instance → reconnect. For "Sign in as me", use *Sign in again*. |
| Pip says it can't install plugins | The account lacks `admin` or `sn_cicd.sys_ci_automation`; see Settings → Access. |
| Build fails with "bwrap is not installed" | `sudo apt install bubblewrap`, or `WAYFINDER_SANDBOX=off` for local development only. |
| Mic button missing | Voice isn't set up (see the README's optional extras), or the page isn't served over https. |
| Answers feel slow | Settings → Speed shows time to first sign of life and the slowest tools. |

## Backups
Copy `~/wayfinder-data` (including `workbench.db-wal`) and `~/.config/wayfinder` while the service is stopped,
or use the SQLite `.backup` command while it runs. Update sets are exported weekly to `backups/`, so a reclaimed PDI
costs little.

### What the update-set backups and checkpoints can and can't restore
- **Update-set backups** (`backups/<instance>/<date>/`, weekly, the newest 8 kept): each in-progress update set (not
  `Default`) as an XML file in the format of System Update Sets → Retrieved Update Sets → **Import Update Set from XML**.
  To restore, import the file on an instance, then Preview and Commit it there.
  - They hold **configuration captured in update sets**: not data records, not changes made in `Default` or outside an
    update set, not completed sets, not plugins or Store apps.
  - A week counts as backed up only after every file and `index.json` are written; a failed run is tried again at the
    next check. Files are written whole (a crash never leaves half a file).
  - `index.json` says `"complete": false` (with which sets were cut) when a backup hit its limits: 200 sets, or 5000
    updates in one set. Back those sets up by hand from the instance.
- **Checkpoints** (Build mode, per app): a git tag on the app's source in `apps/<scope>/`. Restoring one rolls back the
  **source here only**. It doesn't undo anything on the instance: records the app already installed, data, or changes
  made on the instance outside the app stay as they are until you build and install that version again (or remove the
  app).
- **The instance itself** is never backed up by Wayfinder. On a developer instance, ServiceNow reclaims it after
  inactivity; the update-set backups are what you keep.

## Instance tools

Wayfinder's `instance` MCP server runs in process over the Table and Aggregate REST APIs using the saved sign-in
(client credentials, username/password, or user OAuth). No separate tool server is installed or started.
Calls appear as `instance · query_records` and similar names; saved chats using the older tool names still open.

Reads include queries, single records, counts, aggregates, inherited dictionary fields and paged script source.
`read_script` accepts a table and sys_id or exact name; follow `next_from_line` and `next_from_column` to continue
without losing source to the 6000-character result limit. Dictionary mandatory flags do not include runtime UI policies.
Encoded queries allow only a small set of read-only `gs` date/identity helpers; use literal values for other expressions.

Create, update and delete require Build mode, writes enabled in Settings, settled placement and a separate approval
for each call, including in Auto mode. Deletes say Delete on the card. `run_script` also requires scripting enabled
and shows the full script and its reason for approval. It runs immediately through the instance's script runner and
returns captured output, result, exception and elapsed time. If missing, Pip offers `setup_script_runner`.

In Settings → Instances, **Set up script runner** previews the complete operation script and exactly two global
records: `sys_ws_definition` and a POST `/run` `sys_ws_operation`. Approval installs them; setup also exists as a
Build tool. The endpoint requires authentication and checks `gs.hasRole('admin')` before evaluating anything with
`GlideEvaluator.evaluateString`. No separate ACL is created, so setup does not require `security_admin` elevation.
This is a trust change: an authenticated endpoint can execute arbitrary code as the calling admin, with admin
access enforced by the operation script rather than a separate REST endpoint ACL.

Setup and removal temporarily select Global and its default update set under the instance lock, then restore the
account's previous application and update-set preferences, including on failure. Setup verifies the returned scope
and Global namespace. It reuses only an exact match, or replaces a leftover runner definition with no operations.
Failed installs roll back the records they created in reverse order; if cleanup fails, the remaining IDs stay saved
for removal and the original error and cleanup error are reported. **Remove script runner** previews and deletes
only stored IDs, including ACL IDs saved by older versions. Removing a reused runner also affects
other Wayfinder installations using it. Direct `gs.print/info/log/warn/error/debug` calls are collected with all
arguments; logs produced indirectly by other scripts still go to the instance log.
Credential tables are refused for reads and writes; results are masked before reaching Pip, the UI or saved history.

## Development
```bash
WAYFINDER_DATA_DIR=/tmp/wf/data WAYFINDER_CONFIG_DIR=/tmp/wf/config WAYFINDER_PORT=8798 WAYFINDER_SANDBOX=off npx tsx src/server/main.ts
npx tsc -p . --noEmit && npm run build
npm run build && npm run test:ui   # UI flows in headless Chrome, on a throwaway server and a fake instance
```
`WAYFINDER_SMALL_JOBS=off` stops the small model jobs (chat titles, fresh-chat summaries, drafted lessons and conventions) from
calling Claude; each falls back to its free version. The UI flows set it.
`npm run test:ui -- guided memory` runs only those flows. It finds Chrome through `$CHROME`, then
chrome-headless-shell in `~/.cache/wayfinder-chs`
(`npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/wayfinder-chs`), then Google Chrome.
`UI_DARK=1` runs the flows in the dark theme (the design system's own; the default is light); `UI_SHOTS=1` saves a
screenshot at a few named points, to `$UI_OUT` or a temp folder it prints.


### Testing the build sandbox
`tests/sandbox.test.ts` runs everywhere (environment allowlist, limits, process-group stop, path guard).
`tests/sandbox.linux.test.ts` needs Linux with bubblewrap able to create namespaces and is skipped elsewhere; the
Linux checks run it when namespaces are available. It checks that a build can't read the secrets file, data, home, the checkout or
host processes, has no network, and changes only its app folder.

## Secrets and the computer's credential store

Secrets (instance credentials, the login and status tokens, an Anthropic key, tool server secrets) live in one
mode-600 file, `~/.config/wayfinder/secrets.json`. On a Mac, and in WSL on Windows, the file is sealed (AES-256-GCM)
with a random key kept in the computer's own credential store: the macOS Keychain (item `wayfinder-secrets-key`,
through the `security` tool) or the Windows Credential Manager (Web Credentials, resource `wayfinder`, through
`powershell.exe`). A copy of the file is useless without that store, which is the point. The secrets themselves never
go into the store, and the key never appears in a command line.

The first start on such a computer seals an existing plain file in place; nothing else changes. On Linux without WSL
(and in Docker) the file stays plain. `WAYFINDER_KEYCHAIN=off` turns sealing off: the key is still read, so a sealed
file is written back plain on the next start, which is also how to move to another machine (turn it off, start once,
copy the file). A sealed file on a machine whose store is locked or can't be reached stops the start with a message
saying so; `wayfinder token` reads the same file and needs the same store.

## Routines

Settings → Routines asks Pip the same question on a schedule: every hour, every day at an hour, or every week on a
weekday at an hour, on your clock (see Time zone below). Each run is a fresh chat titled after the routine (with the date), on the active
instance and in the routine's project if it has one, so the report is in the chat list when you come back. The form
offers the one-click Insights checks (log errors, failed jobs, changed ACLs…) as starting points. Run now starts a
run straight away and opens its chat.

Routines are read-only by design: only the read-only modes are offered (Explore, Debug, Decide, Mockup), so a run can
never change the instance, and nothing waits on an approval card nobody is there to click. Pip is told the run is
unattended and ends with a short report. A run spends like any answer: the daily budget (Settings → Pip) applies, and
a run that finds it used up leaves a note in its chat instead of answering. Due routines run one after another, once
a minute at most; a routine whose last run is still answering waits for its next slot. Routines that fell due while
Wayfinder was off run once at the next start. Creating or changing a routine is recorded in the approval log.

## Time zone

The browser sends its time zone with every message, and Wayfinder keeps the last one (Settings → Pip shows it).
Pip is told the current date and time in that zone with each answer, routine schedules run on it, and update set
notes are dated by it, so a server, Docker or WSL running in another zone makes no difference. Until a first message
arrives, the process's own zone is used.

## User tool servers

Settings → Tool servers adds MCP servers over stdio (a local command and arguments) or Streamable HTTP (a URL).
Servers start disabled. Test connects even while disabled and lists the available tools without calling them.
Enable makes a server available on the next answer; the built-in `instance` tools remain the default for ServiceNow.
If discovery fails or times out, Pip gets an unavailable note and continues with the remaining tools.

This is a trust change: stdio runs a local program with Wayfinder's permissions, including file access, without the
Build sandbox. Only add trusted programs. HTTP servers receive the configured headers and any tool arguments you
approve. Wayfinder does not supply instance credentials automatically; configure the server's own authentication.
Environment values and header values live only in the mode-600 secrets file, and Settings returns set/not-set flags.
When editing, blank secret fields keep the saved values; an empty JSON object clears them. Put credentials in these
fields, never in command arguments or the URL. Removing a server also removes its saved secrets.

User tools may write, regardless of their name. They are refused outside Build mode and when changes are off in
Safety. Every call asks with the server label, tool name and arguments; chat auto approvals do not cover them.
Changing or disabling a server invalidates pending approvals. Arguments naming credential tables are refused, and
results pass through credential masking. Third-party code can still perform its own actions: these checks cannot
sandbox a trusted local program or inspect what a remote server does internally. Changes to a server require a new
answer before Pip can use its new configuration.
