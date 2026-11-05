# Contributing

Thanks for helping make Wayfinder better.

## Getting set up
```bash
npm ci --ignore-scripts
npm run build   # the web app
WAYFINDER_DATA_DIR=/tmp/wf/data WAYFINDER_CONFIG_DIR=/tmp/wf/config WAYFINDER_PORT=8798 WAYFINDER_SANDBOX=off npx tsx src/server/main.ts
```
Use a personal developer instance for anything that touches ServiceNow. Never point development builds at a
production instance.

## Before you open a pull request
- `npx tsc -p . --noEmit`, `npm run build` and `npm test` pass.
- Ordinary PRs don't bump the version or edit the changelog. Describe the user-facing change in the PR.
  Maintainers prepare release PRs and publish version tags; see [the runbook](docs/RUNBOOK.md#publishing-a-release-maintainers).
- UI changes fit the layout (icon rail · list · conversation · work area; Pip by the composer) and were checked in a
  browser at desktop and phone widths.
- Anything that loosens a safety rule (approvals, the web allowlist, the build sandbox, auth, the access profile)
  says so plainly in the PR description.
- No secrets, instance URLs or personal data in code, tests, screenshots or commit messages.

## Style
TypeScript everywhere, small focused modules, comments that explain *why*. Write user-facing text in plain words.

By contributing you agree that your contributions are licensed under the Apache License 2.0.
