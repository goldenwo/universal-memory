#!/usr/bin/env bash
# install-plugin-antigravity.sh — Antigravity plugin installer (#410)
#
# Antigravity loads the same plugin folder Claude Code and Codex get
# (plugins/claude-code/universal-memory): it reads .antigravity-plugin/plugin.json
# and the hooks.json at the folder's root. This hands that folder to
# Antigravity's own CLI:
#   agy plugin validate <folder>
#   agy plugin uninstall universal-memory     (a failure here is ignored)
#   agy plugin install <folder>
#
# Why three steps. `agy plugin install <folder>` COPIES the folder to
# ~/.gemini/config/plugins/universal-memory (agy 1.5.3, measured 2026-11-09),
# so an update has to replace that copy: uninstall, then install. Validating
# first means a folder Antigravity would refuse never removes a working plugin.
# Installing over an existing copy, and `agy plugin link`, are not measured.
#
# Every agy call reads /dev/null, not this script's stdin. Whether install or
# uninstall can ask a question is not known (none was seen); with no stdin a
# question fails at once instead of waiting.
#
# The hooks read ~/.um/endpoint and ~/.um/auth-token. `install.sh --remote`
# writes both; a server installed on the same machine writes only the token
# (and a UM_SERVER_URL export in the shell rc, which a hook started by agy from
# PowerShell never sees). With no endpoint file the hooks still send turns to
# http://localhost:6335 but inject no state and run no search, and nothing in
# the session shows it, so the closing lines say so when the file is missing.
# Measured on the Antigravity CLI on Windows only; macOS, Linux, and the
# Antigravity app and IDE are not.
#
# Usage:
#   bash installer/install-plugin-antigravity.sh [--yes]
#
# Environment overrides:
#   UM_PLUGIN_DIR   The plugin folder to install (default: this checkout's
#                   plugins/claude-code/universal-memory)
#   _UM_REPO_ROOT   Override repo root detection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${_UM_REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")}"

info()  { printf '\033[1;34m[install-plugin-antigravity]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install-plugin-antigravity]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install-plugin-antigravity]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install-plugin-antigravity]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── CLI args ────────────────────────────────────────────────────────────────
# --yes is accepted for the dispatcher's sake; nothing here prompts.
# --server-url is accepted and ignored: the hooks read ~/.um/endpoint.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ;;
    --server-url) shift ;;
    *) : ;;  # pass-through unknown flags silently
  esac
  shift
done

if [ -z "${HOME:-}" ]; then
  fail "HOME is not set — cannot locate Antigravity's folder (~/.gemini/antigravity-cli)"
fi

_PLUGIN_SRC="${UM_PLUGIN_DIR:-$REPO_ROOT/plugins/claude-code/universal-memory}"
[ -f "$_PLUGIN_SRC/.antigravity-plugin/plugin.json" ] \
  || fail "No Antigravity plugin at $_PLUGIN_SRC (.antigravity-plugin/plugin.json is missing) — is this a full repo checkout?"

# agy.exe is a native Windows program: under Git Bash it needs the folder as a
# Windows path. Elsewhere the path is passed as it is.
_PLUGIN_ARG="$_PLUGIN_SRC"
if command -v cygpath >/dev/null 2>&1; then
  _PLUGIN_ARG=$(cygpath -w "$_PLUGIN_SRC")
fi

# _find_agy — prints the agy to run. On PATH first; on Windows the installer
# puts it under %LOCALAPPDATA%\agy\bin, which Git Bash's PATH usually lacks.
_find_agy() {
  if command -v agy >/dev/null 2>&1; then
    command -v agy
    return 0
  fi
  if [ -n "${LOCALAPPDATA:-}" ]; then
    local base="$LOCALAPPDATA"
    if command -v cygpath >/dev/null 2>&1; then base=$(cygpath -u "$LOCALAPPDATA"); fi
    if [ -x "$base/agy/bin/agy.exe" ]; then
      printf '%s\n' "$base/agy/bin/agy.exe"
      return 0
    fi
  fi
  return 1
}

_print_commands() {
  warn "  agy plugin validate \"$_PLUGIN_ARG\""
  warn "  agy plugin uninstall universal-memory"
  warn "  agy plugin install \"$_PLUGIN_ARG\""
}

_AGY=""
if ! _AGY=$(_find_agy); then
  if [ -d "$HOME/.gemini/antigravity-cli" ]; then
    warn "Antigravity's CLI (agy) was not found on PATH or under %LOCALAPPDATA%\\agy\\bin. Find it, then run:"
    _print_commands
  else
    info "Antigravity not detected (no agy on PATH, no ~/.gemini/antigravity-cli) — skipping Antigravity plugin install."
  fi
  exit 0
fi

info "Checking the plugin folder with Antigravity ($_PLUGIN_ARG)..."
_validate_out=""
if ! _validate_out=$("$_AGY" plugin validate "$_PLUGIN_ARG" </dev/null 2>&1); then
  printf '%s\n' "$_validate_out" >&2
  fail "agy plugin validate refused the folder. Nothing was changed: an installed universal-memory plugin is still in place."
fi

# Replace any earlier copy. No earlier copy makes this fail, which is fine.
"$_AGY" plugin uninstall universal-memory </dev/null >/dev/null 2>&1 || true

if ! "$_AGY" plugin install "$_PLUGIN_ARG" </dev/null; then
  warn "agy plugin install failed. Any earlier copy of the plugin was removed just before, so Antigravity has none now. To finish, run:"
  warn "  agy plugin install \"$_PLUGIN_ARG\""
  exit 1
fi

ok "Antigravity plugin installed. It takes effect in the next conversation; nothing else to set up."
ok "After a universal-memory update, run this again. To remove it: agy plugin uninstall universal-memory"

# UM_SERVER_URL in this shell does not count: agy's hooks run in their own
# shell and read the file.
if [ ! -s "$HOME/.um/endpoint" ]; then
  warn "No server address is saved yet (~/.um/endpoint is missing). Turns will be sent to http://localhost:6335, but no project state or memory will be injected until one is saved. Save it with:"
  warn "  bash installer/install.sh --remote <server URL>     (http://localhost:6335 for a server on this machine)"
fi
