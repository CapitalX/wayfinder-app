#!/usr/bin/env bash
# Claude Code PostToolUse hook: when an agent edits the Fluent cheat sheet, compile its examples right away and hand
# any failure back to the agent (exit 2 shows stderr to it), so a broken example never gets committed.
input=$(cat)
case "$input" in *fluent-cheatsheet.md*) ;; *) exit 0 ;; esac
cd "$(dirname "$0")/../.." || exit 0
out=$(npm run -s check:fluent 2>&1) && exit 0
echo "The Fluent cheat sheet no longer builds after this edit:" >&2
echo "$out" | tail -20 >&2
exit 2
