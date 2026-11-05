#!/usr/bin/env bash
# Packs a Wayfinder release from this checkout: the app (server source, built web app, lockfile; no node_modules),
# the installers and the Homebrew formula, each with the public repo's name filled in, plus SHA256SUMS.
# Usage: npm run build && bash packaging/pack.sh <owner/repo> <out-dir>
#   (the release workflow passes its own repository; locally, any owner/name works for a test)
set -euo pipefail
repo="${1:?owner/repo}"; out="${2:?output folder}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "not an owner/repo: $repo" >&2; exit 1; }
cd "$(dirname "$0")/.."
[ -f dist/web/index.html ] || { echo "build the web app first (npm run build)" >&2; exit 1; }
version=$(node -p "require('./package.json').version")
mkdir -p "$out"; out=$(cd "$out" && pwd)
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
app="$stage/wayfinder-$version"; mkdir "$app"

# What the app needs at run time: in a git checkout only committed files (a stray local file never ships; untracked
# ones stop the pack), otherwise every file under these paths (a plain copy, as on a build worker).
paths=(src ops/smoke.ts packaging package.json package-lock.json changelog.json tsconfig.json LICENSE NOTICE README.md)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  stray=$(git ls-files --others --exclude-standard -- "${paths[@]}")
  [ -z "$stray" ] || { printf 'untracked files would be left out of the release; commit or remove them first:\n%s\n' "$stray" >&2; exit 1; }
  git ls-files -z --cached -- "${paths[@]}"
else
  find "${paths[@]}" -type f -print0
fi | tar -c --null -T - -f - | tar -x -C "$app"
mkdir -p "$app/dist" && cp -R dist/web "$app/dist/web"
stamp() { sed -e "s|CapitalX/wayfinder-app|$repo|g" "$@"; }
stamp packaging/wayfinder >"$app/packaging/wayfinder"; chmod 755 "$app/packaging/wayfinder"

# Fixed owner and times, so the same commit packs to the same bytes as far as tar and gzip allow.
tar_flags=(--owner=0 --group=0 --numeric-owner)
tar --version 2>/dev/null | grep -q 'GNU tar' || tar_flags=(--uid 0 --gid 0)
(cd "$stage" && tar -c "${tar_flags[@]}" -f - "wayfinder-$version" | gzip -n -9 >"$out/wayfinder-$version.tgz")
stamp packaging/install.sh >"$out/install.sh"
stamp packaging/install.ps1 >"$out/install.ps1"

sum() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd "$out" && sum "wayfinder-$version.tgz" install.sh install.ps1 >SHA256SUMS)
mkdir -p "$out/homebrew"
sha=$(cd "$out" && sum "wayfinder-$version.tgz" | cut -d' ' -f1)
stamp -e "s|@VERSION@|$version|g" -e "s|@SHA256@|$sha|g" packaging/homebrew/wayfinder.rb.tmpl >"$out/homebrew/wayfinder.rb"
echo "packed Wayfinder $version for $repo in $out:"
(cd "$out" && ls -l wayfinder-"$version".tgz install.sh install.ps1 SHA256SUMS homebrew/wayfinder.rb | awk '{print "  "$5"\t"$NF}')
