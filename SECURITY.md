# Security

Wayfinder holds credentials to ServiceNow instances, so security reports are welcome and taken seriously.

## Reporting a vulnerability
Please **don't open a public issue**. Use GitHub's private vulnerability reporting (Security → Report a vulnerability)
on this repository. You'll get a reply within a few days. Please include steps to reproduce and the version (shown in
the ⓘ panel).

## How Wayfinder is built to be safe
- **Private by default.** It binds to 127.0.0.1 and requires a login token. Run it behind a private network; never
  expose it to the internet.
  The login cookie is HTTPS-only except on this machine.
- **Asks before changing anything.** Writes, scripts, plugin and app installs need an approval in the app. Auto mode
  is opt-in per chat, expires after 2 hours, works only on developer instances, and never covers removals or installs
  that a code scan flags. Every decision is audited.
- **Works within the account's rights.** An access profile records what the connected account can do; calls it can't
  make are refused before they're sent, and refusals from the instance are remembered.
- **Contained web access.** Web fetch is limited to allowlisted domains and refuses private, loopback, link-local and
  internal network addresses after DNS resolution.
- **Sandboxed builds (Linux).** Generated app code uses one sandbox interface, with bubblewrap on Linux unless
  `WAYFINDER_SANDBOX=off`, and an unsandboxed backend elsewhere. Under bubblewrap, home, data, config and the Wayfinder
  checkout are hidden, host processes are invisible, only the app's own folder is writable, and builds have no network.
  Every build process gets an allowlisted environment (never the Claude key or the app token), CPU, file-size and
  open-file limits plus a capped Node heap, and is stopped with its whole process group (SIGKILL after a grace period).
  App file tools refuse symlinks, `.git` and paths that resolve outside the app. Packaging also runs without network or
  credentials. The server saves a separate package copy with its build commit and SHA-256 hash outside the app folder.
- **Trusted package uploads.** Installs check that saved package against the approved commit and hash, refusing links
  and paths outside the build output. Only the SDK's HTTP Connector receives credentials in memory; it uploads the
  package as data, never loads the app's config or source, and never runs a process, package script or hook. Cancellation
  and a 15-minute timeout abort upload requests and progress polling; an instance may still finish work already received.
- **Secrets stay local.** Instance credentials live in a mode-600 file on the host; "Sign in as me" stores only a
  refresh token. Same-origin JSON-only writes protect against cross-site requests.

## Known limits
- Self-hosted is not local processing: chats and tool results go to Anthropic. See [docs/DATA.md](docs/DATA.md).
- Anyone with the login token can use your instance connections; treat the token like a password and rotate it in
  Settings → Security if it leaks.
- On macOS and in Docker the build sandbox is off. Generated code then runs as the Wayfinder user: it can read the
  secrets file and use the network. The container protects your host, not Wayfinder's own secrets from generated code.
  Build results and install approval cards say when a run is unsandboxed. Use Linux with bubblewrap for real work.
- AI output can be wrong. Approval cards show exactly what will change; read them.
