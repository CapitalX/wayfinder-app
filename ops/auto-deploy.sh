#!/usr/bin/env bash
# Auto-deploy: when origin/main moves, build the new commit in its own folder (never in the folder the app is running
# from), then switch the `current` link to it, restart and smoke-test; if anything fails after the switch, switch back
# and restart the build that was running. Meant for a systemd user timer every couple of minutes (see docs/RUNBOOK.md).
# Layout: WAYFINDER_BUILDS_DIR (default ~/.local/share/wayfinder-builds) holds one git worktree per built commit and
# `current`, the link the service runs from (a systemd drop-in sets its WorkingDirectory; the first run writes it).
# The checkout this script lives in is the source. Nothing is ever discarded there: once the new build runs, it moves
# forward only if it has no local changes, and only by a fast-forward (so the script itself stays current).
# Packages install with --ignore-scripts: this host holds the secrets file, so a dependency's install script never
# runs here. Nothing Wayfinder uses needs one (CI installs the same way and builds the Fluent examples).
# Env: WAYFINDER_SERVICE (systemd user unit, default wayfinder), WAYFINDER_DATA_DIR / WAYFINDER_PORT like the server
# (the older SNW_ names still work),
# WAYFINDER_NOTIFY (optional command, called as `$WAYFINDER_NOTIFY "<title>" "<text>"` once per failing commit),
# WAYFINDER_DEPLOY_WAIT (seconds an update waits for running answers before it restarts anyway, default 1800).
set -uo pipefail
# The whole script is read before anything runs (main at the bottom), so moving this checkout can't change it mid-run.
main() {
cd "$(dirname "$0")/.."
SRC=$(pwd -P)
BUILDS="${WAYFINDER_BUILDS_DIR:-$HOME/.local/share/wayfinder-builds}"
case "$BUILDS" in /*) ;; *) BUILDS="$SRC/$BUILDS" ;; esac
# Physical, like SRC: the folder itself when it exists (so a link to home or the checkout is seen for what it is),
# otherwise its parent.
if [ -d "$BUILDS" ]; then BUILDS=$(cd "$BUILDS" && pwd -P)
else _p=$(cd "$(dirname "$BUILDS")" 2>/dev/null && pwd -P) && BUILDS="${_p%/}/$(basename "$BUILDS")"; fi
# Builds are removed from this folder, so it must be one of its own: never /, home, this checkout or a folder holding it.
case "$SRC/" in "${BUILDS%/}/"*) BAD_BUILDS=1 ;; *) BAD_BUILDS="" ;; esac
[ "${BUILDS%/}" = "" ] || [ "${BUILDS%/}" = "/" ] || [ "${BUILDS%/}" = "$(cd "$HOME" && pwd -P)" ] && BAD_BUILDS=1
CURRENT="$BUILDS/current"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="${WAYFINDER_SERVICE:-wayfinder}"
DATA="${WAYFINDER_DATA_DIR:-${SNW_DATA_DIR:-$HOME/wayfinder-data}}"
LOG="$DATA/deploy.log"; STATUS="$DATA/deploy-status.json"; NOTIFIED="$DATA/.deploy-notified"
PORT="${WAYFINDER_PORT:-${SNW_PORT:-8797}}"
# A timer run may not inherit these; systemctl --user needs them to find the user manager.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
mkdir -p "$DATA"
exec 9>"$DATA/.deploy.lock"; flock -n 9 || exit 0   # one deploy at a time
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
logout() { sed 's/^/    /' <<< "$1" | tail -20 >> "$LOG"; }   # a command's output, indented, last 20 lines
running_dir() { [ -L "$CURRENT" ] && readlink "$CURRENT" || echo "$SRC"; }   # the build the service runs (before the first switch: this checkout)
status() { local d; d=$(running_dir); printf '{"at":%s,"ok":%s,"commit":"%s","version":"%s","message":"%s"}\n' "$(date +%s000)" "$1" "$(git -C "$d" rev-parse --short HEAD 2>/dev/null)" "$(cd "$d" && node -p "require('./package.json').version" 2>/dev/null)" "${2//\"/\'}" > "$STATUS"; }
notify() {  # one ping per failing commit; problems only
  [ -n "${WAYFINDER_NOTIFY:-}" ] || return 0
  [ "$(cat "$NOTIFIED" 2>/dev/null)" = "$new" ] && return 0
  echo "$new" > "$NOTIFIED"
  $WAYFINDER_NOTIFY "$1" "$2" >> "$LOG" 2>&1 || log "notify failed"
}

git fetch -q origin main || { log "fetch failed"; exit 0; }
if [ -n "$BAD_BUILDS" ]; then
  log "not deploying: WAYFINDER_BUILDS_DIR ($BUILDS) is /, home, this checkout or a folder holding it; builds need a folder of their own"
  status false "update not installed: WAYFINDER_BUILDS_DIR must be a folder of its own"; exit 0
fi
old=$(git -C "$(running_dir)" rev-parse HEAD); new=$(git rev-parse origin/main)   # what runs, not where this checkout is
[ "$old" = "$new" ] && exit 0

# Can systemctl --user reach the user manager? On WSL, WSLg can mount a fresh /run/user/<uid> over the manager's
# sockets; systemctl then says "Failed to connect to bus" until user@<uid> is restarted.
BUS_HINT="systemctl --user can't reach the user manager (no bus at $XDG_RUNTIME_DIR/bus). On WSL, WSLg may have mounted a fresh $XDG_RUNTIME_DIR over it; fix: sudo systemctl restart user@$(id -u)"
bus_ok() { systemctl --user show-environment >/dev/null 2>&1; }
token() { (cd "$(running_dir)" && npx tsx src/server/token.ts 2>/dev/null | tail -1); }
running_version() {  # version of the server answering on the port, or empty
  curl -s -m 2 -H "Authorization: Bearer $(token)" "http://127.0.0.1:$PORT/api/about" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version||"")}catch{}})' 2>/dev/null
}
# How many answers the running server is in the middle of: a count, or "unknown" when it can't be told (an error, a
# timeout, an odd reply, an older server without /api/busy). Unknown counts as busy. Only "nothing is listening on the
# port" (curl exit 7) is 0: no server, so no answer to cut off.
busy() {
  local out rc
  out=$(printf 'Authorization: Bearer %s\n' "$(token)" | curl -s -m 5 -H @- -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/busy" 2>/dev/null; echo " ${PIPESTATUS[1]}"); rc=${out##* }; out=${out% *}   # curl's own exit code, not the pipe's
  [ "$rc" = 7 ] && { echo 0; return; }
  [ "$rc" = 0 ] && [ "${out##*$'\n'}" = 200 ] || { echo unknown; return; }
  printf '%s' "${out%$'\n'*}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let n;try{n=JSON.parse(s).answering}catch{}process.stdout.write(Number.isInteger(n)&&n>=0?String(n):"unknown")})' 2>/dev/null || echo unknown
}
# A restart ends every running answer, so wait until the app says none are running: up to WAIT seconds from the
# first check, polling. When the wait runs out the update goes ahead, and the server tells each cut-off chat so.
WAIT="${WAYFINDER_DEPLOY_WAIT:-1800}"; POLL="${WAYFINDER_DEPLOY_POLL:-15}"; deadline=""
wait_idle() {
  local n said=""
  deadline=${deadline:-$(( $(date +%s) + WAIT ))}
  while n=$(busy); [ "$n" != 0 ]; do
    local what; [ "$n" = unknown ] && what="the app couldn't say whether answers are running" || what="$n answer(s) running"
    if [ "$(date +%s)" -ge "$deadline" ]; then log "$what after ${WAIT} s; restarting anyway (each chat says it was cut off)"; return 0; fi
    [ -z "$said" ] && log "waiting before ${new:0:7} restarts the app: $what (up to ${WAIT} s)" && said=1
    sleep "$POLL"
  done
  [ -n "$said" ] && log "no answers running; going ahead"
  return 0
}
ready() {  # wait for the restarted server to answer
  local t; t=$(token)
  for _ in $(seq 1 45); do curl -s -m 2 -o /dev/null -H "Authorization: Bearer $t" "http://127.0.0.1:$PORT/api/session" && return 0; sleep 1; done
  return 1
}

# Nothing has changed yet, so if the restart can't work, don't touch the running build.
if ! bus_ok; then
  log "${new:0:7} not deployed: $BUS_HINT"
  v=$(running_version)
  status false "update ${new:0:7} not installed: can't reach systemd to restart${v:+, still running $v}"
  notify "Wayfinder update stuck" "Can't restart the app to install ${new:0:7}: the systemd user bus is missing. Fix: sudo systemctl restart user@$(id -u).${v:+ Still running $v.}"
  exit 0
fi

# The restart window: from just before the restart until the new server is up. The app holds new answers while
# <data>/updating.json says so (the new server clears it when it starts; `until` ends one left behind).
hold_answers() { printf '{"until":%s}\n' "$(( ($(date +%s) + 120) * 1000 ))" > "$DATA/updating.json"; }
release_answers() { rm -f "$DATA/updating.json"; }
# Wait for running answers to end, then hold new ones. An answer that started between the last check and the hold is
# caught by one more check: release, wait for it, hold again (until the wait runs out). Fails if the hold can't be
# written: then nothing may restart, because new answers would still start.
quiet() {
  while :; do
    wait_idle; hold_answers || return 1
    [ "$(busy)" = 0 ] || [ "$(date +%s)" -ge "${deadline:-0}" ] && return 0
    release_answers
  done
}
# Points `current` at $1 in one step (rename over the old link), so the service never sees it missing.
switch_to() {
  ln -sfn "$1" "$BUILDS/.current.new" &&
    node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$BUILDS/.current.new" "$CURRENT" &&
    [ "$(readlink "$CURRENT")" = "$1" ]
}
# The service runs from `current`. A drop-in sets that once; the unit file itself stays as it was written.
DROPIN="$UNIT_DIR/$SERVICE.service.d/50-wayfinder-builds.conf"
run_from_current() {
  [ "$(cat "$DROPIN" 2>/dev/null)" = "$(printf '[Service]\nWorkingDirectory=%s' "$CURRENT")" ] && return 0
  mkdir -p "$(dirname "$DROPIN")" && printf '[Service]\nWorkingDirectory=%s\n' "$CURRENT" > "$DROPIN" && systemctl --user daemon-reload &&
    log "the service now runs from $CURRENT (systemd drop-in $DROPIN)"
}

step=""; why=""   # set when a step fails
BUILT=""
build() {  # $1 = commit. Builds it in $BUILDS/<commit> (sets BUILT), away from the running app; reuses a finished build.
  local dir="$BUILDS/${1:0:12}" from out
  BUILT=$dir
  [ -f "$dir/.wayfinder-built" ] && return 0
  from=$(running_dir)
  step=checkout
  if [ -e "$dir" ] || [ -L "$dir" ]; then   # a half-made build of this commit: removed only if git knows it as one of ours
    git worktree list --porcelain | grep -qxF "worktree $dir" && git worktree remove --force "$dir" 2>/dev/null ||
      { why="$dir is in the way and isn't a build this script made; move it away"; return 1; }
  fi
  git worktree prune
  out=$(git worktree add -q --detach "$dir" "$1" 2>&1) || { why="git worktree add failed"; logout "$out"; return 1; }
  # Same packages as the running build: copy its node_modules (new files, so the running app's stay as they are).
  if [ -d "$from/node_modules" ] && git -C "$dir" diff --quiet "$(git -C "$from" rev-parse HEAD 2>/dev/null)" HEAD -- package-lock.json 2>/dev/null; then
    step=install; out=$(cp -a "$from/node_modules" "$dir/node_modules" 2>&1) || { why="copying node_modules failed"; logout "$out"; return 1; }
  else
    step=install; out=$(cd "$dir" && npm ci --ignore-scripts --silent 2>&1) || { why="npm ci failed"; logout "$out"; return 1; }
  fi
  step=build; out=$(cd "$dir" && npm run -s build 2>&1) || { why="build failed"; logout "$out"; return 1; }
  touch "$dir/.wayfinder-built"
}
start() {  # $1 = build folder: switch to it, restart, wait for it, smoke-test it
  local out
  step=switch; switch_to "$1" || { why="couldn't point $CURRENT at $1"; return 1; }
  step=restart
  if ! out=$(systemctl --user restart "$SERVICE" 2>&1); then
    if bus_ok; then why="systemctl --user restart $SERVICE failed"; else why="$BUS_HINT"; step=restart-bus; fi
    logout "$out"; return 1
  fi
  step=ready; ready || {
    why="server did not answer on port $PORT within 45 s"
    logout "$(systemctl --user show "$SERVICE" -p ActiveState,SubState,Result,ExecMainStatus 2>&1)"; return 1  # state only: the journal may hold private data
  }
  step=smoke; out=$(cd "$1" && npx tsx ops/smoke.ts 2>&1) || { why="smoke test failed"; logout "$out"; return 1; }
}
is_build() { [[ "$(basename "$1")" =~ ^[0-9a-f]{12}$ ]] && { [ -f "$1/.wayfinder-built" ] || git worktree list --porcelain | grep -qxF "worktree $1"; }; }
prune() {  # keep the running build and the one before it ($1); only folders this script built are removed
  local d keep_a keep_b; keep_a=$(readlink "$CURRENT"); keep_b="$1"
  for d in "$BUILDS"/*/; do
    d=${d%/}
    [ -L "$d" ] && continue   # `current` itself
    [ "$d" = "$keep_a" ] || [ "$d" = "$keep_b" ] && continue
    is_build "$d" && { git worktree remove --force "$d" 2>/dev/null || rm -rf "$d"; }
  done
  git worktree prune
}

mkdir -p "$BUILDS"
old_dir=$(running_dir)
log "deploying ${new:0:7} (was ${old:0:7})"
# The build runs next to the app, which keeps answering; a failed build changes nothing that runs.
if ! build "$new"; then
  log "deploy of ${new:0:7} FAILED at $step: $why; nothing changed, still running ${old:0:7}"
  status false "update ${new:0:7} failed at $step ($why); still running ${old:0:7}"
  notify "Wayfinder update failed" "Update ${new:0:7} failed at $step ($why). Nothing changed; still running ${old:0:7}. Details: deploy.log."
  exit 0
fi
[ -L "$CURRENT" ] || switch_to "$old_dir" || { log "couldn't create $CURRENT"; status false "update ${new:0:7} not installed: couldn't create $CURRENT"; exit 0; }
run_from_current || { log "couldn't write the systemd drop-in $DROPIN"; status false "update ${new:0:7} not installed: couldn't set the service to run from $CURRENT"; exit 0; }
if ! quiet; then   # no answers running, and new ones held until the new server is up
  release_answers
  log "deploy of ${new:0:7} stopped: couldn't write $DATA/updating.json to hold new answers; nothing changed, still running ${old:0:7}"
  status false "update ${new:0:7} not installed: couldn't hold new answers for the restart; still running ${old:0:7}"
  notify "Wayfinder update not installed" "Update ${new:0:7} couldn't hold new answers for the restart, so it didn't restart. Still running ${old:0:7}. Details: deploy.log."
  exit 0
fi
dir=$BUILT
if start "$dir"; then
  release_answers
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    log "the checkout has local changes, so it stays where it is (the app runs from $dir either way)"
  elif ! git merge -q --ff-only "$new" >/dev/null 2>&1; then
    log "the checkout can't fast-forward to ${new:0:7}, so it stays where it is (the app runs from $dir either way)"
  fi
  prune "$old_dir"
  log "deployed ${new:0:7}"; status true "deployed"; exit 0
fi
log "deploy of ${new:0:7} FAILED at $step: $why"
first="$step: $why"; nobus=$([ "$step" = restart-bus ] && echo 1)
log "rolling back to ${old:0:7}"
if start "$old_dir"; then
  release_answers
  log "rolled back to ${old:0:7}"
  status false "update ${new:0:7} failed at ${first%%:*} and was rolled back"
  notify "Wayfinder update failed" "Update ${new:0:7} failed ($first) and was rolled back to ${old:0:7}. Details: deploy.log."
  exit 0
fi
release_answers
log "rollback to ${old:0:7} FAILED at $step: $why"
v=$(running_version)
if [ -n "$nobus" ] && [ "$step" = restart-bus ] && [ -n "$v" ]; then
  # Neither restart reached systemd, so the old server never stopped (it still runs from its own folder).
  log "not restarted, still running $v"
  status false "update ${new:0:7} not restarted: can't reach systemd, still running $v"
  notify "Wayfinder update stuck" "Can't restart the app to install ${new:0:7}: the systemd user bus is missing. Fix: sudo systemctl restart user@$(id -u). Still running $v."
else
  up=$([ -n "$v" ] && echo "the app answers as $v" || echo "the app isn't answering")
  status false "update ${new:0:7} and rollback both failed (rollback at $step)"
  notify "Wayfinder update and rollback failed" "Update ${new:0:7} failed ($first), and rollback to ${old:0:7} failed too ($step: $why); $up. Details: deploy.log."
fi
}
main "$@"
