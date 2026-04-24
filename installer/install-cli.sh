#!/usr/bin/env bash
# install-cli.sh — standalone UM CLI installer (repo-local, NOT curl|bash)
#
# Requires a full repo clone on disk. Run from the repo root:
#   bash installer/install-cli.sh [--yes]
#
# A future release may add self-bootstrap for curl|bash. Until then, clone first.
#
# Canonical managed block (env-sourced per RH5 R2-round):
#   - UM_OPENAI_API_KEY (empty when CLI-only; set if summaries wanted)
#   - UM_SUMMARIZER
#   - UM_SERVER_URL
#   - UM_LIB_DIR
#   - UM_CLI_DIR
#   - PATH guard for $HOME/.local/bin

set -euo pipefail
: "${HOME:?HOME is not set; set HOME and re-run}"

# --- script location ---
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

info()  { printf '\033[1;34m[install-cli]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install-cli]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install-cli]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install-cli]\033[0m %s\n' "$*" >&2; exit 1; }

# --- flags ---
YES=0
NO_PATH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --no-path) NO_PATH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --server-url) UM_SERVER_URL="${2:?--server-url requires a URL argument}"; shift ;;
    --um-install-dir) DATA_DIR="${2:?--um-install-dir requires a path}"; shift ;;
    --vault-dir) UM_VAULT_DIR="${2:?--vault-dir requires a path}"; shift ;;
    --help|-h)
      cat <<EOF
Usage: install-cli.sh [--yes] [--no-path] [--server-url URL]
  --yes, -y          Non-interactive install (skip confirmation prompts)
  --no-path          Skip PATH/shell-rc modification
  --server-url URL   Override UM server URL written to shell profile

Installs the 'um' CLI dispatcher and libraries to:
  \$HOME/.local/share/um/{lib,cli}
  \$HOME/.local/bin/um (symlink)
EOF
      exit 0
      ;;
    *) echo "[install-cli] unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# --- dry-run guard ---
# When invoked by the parent installer with --dry-run, print intent and exit.
if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
  info "[dry-run] would install um CLI (libs, dispatcher, shell profile block)"
  exit 0
fi

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
DATA_DIR="${DATA_DIR:-${HOME}/.local/share/um}"
LIB_DIR="${UM_LIB_DIR:-$DATA_DIR/lib}"
CLI_DIR="${UM_CLI_DIR:-$DATA_DIR/cli}"

mkdir -p "$BIN_DIR" "$LIB_DIR" "$CLI_DIR"

# --- copy libs ---
# Single source of truth: always copy from plugins/.../hooks/lib.
# installer/um-cli/lib/ was removed (SCALE-3) — it was a byte-copy that silently went stale.
PLUGIN_LIB_SRC="$REPO_ROOT/plugins/claude-code/universal-memory/hooks/lib"
if [ ! -d "$PLUGIN_LIB_SRC" ]; then
  fail "Cannot find library source: $PLUGIN_LIB_SRC (is this a full repo clone?)"
fi
cp -p "$PLUGIN_LIB_SRC/"*.sh "$LIB_DIR/"
copied_count=$(ls -1 "$LIB_DIR"/*.sh 2>/dev/null | wc -l)
if [ "$copied_count" -lt 3 ]; then
  echo "install-cli.sh: library copy failed — only $copied_count files in $LIB_DIR" >&2
  exit 1
fi
ok "Libraries installed to: $LIB_DIR ($copied_count files)"

# --- copy CLI subcommand scripts ---
PLUGIN_BIN="$REPO_ROOT/plugins/claude-code/universal-memory/bin"
COPIED_SCRIPTS=0
for script in um um-capture um-search.sh um-state.sh um-recent.sh um-list.sh um-capture.sh um-tail.sh um-forget um-supersede um-preview um-tunnel; do
  if [ -f "$PLUGIN_BIN/$script" ]; then
    cp -p "$PLUGIN_BIN/$script" "$CLI_DIR/$script"
    chmod +x "$CLI_DIR/$script"
    COPIED_SCRIPTS=$((COPIED_SCRIPTS + 1))
  fi
done
if [ "$COPIED_SCRIPTS" -lt 3 ]; then
  echo "install-cli.sh: subcommand script copy failed — only $COPIED_SCRIPTS scripts in $CLI_DIR" >&2
  exit 1
fi
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

if [ "${NO_PATH:-0}" -eq 1 ]; then
  info "--no-path set: skipping shell profile modification."
else
  _RC_UPDATED=0
  _sh="${SHELL:-}"
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
    # Only write if the rc file already exists OR matches the user's default shell.
    # Use _sh (default-empty) instead of ${SHELL##*/} to avoid "unbound variable"
    # abort under set -u when SHELL is unset (cron, systemd-run, minimal containers).
    case "$rc" in
      "${HOME}/.bashrc")
        [ -f "$rc" ] || [ "${_sh##*/}" = "bash" ] || continue
        ;;
      "${HOME}/.zshrc")
        [ -f "$rc" ] || [ "${_sh##*/}" = "zsh" ] || continue
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
fi

echo ""
ok "um installed to: $CLI_DIR"
ok "Dispatcher installed: $BIN_DIR/um"
ok "Libraries: $LIB_DIR"
echo ""
info "Open a new shell (or run 'source ~/.bashrc' / 'source ~/.zshrc') to pick up the env."
info "Verify with: um --version"
