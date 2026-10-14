#!/usr/bin/env bash
# install-plugin-cc.sh — Claude Code plugin installer
#
# Claude Code loads plugins only from its marketplace, so this registers the
# plugin through the `claude` CLI, with the same two commands the README gives:
#   claude plugin marketplace add goldenwo/universal-memory
#   claude plugin install universal-memory@universal-memory
# and refreshes both when they are already there (each step is idempotent).
# Until 2026-10 it copied the plugin into ~/.claude/plugins/universal-memory, a
# directory Claude Code never reads: `claude plugin list` said "No plugins
# installed" right after it ran.
#
# It also installs the optional claude-mem bridge (um-bridge-claude-mem) into
# ~/.local/share/um/bridge with its native dependency, linked from ~/.local/bin.
# The plugin's own directory is a versioned cache that Claude Code replaces on
# every update, and its bridge modules are dev-tree shims, so the bridge cannot
# run from there.
#
# Usage:
#   bash installer/install-plugin-cc.sh [--yes]
#
# Environment overrides:
#   UM_PLUGIN_MARKETPLACE  Marketplace source (default goldenwo/universal-memory;
#                          a local checkout path works too)
#   UM_BRIDGE_DIR          Bridge install dir (default ~/.local/share/um/bridge)
#   CLAUDE_PLUGINS_DIR     Override ~/.claude/plugins (used only to spot an old copy)
#   _UM_REPO_ROOT          Override repo root detection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${_UM_REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")}"

info()  { printf '\033[1;34m[install-plugin-cc]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install-plugin-cc]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install-plugin-cc]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install-plugin-cc]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── CLI args ────────────────────────────────────────────────────────────────
# --yes is accepted for the dispatcher's sake; nothing here prompts any more.
# --server-url is accepted and ignored: /um-setup configures the endpoint.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ;;
    --server-url) shift ;;
    *) : ;;  # pass-through unknown flags silently
  esac
  shift
done

if [ -z "${HOME:-}" ]; then
  fail "HOME is not set — cannot locate ~/.claude or ~/.local"
fi

_PLUGIN_SRC="$REPO_ROOT/plugins/claude-code/universal-memory"
[ -d "$_PLUGIN_SRC" ] || fail "Plugin source not found at $_PLUGIN_SRC — is this a full repo checkout?"
_MARKETPLACE="${UM_PLUGIN_MARKETPLACE:-goldenwo/universal-memory}"

# ─── Plugin: the marketplace route ───────────────────────────────────────────
_register_plugin() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "Claude Code's CLI (claude) is not on PATH. Install Claude Code, then run:"
    warn "  claude plugin marketplace add $_MARKETPLACE"
    warn "  claude plugin install universal-memory@universal-memory"
    return 0
  fi
  info "Registering the plugin with Claude Code (marketplace: $_MARKETPLACE)..."
  claude plugin marketplace add "$_MARKETPLACE" >/dev/null \
    || fail "claude plugin marketplace add $_MARKETPLACE failed"
  # Pull the newest marketplace revision so an existing install moves forward.
  claude plugin marketplace update universal-memory >/dev/null 2>&1 \
    || warn "claude plugin marketplace update failed — installing from the copy already on disk"
  claude plugin install universal-memory@universal-memory >/dev/null \
    || fail "claude plugin install universal-memory@universal-memory failed"
  claude plugin update universal-memory@universal-memory >/dev/null 2>&1 || true
  ok "Claude Code plugin installed. Next: run /um-setup inside Claude Code (restart it first if it is open)."
}

# An install from the old copy route leaves a directory Claude Code ignores and
# may have exported UM_PROMPT_DIR into it, which pins the hooks' prompts to that
# stale copy. Say so; don't delete the user's files.
_warn_old_copy() {
  local old="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/universal-memory"
  if [ -e "$old" ] || [ -L "$old" ]; then
    warn "$old is a copy from an older installer; Claude Code does not load it."
    warn "  Remove it when convenient: rm -rf '$old'"
  fi
  if [ -n "${UM_PROMPT_DIR:-}" ] && [[ "$UM_PROMPT_DIR" == "$old"* ]]; then
    warn "UM_PROMPT_DIR points into that old copy ($UM_PROMPT_DIR); remove its export from your shell rc so the hooks use the plugin's own prompts."
  fi
}

# ─── Optional: the claude-mem bridge CLI ─────────────────────────────────────
_install_bridge() {
  local src="$_PLUGIN_SRC/bin"
  local dir="${UM_BRIDGE_DIR:-$HOME/.local/share/um/bridge}"
  local link="$HOME/.local/bin/um-bridge-claude-mem"
  if ! command -v node >/dev/null 2>&1; then
    info "node not found — skipping the optional claude-mem bridge (um-bridge-claude-mem)."
    return 0
  fi
  mkdir -p "$dir/lib" "$HOME/.local/bin"
  cp "$src/um-bridge-claude-mem" "$src/translate.mjs" "$src/package.json" "$dir/"
  chmod +x "$dir/um-bridge-claude-mem"
  # The plugin tree's lib/*.mjs are dev shims that re-export from server/lib;
  # the bridge needs the real modules next to it.
  cp "$REPO_ROOT/server/lib/bridge-contract.mjs" "$dir/lib/bridge-contract.mjs"
  cp "$REPO_ROOT/server/lib/lockdir.mjs"          "$dir/lib/lockdir.mjs"

  if [ -L "$link" ] || [ -e "$link" ]; then rm -f "$link"; fi
  if ln -s "$dir/um-bridge-claude-mem" "$link" 2>/dev/null && [ -L "$link" ]; then
    ok "um-bridge-claude-mem linked: $link -> $dir/um-bridge-claude-mem"
  else
    # git-bash on Windows copies on `ln -s`; a launcher keeps the script's own
    # directory (and so its ./lib imports) intact.
    rm -f "$link"
    printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$dir/um-bridge-claude-mem" > "$link"
    chmod +x "$link"
    ok "um-bridge-claude-mem launcher written: $link"
  fi

  # better-sqlite3 needs a native build; failure leaves the bridge unusable but
  # the plugin unaffected.
  if ( cd "$dir" && npm install --omit=dev --loglevel=error >/dev/null 2>&1 ); then
    ok "Bridge dependencies installed (better-sqlite3)."
  else
    warn "um-bridge-claude-mem native build failed (better-sqlite3 needs python3, make and a compiler)."
    warn "  The bridge stays unavailable until: cd '$dir' && npm install"
  fi
}

_register_plugin
_warn_old_copy
_install_bridge
