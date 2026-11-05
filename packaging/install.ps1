# Installs Wayfinder on Windows, inside WSL (native Windows isn't supported):
#   irm https://github.com/CapitalX/wayfinder-app/releases/latest/download/install.ps1 | iex
# It runs install.sh in your default WSL distribution, starts Wayfinder there and opens it in your browser
# (WSL forwards localhost). Safe to run again.
# A particular version: save it and run  .\install.ps1 -Version 1.21.0  (or set WAYFINDER_VERSION before irm | iex).
# For testing: WAYFINDER_DOWNLOAD_BASE (a release folder as WSL sees it, e.g. file:///mnt/c/wf-release) and
# WAYFINDER_WSL_DISTRO (install into that distribution instead of the default one).
# Wrapped in a script block: under `irm | iex` the script runs in your own PowerShell window, where `exit` would close
# it, so every early stop is a `return`.
param([string]$Version = $env:WAYFINDER_VERSION)
& {
param([string]$Version)
$ErrorActionPreference = 'Stop'
if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+$') { Write-Host "-Version takes a release number like 1.21.0, not '$Version'."; return }
$Repo = if ($env:WAYFINDER_REPO) { $env:WAYFINDER_REPO } else { 'CapitalX/wayfinder-app' }
$Base = if ($env:WAYFINDER_DOWNLOAD_BASE) { $env:WAYFINDER_DOWNLOAD_BASE } else { "https://github.com/$Repo/releases" }
# Run inside WSL with the release address as $1 (and a version as $2, if one was asked for): download install.sh and SHA256SUMS, check the script against its
# published checksum, and only then run it. It goes to sh on stdin (Windows PowerShell mangles quotes in arguments);
# the trailing # keeps the line ending PowerShell adds out of the last command.
$Fetch = 'set -eu; t=$(mktemp -d); trap "rm -rf $t" EXIT; curl -fsSL "$1/latest/download/SHA256SUMS" -o "$t/SHA256SUMS"; curl -fsSL "$1/latest/download/install.sh" -o "$t/install.sh"; want=$(sed -n "s/^\([0-9a-f]\{64\}\)  install\.sh$/\1/p" "$t/SHA256SUMS"); got=$( (sha256sum "$t/install.sh" 2>/dev/null || shasum -a 256 "$t/install.sh") | cut -d" " -f1); if [ -z "$want" ] || [ "$want" != "$got" ]; then echo "install.sh does not match its published checksum; nothing was run" >&2; exit 1; fi; if [ -n "${2:-}" ]; then WAYFINDER_DOWNLOAD_BASE="$1" sh "$t/install.sh" --version "$2" </dev/null; else WAYFINDER_DOWNLOAD_BASE="$1" sh "$t/install.sh" </dev/null; fi; #'
$Distro = if ($env:WAYFINDER_WSL_DISTRO) { @('-d', $env:WAYFINDER_WSL_DISTRO) } else { @() }
function Invoke-Wsl([string]$Command) { & wsl.exe @Distro -e sh -c $Command }

$wslHelp = @'

Wayfinder runs inside WSL (Windows Subsystem for Linux), and no Linux distribution is set up yet.
  1. Open PowerShell as administrator and run:  wsl --install
  2. Restart Windows, open "Ubuntu" from the Start menu once and pick a user name and password.
  3. Run this installer again.
'@

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Write-Host $wslHelp; return }
# wsl.exe prints UTF-16 unless told otherwise.
$env:WSL_UTF8 = '1'
$distros = & wsl.exe --list --quiet 2>$null
if ($LASTEXITCODE -ne 0 -or -not ($distros | Where-Object { $_.Trim() })) { Write-Host $wslHelp; return }

Write-Host 'Installing Wayfinder in WSL...'
$Fetch | & wsl.exe @Distro -e sh -s -- $Base $Version
if ($LASTEXITCODE -ne 0) { Write-Host 'The install inside WSL failed; see the messages above.'; return }

Invoke-Wsl '$HOME/.local/bin/wayfinder start'
if ($LASTEXITCODE -ne 0) { Write-Host 'Wayfinder is installed but did not start; in WSL run: wayfinder doctor'; return }
$token = Invoke-Wsl '$HOME/.local/bin/wayfinder token'
Write-Host ''
Write-Host "Your login token (keep it private): $token"
Invoke-Wsl '$HOME/.local/bin/wayfinder open' | Out-Null
Write-Host 'Wayfinder is open in your browser. Next time, start it from WSL with: wayfinder start'
} $Version
