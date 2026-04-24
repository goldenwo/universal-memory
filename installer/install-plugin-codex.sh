#!/usr/bin/env bash
# install-plugin-codex.sh — standalone Codex CLI plugin installer
#
# Extracted from server/install.sh (v0.5). Can be run standalone or via
# installer/install.sh --plugin-codex.
#
# Usage:
#   bash installer/install-plugin-codex.sh [--yes]
#
# Environment overrides:
#   CODEX_CONFIG_DIR     Override ~/.codex (detection + base)
#   CODEX_PLUGINS_DIR    Override ~/.codex/plugins
#   _UM_REPO_ROOT        Override repo root detection
#
# Skips silently if ~/.codex is absent (Codex not installed on this host).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${_UM_REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")}"

info()  { printf '\033[1;34m[install-plugin-codex]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install-plugin-codex]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install-plugin-codex]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install-plugin-codex]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── CLI args ────────────────────────────────────────────────────────────────
# --yes/-y is accepted for parent-installer passthrough compatibility but this
# script has no interactive prompts, so it's a no-op here.
for _arg in "$@"; do
  case "$_arg" in
    --yes|-y) ;;
  esac
done

# ─── Preflight ───────────────────────────────────────────────────────────────
_CODEX_PLUGIN_SRC="$REPO_ROOT/plugins/codex/universal-memory"
_CODEX_CONFIG_DIR="${CODEX_CONFIG_DIR:-${HOME:-}/.codex}"
_CODEX_PLUGIN_TARGET_BASE="${CODEX_PLUGINS_DIR:-$_CODEX_CONFIG_DIR/plugins}"
_CODEX_PLUGIN_TARGET="$_CODEX_PLUGIN_TARGET_BASE/universal-memory"

# Skip if the plugin source isn't checked out (partial clones, old tags).
if [ ! -d "$_CODEX_PLUGIN_SRC" ]; then
  info "Codex plugin source not found at $_CODEX_PLUGIN_SRC — skipping."
  exit 0
fi

# Skip silently if Codex is not installed on this host.
if [ ! -d "$_CODEX_CONFIG_DIR" ]; then
  info "Codex CLI not detected ($_CODEX_CONFIG_DIR missing) — skipping Codex plugin install."
  exit 0
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────
_read_plugin_version() {
  local dir="$1"
  local pjson
  if [ -f "$dir/.codex-plugin/plugin.json" ]; then
    pjson="$dir/.codex-plugin/plugin.json"
  elif [ -f "$dir/.claude-plugin/plugin.json" ]; then
    pjson="$dir/.claude-plugin/plugin.json"
  elif [ -f "$dir/plugin.json" ]; then
    pjson="$dir/plugin.json"
  else
    return 0
  fi
  grep '"version"' "$pjson" 2>/dev/null | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1
}

# ─── Install ─────────────────────────────────────────────────────────────────
info "Codex CLI detected at $_CODEX_CONFIG_DIR — installing Codex plugin to $_CODEX_PLUGIN_TARGET"

if ! mkdir -p "$_CODEX_PLUGIN_TARGET_BASE" 2>/dev/null; then
  warn "Could not create Codex plugin directory $_CODEX_PLUGIN_TARGET_BASE — skipping."
  exit 0
fi

# Idempotent: same version already installed → no-op.
if [ -d "$_CODEX_PLUGIN_TARGET" ] && [ ! -L "$_CODEX_PLUGIN_TARGET" ]; then
  local_src_ver=$(_read_plugin_version "$_CODEX_PLUGIN_SRC")
  local_target_ver=$(_read_plugin_version "$_CODEX_PLUGIN_TARGET")
  if [ -n "$local_src_ver" ] && [ -n "$local_target_ver" ] && [ "$local_src_ver" = "$local_target_ver" ]; then
    ok "Codex plugin v$local_target_ver already installed at $_CODEX_PLUGIN_TARGET — skipping."
    exit 0
  fi
  # Different version → replace without prompting (config-only files, no user customization).
  rm -rf "$_CODEX_PLUGIN_TARGET"
elif [ -L "$_CODEX_PLUGIN_TARGET" ]; then
  rm -f "$_CODEX_PLUGIN_TARGET"
fi

if ! cp -r "$_CODEX_PLUGIN_SRC" "$_CODEX_PLUGIN_TARGET" 2>/dev/null; then
  warn "Codex plugin copy failed ($_CODEX_PLUGIN_SRC -> $_CODEX_PLUGIN_TARGET) — install manually per plugins/codex/universal-memory/README.md"
  exit 1
fi

installed_ver=$(_read_plugin_version "$_CODEX_PLUGIN_TARGET")
ok "Codex plugin installed (v${installed_ver:-?}). See $_CODEX_PLUGIN_TARGET/README.md for rubric paste-in + verification steps."
