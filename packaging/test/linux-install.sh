#!/usr/bin/env bash
# Install test on a clean Linux (or macOS with --host): packs two releases from this checkout (the current version, and the same code as
# version +0.0.1), then in a fresh ubuntu:24.04 container, as a normal user with no Node: install (Node via nvm),
# start, doctor, install again (nothing changes), update while running, stop.
# Needs Node 22, git and Docker on the host. Usage: bash packaging/test/linux-install.sh [image]
# Without Docker: bash packaging/test/linux-install.sh --host runs the same steps on this machine, with an empty home
# folder and a PATH that hides Node and npm (so the installer still has to fetch Node).
set -euo pipefail
image="${1:-ubuntu:24.04}"
cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
v1=$(node -p "require('./package.json').version")
v2=$(node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number);[a,b,c+1].join('.')")
[ -f dist/web/index.html ] || npm run -s build >/dev/null 2>&1
bash packaging/pack.sh test-owner/wayfinder "$work/p1" >/dev/null
# The second release: same code, next version number (package.json and the changelog's top entry).
cp package.json changelog.json "$work/"
node -e "const f=require('fs');const p=JSON.parse(f.readFileSync('package.json'));p.version='$v2';f.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');const c=JSON.parse(f.readFileSync('changelog.json'));c.unshift({...c[0],version:'$v2'});f.writeFileSync('changelog.json',JSON.stringify(c,null,2)+'\n')"
bash packaging/pack.sh test-owner/wayfinder "$work/p2" >/dev/null || { cp "$work/package.json" "$work/changelog.json" .; exit 1; }
cp "$work/package.json" "$work/changelog.json" .
rel="$work/rel"; mkdir -p "$rel/latest/download" "$rel/download/v$v1" "$rel/download/v$v2"
for f in "wayfinder-$v1.tgz" install.sh install.ps1 SHA256SUMS; do cp "$work/p1/$f" "$rel/download/v$v1/"; cp "$work/p1/$f" "$rel/latest/download/"; done
for f in "wayfinder-$v2.tgz" install.sh install.ps1 SHA256SUMS; do cp "$work/p2/$f" "$rel/download/v$v2/"; done
# A third release that can't start (its server throws), to check that update goes back and then skips it.
v3=$(node -p "const [a,b,c]='$v2'.split('.').map(Number);[a,b,c+1].join('.')")
mkdir -p "$work/p3" "$rel/download/v$v3" && tar -xzf "$work/p2/wayfinder-$v2.tgz" -C "$work/p3"
mv "$work/p3/wayfinder-$v2" "$work/p3/wayfinder-$v3"
sed -i.bak "s/\"version\": \"$v2\"/\"version\": \"$v3\"/" "$work/p3/wayfinder-$v3/package.json"
{ echo 'throw new Error("this test release is broken on purpose");'; cat "$work/p3/wayfinder-$v3/src/server/main.ts"; } >"$work/p3/m.ts"
mv "$work/p3/m.ts" "$work/p3/wayfinder-$v3/src/server/main.ts"; rm -f "$work/p3/wayfinder-$v3/package.json.bak"
(cd "$work/p3" && tar -czf "$rel/download/v$v3/wayfinder-$v3.tgz" "wayfinder-$v3")
(cd "$rel/download/v$v3" && { command -v sha256sum >/dev/null && sha256sum "wayfinder-$v3.tgz" || shasum -a 256 "wayfinder-$v3.tgz"; } >SHA256SUMS)
chmod -R a+rX "$rel"

if [ "$image" = --host ]; then
  mkdir -p "$work/home" "$work/bin"
  for f in /usr/local/bin/* /usr/bin/* /bin/*; do
    case "$(basename "$f")" in node|nodejs|npm|npx|corepack) ;; *) [ -e "$work/bin/$(basename "$f")" ] || ln -s "$f" "$work/bin/"; esac
  done
  prep=""; as_cmd="env -i HOME=$work/home PATH=$work/bin USER=\$(id -un) WAYFINDER_DOWNLOAD_BASE=file://$rel WAYFINDER_SANDBOX=off WAYFINDER_PORT=$((20000 + RANDOM % 20000)) sh -c"
  R="$rel"; H="$work/home"
else
  prep="export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null"
  as_cmd="su - ubuntu -c"; R=/rel; H='$(getent passwd ubuntu | cut -d: -f6)'   # the image's normal user, read inside
fi

cat >"$work/inside.sh" <<IN
set -eu
$prep
echo "== \$( (. /etc/os-release && echo "\$PRETTY_NAME") 2>/dev/null || sw_vers -productName 2>/dev/null), node for the installer: \$(PATH=${work}/bin command -v node || echo none)"
to=\$(command -v timeout >/dev/null && echo "timeout 600" || true)
as() { \$to $as_cmd "export WAYFINDER_DOWNLOAD_BASE=file://$R WAYFINDER_SANDBOX=off; \$1"; }
echo "== install (no Node yet)"; as 'sh $R/latest/download/install.sh --yes'
W=$H/.local/bin/wayfinder
echo "== start";   as "\$W start"
echo "== status";  as "\$W status"
echo "== token";   as "\$W token | wc -c"
echo "== doctor";  as "\$W doctor" || echo "(doctor exit \$?)"
echo "== folders"; stat -c '%a %n' $H/wayfinder-data $H/.config/wayfinder $H/.config/wayfinder/secrets.json 2>/dev/null || stat -f '%Lp %N' $H/wayfinder-data $H/.config/wayfinder $H/.config/wayfinder/secrets.json
echo "== install again"; as 'sh $R/latest/download/install.sh --yes' | head -3
echo "== publish $v2, then update"; cp $R/download/v$v2/* $R/latest/download/
as "\$W update --check"; as "\$W update"
echo "== status";  as "\$W status" | head -2
echo "== publish $v3 (broken), then update: it should go back to $v2"; cp $R/download/v$v3/* $R/latest/download/
as "\$W update" && { echo "UNEXPECTED: the broken update succeeded"; exit 1; } || true
as "\$W status" | head -1
echo "== update again: it should skip $v3"; as "\$W update" || true
echo "== stop";    as "\$W stop"; as "\$W status" | head -1
ls $H/.local/share/wayfinder
IN
if [ "$image" = --host ]; then
  # Whatever happens, stop the test server: a running one would keep this job (and its caller) waiting.
  # shellcheck disable=SC2154 # p is assigned inside the trap
  trap 'p=$(cat "$H/wayfinder-data/wayfinder.pid" 2>/dev/null) && kill "$p" 2>/dev/null; rm -rf "$work"' EXIT
  bash "$work/inside.sh"
else docker run --rm -v "$rel:/rel" -v "$work/inside.sh:/inside.sh:ro" "$image" bash /inside.sh; fi
