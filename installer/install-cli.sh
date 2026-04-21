#!/usr/bin/env bash
# install-cli.sh — standalone UM CLI installer (no server required)
#
# Public install URL (pinned per release tag):
#   curl -fsSL https://github.com/goldenwo/universal-memory/releases/download/<TAG>/install-cli.sh | bash
# Latest stable linked from README "Install" section.
#
# Canonical managed block (env-sourced per RH5 R2-round):
#   - UM_OPENAI_API_KEY (empty when CLI-only; set if summaries wanted)
#   - UM_SUMMARIZER
#   - UM_SERVER_URL
#   - UM_LIB_DIR
#   - UM_CLI_DIR
#   - PATH guard for $HOME/.local/bin

set -euo pipefail

# --- script location ---
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

info()  { printf '\033[1;34m[install-cli]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install-cli]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install-cli]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install-cli]\033[0m %s\n' "$*" >&2; exit 1; }

# --- flags ---
YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --help|-h)
      cat <<EOF
Usage: install-cli.sh [--yes]
  --yes, -y    Non-interactive install (skip confirmation prompts)

Installs the 'um' CLI dispatcher and libraries to:
  \$HOME/.local/share/um/{lib,cli}
  \$HOME/.local/bin/um (symlink)
EOF
      exit 0
      ;;
  esac
done

# --- preflight: python3 ---
if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 is required.
  Install: apt install python3 (Ubuntu) | brew install python3 (macOS) | dnf install python3 (Fedora)"
fi

# --- preflight: pyyaml ---
if ! python3 -c 'import yaml' 2>/dev/null; then
  fail "python3 yaml module is required.
  Install: apt install python3-yaml | brew install python-yaml | pip3 install pyyaml"
fi

# --- target layout ---
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/um"
LIB_DIR="${UM_LIB_DIR:-$DATA_DIR/lib}"
CLI_DIR="${UM_CLI_DIR:-$DATA_DIR/cli}"

mkdir -p "$BIN_DIR" "$LIB_DIR" "$CLI_DIR"

# --- copy libs ---
if [ -d "$REPO_ROOT/installer/um-cli/lib" ]; then
  cp -p "$REPO_ROOT/installer/um-cli/lib/"*.sh "$LIB_DIR/" 2>/dev/null || true
  ok "Libraries installed to: $LIB_DIR"
elif [ -d "$REPO_ROOT/plugins/claude-code/universal-memory/hooks/lib" ]; then
  # Fallback to plugin-embedded libs if installer/um-cli/ not present
  cp -p "$REPO_ROOT/plugins/claude-code/universal-memory/hooks/lib/"*.sh "$LIB_DIR/" 2>/dev/null || true
  ok "Libraries installed to: $LIB_DIR (from hooks/lib fallback)"
else
  fail "Cannot find library source (installer/um-cli/lib or plugins/.../hooks/lib)"
fi

# --- copy CLI subcommand scripts ---
PLUGIN_BIN="$REPO_ROOT/plugins/claude-code/universal-memory/bin"
COPIED_SCRIPTS=0
for script in um um-capture um-search.sh um-state.sh um-recent.sh um-list.sh um-capture.sh um-tail.sh um-forget um-supersede um-preview; do
  if [ -f "$PLUGIN_BIN/$script" ]; then
    cp -p "$PLUGIN_BIN/$script" "$CLI_DIR/$script"
    chmod +x "$CLI_DIR/$script"
    COPIED_SCRIPTS=$((COPIED_SCRIPTS + 1))
  fi
done
ok "CLI scripts installed: $COPIED_SCRIPTS scripts to $CLI_DIR"

# --- copy dispatcher + plugin.json into BIN_DIR ---
# The `um` script resolves its own SCRIPT_DIR at runtime via BASH_SOURCE[0].
# If `um` is invoked through a symlink, BASH_SOURCE[0] is the symlink path, so
# PLUGIN_DIR = dirname(symlink)/.. — which is wrong for the data layout.
# Simplest portable fix: copy `um` directly into BIN_DIR so SCRIPT_DIR = BIN_DIR
# and PLUGIN_DIR = BIN_DIR/.. = $HOME/.local.
# plugin.json must live at PLUGIN_DIR/.claude-plugin/plugin.json = ~/.local/.claude-plugin/plugin.json
PLUGIN_JSON_SRC="$REPO_ROOT/plugins/claude-code/universal-memory/.claude-plugin/plugin.json"
if [ -f "$PLUGIN_JSON_SRC" ]; then
  mkdir -p "$BIN_DIR/../.claude-plugin"
  cp -p "$PLUGIN_JSON_SRC" "$BIN_DIR/../.claude-plugin/plugin.json"
  ok "plugin.json installed to: $BIN_DIR/../.claude-plugin/plugin.json"
fi

# Copy um dispatcher directly into BIN_DIR (not symlink — see rationale above).
if [ -f "$CLI_DIR/um" ]; then
  cp -p "$CLI_DIR/um" "$BIN_DIR/um"
  chmod +x "$BIN_DIR/um"
  ok "Dispatcher installed: $BIN_DIR/um"
fi

# --- write marker block to shell rc files ---
source "$REPO_ROOT/installer/lib/marker-block.sh"

_RC_UPDATED=0
for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
  # Only write if the rc file already exists OR matches the user's default shell
  case "$rc" in
    "${HOME}/.bashrc")
      [ -f "$rc" ] || [ "${SHELL##*/}" = "bash" ] || continue
      ;;
    "${HOME}/.zshrc")
      [ -f "$rc" ] || [ "${SHELL##*/}" = "zsh" ] || continue
      ;;
  esac
  touch "$rc"
  # key + summarizer empty — leave env-defaults (env-sourced contract)
  _write_marker_block "$rc" "" ""
  ok "Shell profile updated: $rc"
  _RC_UPDATED=$((_RC_UPDATED + 1))
done

if [ "$_RC_UPDATED" -eq 0 ]; then
  warn "Could not detect shell rc file — add the following to your shell profile manually:"
  warn "  export UM_SERVER_URL='${UM_SERVER_URL:-http://localhost:6335}'"
  warn "  export UM_LIB_DIR='$LIB_DIR'"
  warn "  export UM_CLI_DIR='$CLI_DIR'"
  warn "  case \":\$PATH:\" in *\":\$HOME/.local/bin:\"*) ;; *) export PATH=\"\$HOME/.local/bin:\$PATH\" ;; esac"
fi

echo ""
ok "um installed to: $CLI_DIR"
ok "Dispatcher installed: $BIN_DIR/um"
ok "Libraries: $LIB_DIR"
echo ""
info "Open a new shell (or run 'source ~/.bashrc' / 'source ~/.zshrc') to pick up the env."
info "Verify with: um --version"
