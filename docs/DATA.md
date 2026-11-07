# Where your data goes

Wayfinder is self-hosted, but **the thinking is not local**: Pip runs on Anthropic's Claude models. Self-hosted means
your instance credentials, chats and apps live on your machine; it does not mean the model runs there.

## What leaves your machine
| Goes to | What | When |
|---|---|---|
| **Anthropic** (the Claude API, through the Claude Agent SDK) | Your messages, the chat so far, Pip's instructions (including your instance's name, release, the access profile, project brief, saved items, memories and investigation board), and the **results of every tool Pip uses**: records, schemas, logs and scripts it reads from your instance, docs passages and allowed web pages. | Every answer, and short background jobs (chat titles, summaries). |
| **Your ServiceNow instance** | The reads and changes Pip makes, each change only after you approve its card; app installs. | When Pip uses an instance tool. |
| **Allowlisted web domains** | A page fetch or search, only for domains on your allowlist and never private addresses. | When Pip looks something up. |
| **GitHub** (`github.com/ServiceNow/ServiceNowDocs`) | Nothing about you: a git download of ServiceNow's public docs. | When you set up or update local docs. |

Wayfinder itself sends no telemetry anywhere.

## How long Anthropic keeps it
That depends on **your agreement with Anthropic** (the API key's account), not on
Wayfinder. Read Anthropic's privacy policy and commercial terms for retention, training use and zero-data-retention
options before you point Wayfinder at an instance with sensitive data. Use a developer instance with test data where
you can.

## What stays on your machine
| Where | What | Kept until |
|---|---|---|
| `~/wayfinder-data/workbench.db` | Chats and answers, projects, saved items, memories, the board, routines, the approval log (secrets masked), timings and costs. | You delete them in the app (chats, projects, saved items, memories), or delete the file. |
| `~/.claude/projects/<folder>/<session>.jsonl` | The Agent SDK's own transcript of each chat, including tool results. | You delete the chat (Wayfinder deletes its transcripts with it), or Claude Code's cleanup removes ones older than 30 days. |
| `~/.config/wayfinder/secrets.json` (mode 600) | Instance credentials, the app token, your Anthropic key if you saved one. On a Mac or in WSL the file is sealed with a key in the macOS Keychain or Windows Credential Manager (`wayfinder-secrets-key`). | You remove the instance or the key. |
| `~/wayfinder-data/apps/` | Source of apps built in Build mode (a git repo each). | You delete it. |
| `~/wayfinder-data/backups/` | Weekly XML backups of in-progress update sets. | You delete them. |
| The service log (journalctl, or your terminal) | Start-up, errors and timings; no chat content and no credentials. | Your system's log rotation. |

## Deleting
- **A chat:** removes its messages from the database and the Agent SDK's transcripts of it. Its rows in the approval
  log and the cost history stay (they record what happened; inputs are masked).
- **Everything:** stop Wayfinder and delete `~/wayfinder-data`, `~/.config/wayfinder` and the `~/.claude/projects`
  folders whose names end in `wayfinder-data-agent-cwd`. What Anthropic already received follows their retention.
