# Build efficiency matrix

How Wayfinder keeps Pip's Build mode (and the other modes) fast and low-error: fewer model turns, fewer failed tool
calls, fewer wasted questions. Every lever is measured per answer in the `perf` table and shown in Settings → Speed
(per mode: first sign of life, turns, steps, failed steps, cost). `npm run smoke` enforces the speed budget.

## Levers

| Lever | Before | Now | Expected effect | How it's measured |
|---|---|---|---|---|
| Effort per mode | one setting for everything | `MODE_CONFIG` in `prompts.ts`: medium for explore/mockup, high for decide/debug/build | faster light answers, care where it matters | first sign of life per mode |
| Turn caps | none | `maxTurns` per mode (16 mockup … 200 build) | runaway loops end with a summary instead of burning time | turns per mode |
| Guardrail hooks | the model decided how to react to errors | `guardrails.ts` PostToolUse/Failure hints: 401 → reconnect, 403 → don't retry, bad name → check schema once, build errors → fix all in one pass, same tool failing 3× → stop, 30 calls → wrap up | fewer retry spirals | failed steps (%) per mode |
| Instance facts up front | discovered by tool calls each answer | `facts.ts` (release, vendor prefix, ATF on/off, current update set), cached 10 min, in the prompt | 2–4 fewer reads at the start of a build | steps per build answer |
| Docs release | fixed | matches the instance's release (or the header picker) | fewer wrong-release answers | spot checks |
| Interview | fixed five questions, one per turn | 0–3 adaptive questions in one ` ```questions ` form, with exits to out-of-the-box options | 4+ fewer round trips per build | turns from first message to `propose_app` |
| Capability check | ATF discovered at test time | checked before building; `enable_atf` offered once | no failed test run at the end | failed steps in build |
| Post-install loop | the user asked for checks | Pip validates, runs tests and posts review links automatically (`followup.ts`) | one less round trip, a clear end state | install → review time |
| Prompt layout | dynamic content mixed in | stable rules first, instance/project/memories last | better prompt caching, lower cost | cost per answer |
| Sub-agents | inherited the main model | reviewer and researcher on Sonnet | cheaper parallel research | cost per answer |
| Fluent cheat sheet | a 5–9k-token doc page read per record type; some doc examples don't build | `fluent-cheatsheet.md` in the Build prompt: every example compiles together (SDK 4.13); `fluent_docs` only for the rest | 6–10 fewer turns per app | turns per build answer |
| Batch write + build | one `write_app_file` call per file, then `build_app` | `write_app_files` writes every file and builds in one call | ~5 write turns become 1 | steps per build answer |
| Structured build errors | coloured text, code frames, tail-clipped (first errors lost) | `[{file, line, col, code, message, hint}]` from `fluent.ts`, first 25 errors, hints for ~20 known mistakes | fixes in one pass, 2–4× fewer tokens per failed build | builds per app |
| Docs lookups | whole pages up to 30 KB | aliases (`menu` → applicationmenu-api) and `section` ("properties", "examples") | lookups under ~3 KB | tool result size |
| Scope collision | found at install | `sys_scope` checked in `propose_app` | no failed install from a taken scope | install failures |
| Fallback model | none | Sonnet ↔ Haiku fallback when the main model is overloaded | fewer failed answers | error answers |

## Next levers (from the SDK review)
- **Spec-to-scaffold generator:** write tables, roles + ACLs, menu modules, demo data and a CRUD test per table from the
  approved plan, so the first build is green by construction and Pip only adds logic.
- **Fluent lint before build** for what the compiler accepts silently: unknown column options (`required`), unknown
  record fields, ACLs or rules on missing tables, `operation: 'update'`, redeclared task fields, tables without ACLs or
  modules, rules without tests.
- **Tests through `now-sdk cicd testsuite run -o json`** for per-test results Pip can act on.
- **Warm in-process builds** (about 0.35 s against 3.5 s): only worth it with validate-on-write.

## Reading the numbers
- **Turns** are model round trips in one answer; a typical build should be well under 40.
- **Failed steps** above 10% in a mode means a tool or prompt rule needs work: check the slowest-tools table and the
  audit log for that mode.
- **Cost** is the Agent SDK's reported cost per answer (API key use); on a Claude plan it's an estimate.
