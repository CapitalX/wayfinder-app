#!/bin/sh
# Installs Wayfinder for this user (no sudo, except to install Node if you ask for that):
#   curl -fsSL https://github.com/__PUBLIC_REPO__/releases/latest/download/install.sh | sh
# Options (after `sh -s --`): --yes (no questions, take the defaults), --version X.Y.Z, --no-service, --auto-update.
# Safe to run again: an installed version is reused, and your data and settings are never touched.
set -eu

# Everything runs from main(), called on the last line: if a download through `curl | sh` is cut off, sh never runs
# a partial script, because main is only defined once the whole file has arrived.
main() {

REPO="${WAYFINDER_REPO:-__PUBLIC_REPO__}"
BASE="${WAYFINDER_DOWNLOAD_BASE:-https://github.com/$REPO/releases}"
ROOT="${WAYFINDER_INSTALL_DIR:-$HOME/.local/share/wayfinder}"
BIN="${WAYFINDER_BIN_DIR:-$HOME/.local/bin}"
NVM_VERSION=v0.40.1
NVM_SHA256=abdb525ee9f5b48b34d8ed9fc67c6013fb0f659712e401ecd88ab989b3af8f53   # its install.sh, checked before it runs

yes=""; version=""; service=1; autoupdate=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) yes=1 ;;
    --version) version="${2:?--version needs a number}"; shift ;;
    --no-service) service="" ;;
    --auto-update) autoupdate=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'Wayfinder install: %s\n' "$*" >&2; exit 1; }
# Questions read the terminal even when this script arrives through a pipe. No terminal and no --yes: the default.
ask() {  # $1 = question, $2 = default (y/n)
  [ -n "$yes" ] && { [ "$2" = y ]; return; }
  if [ -r /dev/tty ] && { exec 3</dev/tty; } 2>/dev/null; then
    printf '%s [%s] ' "$1" "$([ "$2" = y ] && echo Y/n || echo y/N)" >/dev/tty
    read -r a <&3 || a=""; exec 3<&-
  else a=""; fi
  case "${a:-$2}" in y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "this installer is for Linux, macOS and WSL. On Windows, run install.ps1 in PowerShell (it uses WSL)." ;;
esac
command -v curl >/dev/null || die "curl is needed (it downloads the release)"
command -v tar >/dev/null || die "tar is needed"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# Node 22.13 or newer.
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
install_node_nvm() {
  say "Installing Node 22 with nvm (in your home folder, no sudo)…"
  command -v bash >/dev/null || die "installing Node with nvm needs bash"
  # nvm's installer is downloaded, checked against the checksum pinned above, and only then run. It installs nvm at
  # that tag, and nvm checks Node's download against nodejs.org's published checksums.
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" -o "$tmp/nvm-install.sh" \
    || die "couldn't download nvm; install Node 22 yourself (https://nodejs.org) and run this again"
  [ "$(sha256 "$tmp/nvm-install.sh")" = "$NVM_SHA256" ] || die "nvm's installer doesn't match its pinned checksum; nothing was run"
  PROFILE=/dev/null bash "$tmp/nvm-install.sh" >/dev/null 2>&1 \
    || die "couldn't install nvm; install Node 22 yourself (https://nodejs.org) and run this again"
  # nvm is a bash function and doesn't load under `set -u`, so it runs in its own bash and reports where Node is.
  n=$(NVM_DIR="${NVM_DIR:-$HOME/.nvm}" bash -c '. "$NVM_DIR/nvm.sh" && nvm install 22 >/dev/null 2>&1 && nvm which 22') \
    || die "nvm couldn't install Node 22; install it yourself (https://nodejs.org) and run this again"
  PATH="$(dirname "$n"):$PATH"
  say "Node $(node -v) installed with nvm. To use it in your own shell too, see https://github.com/nvm-sh/nvm#usage"
}
# A system-wide Node needs sudo, so this script doesn't do it: it shows the package manager's commands to run yourself.
system_node_help() {
  if command -v apt-get >/dev/null; then say "  curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh && sudo bash nodesource_setup.sh && sudo apt-get install -y nodejs"
  elif command -v dnf >/dev/null; then say "  curl -fsSL https://rpm.nodesource.com/setup_22.x -o nodesource_setup.sh && sudo bash nodesource_setup.sh && sudo dnf install -y nodejs"
  else say "  see https://nodejs.org/en/download"; fi
}
# A Node recorded by an earlier install (nvm's isn't on PATH in a new shell).
[ -x "$ROOT/node" ] && ! node_ok && PATH="$(dirname "$("$ROOT/node" -p process.execPath 2>/dev/null || echo /nonexistent/x)"):$PATH"
if ! node_ok; then
  have=$(command -v node >/dev/null && node -v || echo "no Node")
  say "Wayfinder needs Node 22.13 or newer (found: $have)."
  if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null && ask "Install Node 22 with Homebrew (brew install node@22)?" n; then
    brew install node@22 && PATH="$(brew --prefix node@22)/bin:$PATH"
  elif ask "Install Node 22 with nvm, in your home folder (no sudo)?" y; then
    install_node_nvm
  else
    say "To install Node 22 for the whole system instead (needs sudo), run this yourself, then run this installer again:"
    system_node_help
    exit 1
  fi
  node_ok || die "Node is still older than 22.13 here; install Node 22 and run this again"
fi
command -v npm >/dev/null || die "npm is missing next to Node; reinstall Node 22 with npm"
command -v git >/dev/null || say "Note: git isn't installed. Wayfinder runs without it, but Build mode needs it."


if [ -n "$version" ]; then path="download/v$version"; else path="latest/download"; fi
curl -fsSL "$BASE/$path/SHA256SUMS" -o "$tmp/SHA256SUMS" || die "couldn't download the release list from $BASE/$path"
[ -n "$version" ] || version=$(sed -n 's/.*wayfinder-\([0-9][0-9.]*\)\.tgz$/\1/p' "$tmp/SHA256SUMS" | head -1)
[ -n "$version" ] || die "the release list doesn't name a Wayfinder package"
f="wayfinder-$version.tgz"

if [ -f "$ROOT/$version/.installed" ]; then
  say "Wayfinder $version is already installed."
else
  say "Downloading Wayfinder $version…"
  curl -fsSL "$BASE/download/v$version/$f" -o "$tmp/$f" || die "couldn't download $f"
  want=$(awk -v f="$f" '$2==f||$2=="*"f{print $1}' "$tmp/SHA256SUMS")
  [ -n "$want" ] && [ "$want" = "$(sha256 "$tmp/$f")" ] || die "$f doesn't match its published checksum; nothing was installed"
  mkdir -p "$ROOT"; rm -rf "$ROOT/.$version.partial"; mkdir "$ROOT/.$version.partial"
  tar -xzf "$tmp/$f" -C "$ROOT/.$version.partial" --strip-components=1
  say "Installing its packages (no install scripts run)…"
  WAYFINDER_INSTALL_DIR="$ROOT" "$ROOT/.$version.partial/packaging/wayfinder" _finish-install "$ROOT/.$version.partial" \
    || die "installing the packages failed (network?); run this again"
  rm -rf "${ROOT:?}/$version"; mv "$ROOT/.$version.partial" "$ROOT/$version"
fi

# The version in use, the node it runs on (for services, which don't read your shell setup), and the command.
was=$(readlink "$ROOT/current" 2>/dev/null || true)
ln -sfn "$version" "$ROOT/current"
ln -sfn "$(command -v node)" "$ROOT/node"
mkdir -p "$BIN"
ln -sfn "$ROOT/current/packaging/wayfinder" "$BIN/wayfinder"
W="$BIN/wayfinder"

say ""
if [ -n "$was" ] && [ "$was" != "$version" ]; then
  say "Switched from $was to $version."
  "$W" status 2>/dev/null | grep -q '^running   yes' && { "$W" restart >/dev/null && say "Restarted it on $version."; }
fi
say "Installed Wayfinder $version"
say "  app      $ROOT/$version"
say "  command  $W"

if [ "$(uname -s)" = Linux ] && [ -n "$service" ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/wayfinder.service" ] && ! grep -q "Written by wayfinder service install" "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/wayfinder.service"; then
    say "  service  you already have your own wayfinder.service; left as it is"
  elif ask "Run Wayfinder as a background service that starts with your session?" y; then
    # Automatic updates are off unless asked for: an update runs new code next to your instance keys.
    if [ -n "$autoupdate" ] || { [ -z "$yes" ] && ask "Also install new releases by itself, daily (you can run wayfinder update yourself instead)?" n; }; then
      "$W" service install --updates | sed 's/^/  /'
    else
      "$W" service install | sed 's/^/  /'
    fi
  fi
fi

case ":$PATH:" in
  *":$BIN:"*) next="wayfinder" ;;
  *) next="$W"; say ""; say "$BIN isn't on your PATH. Add it (then open a new terminal):"
     say "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile" ;;
esac
say ""
say "Next:"
say "  $next start     # starts it and prints its address"
say "  $next token     # your login token, to paste on first sign-in"
say "  $next doctor    # checks everything, with a fix for each problem"
}

main "$@"
