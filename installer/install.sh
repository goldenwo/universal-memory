#!/bin/bash
# universal-memory bootstrap installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/goldenwo/universal-memory/main/installer/install.sh | bash -s -- --yes
# or with a custom install directory:
#   curl -fsSL .../installer/install.sh | UM_INSTALL_DIR=/opt/um bash -s -- --yes
#
# Component flags (v0.5+):
#   --server        Install/start the memory server (Docker stack)
#   --plugin-cc     Install the Claude Code plugin (~/.claude/plugins/)
#   --plugin-codex  Install the Codex CLI plugin (~/.codex/plugins/)
#   --cli           Install the um CLI tool
#   --all           Install all detected components (default when no flags + non-TTY)
#   --interactive   Launch the interactive wizard (stub: falls back to --all)
#   --yes / -y      Non-interactive; accept defaults
#   --server-url U  Pass --server-url to sub-installers
#   --skip-docker   Pass --skip-docker to server installer
#   --no-path       Pass --no-path to CLI installer
#   --dry-run       Print what would happen; do not run anything

set -euo pipefail

REPO="${UM_REPO_URL:-https://github.com/goldenwo/universal-memory.git}"
INSTALL_DIR="${UM_INSTALL_DIR:-$HOME/universal-memory}"
DRY_RUN="${UM_DRY_RUN:-0}"

# ---- v0.5 flag parser -------------------------------------------------------
INSTALL_SERVER=0
INSTALL_PLUGIN_CC=0
INSTALL_PLUGIN_CODEX=0
INSTALL_CLI=0
INSTALL_ALL=0
FORCE_WIZARD=0
ASSUME_YES=0
PASSTHROUGH_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)        INSTALL_SERVER=1 ;;
    --plugin-cc)     INSTALL_PLUGIN_CC=1 ;;
    --plugin-codex)  INSTALL_PLUGIN_CODEX=1 ;;
    --cli)           INSTALL_CLI=1 ;;
    --all)           INSTALL_ALL=1 ;;
    --yes|-y)        ASSUME_YES=1; PASSTHROUGH_ARGS+=("$1") ;;
    --interactive)   FORCE_WIZARD=1 ;;
    --server-url)    UM_SERVER_URL="$2"; PASSTHROUGH_ARGS+=("$1" "$2"); shift ;;
    --skip-docker)   SKIP_DOCKER=1 ;;
    --no-path)       NO_PATH_MODIFY=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    -h|--help)       _show_help=1 ;;
    *)               PASSTHROUGH_ARGS+=("$1") ;;
  esac
  shift
done

show_help() {
  cat <<'HELP'
universal-memory installer (v0.5)

Usage: bash installer/install.sh [FLAGS]

Component flags:
  --server          Install the memory server (Docker stack)
  --plugin-cc       Install the Claude Code plugin
  --plugin-codex    Install the Codex CLI plugin (skipped if ~/.codex absent)
  --cli             Install the um CLI tool
  --all             Install all detected components

Behaviour flags:
  --yes, -y         Non-interactive; accept defaults
  --interactive     Launch the setup wizard (coming soon)
  --server-url URL  Override the server URL passed to sub-installers
  --skip-docker     Skip Docker checks (passed to server installer)
  --no-path         Skip PATH modification (passed to CLI installer)
  --dry-run         Print what would run; do nothing
  -h, --help        Show this help

If no component flag is given and stdin is not a TTY, --all is assumed (v0.4 back-compat).
HELP
}

if [[ ${_show_help:-0} -eq 1 ]]; then
  show_help
  exit 0
fi

# Mode selection
if [[ $FORCE_WIZARD -eq 1 ]]; then
  MODE=wizard
elif [[ $INSTALL_SERVER -eq 0 && $INSTALL_PLUGIN_CC -eq 0 && $INSTALL_PLUGIN_CODEX -eq 0 && $INSTALL_CLI -eq 0 && $INSTALL_ALL -eq 0 ]]; then
  if [[ -t 0 && $ASSUME_YES -eq 0 ]]; then
    MODE=wizard
  else
    # Back-compat: no flags + no TTY = v0.4 behavior (full install)
    INSTALL_ALL=1
    MODE=components
  fi
else
  MODE=components
fi

# Wizard stub — Task 3.4/3.5 will implement the real wizard
if [[ $MODE == wizard ]]; then
  echo "[install] Wizard coming soon — use --all to install everything or --help to see component flags." >&2
  # Fall back to --all in this stub
  INSTALL_ALL=1
  MODE=components
fi

if [[ $INSTALL_ALL -eq 1 ]]; then
  INSTALL_SERVER=1
  [[ -d "${HOME:-}/.claude" ]] && INSTALL_PLUGIN_CC=1
  [[ -d "${HOME:-}/.codex" ]] && INSTALL_PLUGIN_CODEX=1
  INSTALL_CLI=1
fi

printf '\nUniversal-memory installer\n==========================\n\n'

# ─── Prerequisites ────────────────────────────────────────────────────────────
# Determine which tools are actually needed based on what we're installing
NEED_GIT=0
NEED_DOCKER=0
NEED_PYTHON3=0
NEED_BASH=1  # Always needed

# Server and plugins need git + docker
[[ $INSTALL_SERVER -eq 1 || $INSTALL_PLUGIN_CC -eq 1 || $INSTALL_PLUGIN_CODEX -eq 1 ]] && NEED_GIT=1 && NEED_DOCKER=1
# CLI needs python3
[[ $INSTALL_CLI -eq 1 ]] && NEED_PYTHON3=1

missing=()
[[ $NEED_GIT -eq 1 ]] && { command -v git >/dev/null 2>&1 || missing+=("git"); }
[[ $NEED_DOCKER -eq 1 ]] && { command -v docker >/dev/null 2>&1 || missing+=("docker"); }
[[ $NEED_PYTHON3 -eq 1 ]] && { command -v python3 >/dev/null 2>&1 || missing+=("python3"); }
command -v bash >/dev/null 2>&1 || missing+=("bash")

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: required tools not found in PATH: ${missing[*]}"
  echo ""
  echo "Install hints:"
  echo "  git:     apt/brew install git, or https://git-scm.com"
  echo "  docker:  https://docs.docker.com/get-docker/"
  echo "  python3: apt/brew install python3"
  exit 1
fi

# ─── OS detection (informational) ─────────────────────────────────────────────
os_name="$(uname -s 2>/dev/null || echo unknown)"
case "$os_name" in
  Linux)  printf 'Detected OS: Linux\n' ;;
  Darwin) printf 'Detected OS: macOS\n' ;;
  MINGW*|MSYS*|CYGWIN*) printf 'Detected OS: Windows (Git Bash/MSYS)\n' ;;
  *)      printf 'Detected OS: %s (may or may not be supported)\n' "$os_name" ;;
esac

# ─── Clone or update ──────────────────────────────────────────────────────────
# Skip clone/pull if we're running from within a local repo and only installing CLI
RUNNING_FROM_LOCAL_REPO=0
SCRIPT_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -e "$SCRIPT_SELF/.git" ] || [ -e "$SCRIPT_SELF/../.git" ] || [ -e "$SCRIPT_SELF/../../.git" ]; then
  RUNNING_FROM_LOCAL_REPO=1
fi

# Only do clone/pull if needed (skip for local --cli-only installs)
if [ $INSTALL_SERVER -eq 1 ] || [ $INSTALL_PLUGIN_CC -eq 1 ] || [ $INSTALL_PLUGIN_CODEX -eq 1 ] || [ $RUNNING_FROM_LOCAL_REPO -eq 0 ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    printf 'Existing clone at %s — pulling latest...\n' "$INSTALL_DIR"
    if [ "$DRY_RUN" = "1" ]; then
      echo "[dry-run] would: git -C $INSTALL_DIR pull --ff-only"
    else
      git -C "$INSTALL_DIR" pull --ff-only
    fi
  else
    printf 'Cloning %s to %s...\n' "$REPO" "$INSTALL_DIR"
    if [ "$DRY_RUN" = "1" ]; then
      echo "[dry-run] would: git clone $REPO $INSTALL_DIR"
    else
      git clone "$REPO" "$INSTALL_DIR"
    fi
  fi
fi

# ─── Dispatcher ───────────────────────────────────────────────────────────────
# _delegate: in dry-run mode prints the delegation intent; otherwise runs the
# sub-installer with bash (NOT exec, so multiple components can run in sequence).
_delegate() {
  local script="$1"; shift
  if [[ ${DRY_RUN:-0} -eq 1 ]]; then
    echo "[install] delegate: $script${*:+ ${*}}" >&2
    return 0
  fi
  echo "[install] running: $script${*:+ ${*}}" >&2
  bash "$INSTALL_DIR/$script" "$@"
}

# Run in order: server first, then plugins, then CLI.
if [[ $INSTALL_SERVER -eq 1 ]]; then
  _delegate "server/install.sh" "${PASSTHROUGH_ARGS[@]}"
fi
if [[ $INSTALL_PLUGIN_CC -eq 1 ]]; then
  _delegate "installer/install-plugin-cc.sh" "${PASSTHROUGH_ARGS[@]}"
fi
if [[ $INSTALL_PLUGIN_CODEX -eq 1 ]]; then
  if [[ ! -d "${HOME:-}/.codex" ]]; then
    echo "[install] ~/.codex not found — soft-skipping Codex plugin" >&2
  else
    _delegate "installer/install-plugin-codex.sh" "${PASSTHROUGH_ARGS[@]}"
  fi
fi
if [[ $INSTALL_CLI -eq 1 ]]; then
  echo "[install] running: CLI installer (inline)" >&2

  # ─── CLI Installation (extracted from v0.4 install-cli.sh) ────────────────────
  # Embedded here to avoid delegation cycle when install-cli.sh is a shim.
  CLI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CLI_REPO_ROOT="$(cd "$CLI_SCRIPT_DIR/.." && pwd)"

  # Helpers
  cli_info()  { printf '\033[1;34m[install-cli]\033[0m %s\n' "$*"; }
  cli_ok()    { printf '\033[1;32m[install-cli]\033[0m %s\n' "$*"; }
  cli_warn()  { printf '\033[1;33m[install-cli]\033[0m %s\n' "$*"; }
  cli_fail()  { printf '\033[1;31m[install-cli]\033[0m %s\n' "$*" >&2; exit 1; }

  # Preflight checks
  if ! command -v python3 >/dev/null 2>&1; then
    cli_fail "python3 is required.
  Install: apt install python3 (Ubuntu) | brew install python3 (macOS) | dnf install python3 (Fedora)"
  fi

  if ! python3 -c 'import yaml' 2>/dev/null; then
    cli_fail "python3 yaml module is required.
  Install: apt install python3-yaml | brew install python-yaml | pip3 install pyyaml"
  fi

  # Target layout
  CLI_BIN_DIR="${HOME}/.local/bin"
  CLI_DATA_DIR="${HOME}/.local/share/um"
  CLI_LIB_DIR="${UM_LIB_DIR:-$CLI_DATA_DIR/lib}"
  CLI_CLI_DIR="${UM_CLI_DIR:-$CLI_DATA_DIR/cli}"

  mkdir -p "$CLI_BIN_DIR" "$CLI_LIB_DIR" "$CLI_CLI_DIR"

  # Copy libs
  CLI_PLUGIN_LIB_SRC="$CLI_REPO_ROOT/plugins/claude-code/universal-memory/hooks/lib"
  if [ ! -d "$CLI_PLUGIN_LIB_SRC" ]; then
    cli_fail "Cannot find library source: $CLI_PLUGIN_LIB_SRC (is this a full repo clone?)"
  fi
  cp -p "$CLI_PLUGIN_LIB_SRC/"*.sh "$CLI_LIB_DIR/"
  CLI_COPIED_COUNT=$(ls -1 "$CLI_LIB_DIR"/*.sh 2>/dev/null | wc -l)
  if [ "$CLI_COPIED_COUNT" -lt 3 ]; then
    echo "install-cli: library copy failed — only $CLI_COPIED_COUNT files in $CLI_LIB_DIR" >&2
    exit 1
  fi
  cli_ok "Libraries installed to: $CLI_LIB_DIR ($CLI_COPIED_COUNT files)"

  # Copy CLI subcommand scripts
  CLI_PLUGIN_BIN="$CLI_REPO_ROOT/plugins/claude-code/universal-memory/bin"
  CLI_COPIED_SCRIPTS=0
  for script in um um-capture um-search.sh um-state.sh um-recent.sh um-list.sh um-capture.sh um-tail.sh um-forget um-supersede um-preview um-tunnel; do
    if [ -f "$CLI_PLUGIN_BIN/$script" ]; then
      cp -p "$CLI_PLUGIN_BIN/$script" "$CLI_CLI_DIR/$script"
      chmod +x "$CLI_CLI_DIR/$script"
      CLI_COPIED_SCRIPTS=$((CLI_COPIED_SCRIPTS + 1))
    fi
  done
  if [ "$CLI_COPIED_SCRIPTS" -lt 3 ]; then
    echo "install-cli: subcommand script copy failed — only $CLI_COPIED_SCRIPTS scripts in $CLI_CLI_DIR" >&2
    exit 1
  fi
  cli_ok "CLI scripts installed: $CLI_COPIED_SCRIPTS scripts to $CLI_CLI_DIR"

  # Copy dispatcher + plugin.json
  CLI_PLUGIN_JSON_SRC="$CLI_REPO_ROOT/plugins/claude-code/universal-memory/.claude-plugin/plugin.json"
  if [ -f "$CLI_PLUGIN_JSON_SRC" ]; then
    mkdir -p "$CLI_BIN_DIR/../.claude-plugin"
    cp -p "$CLI_PLUGIN_JSON_SRC" "$CLI_BIN_DIR/../.claude-plugin/plugin.json"
    cli_ok "plugin.json installed to: $CLI_BIN_DIR/../.claude-plugin/plugin.json"
  fi

  if [ -f "$CLI_CLI_DIR/um" ]; then
    cp -p "$CLI_CLI_DIR/um" "$CLI_BIN_DIR/um"
    chmod +x "$CLI_BIN_DIR/um"
    cli_ok "Dispatcher installed: $CLI_BIN_DIR/um"
  fi

  # Write marker block to shell rc files
  source "$CLI_REPO_ROOT/installer/lib/marker-block.sh"

  CLI_RC_UPDATED=0
  CLI_SH="${SHELL:-}"
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
    case "$rc" in
      "${HOME}/.bashrc")
        [ -f "$rc" ] || [ "${CLI_SH##*/}" = "bash" ] || continue
        ;;
      "${HOME}/.zshrc")
        [ -f "$rc" ] || [ "${CLI_SH##*/}" = "zsh" ] || continue
        ;;
    esac
    touch "$rc"
    _write_marker_block "$rc" "" ""
    cli_ok "Shell profile updated: $rc"
    CLI_RC_UPDATED=$((CLI_RC_UPDATED + 1))
  done

  if [ "$CLI_RC_UPDATED" -eq 0 ]; then
    cli_warn "Could not detect shell rc file — add the following to your shell profile manually:"
    cli_warn "  export UM_SERVER_URL='${UM_SERVER_URL:-http://localhost:6335}'"
    cli_warn "  export UM_LIB_DIR='$CLI_LIB_DIR'"
    cli_warn "  export UM_CLI_DIR='$CLI_CLI_DIR'"
    cli_warn "  case \":\$PATH:\" in *\":\$HOME/.local/bin:\"*) ;; *) export PATH=\"\$HOME/.local/bin:\$PATH\" ;; esac"
  fi

  echo ""
  cli_ok "um installed to: $CLI_CLI_DIR"
  cli_ok "Dispatcher installed: $CLI_BIN_DIR/um"
  cli_ok "Libraries: $CLI_LIB_DIR"
  echo ""
  cli_info "Open a new shell (or run 'source ~/.bashrc' / 'source ~/.zshrc') to pick up the env."
  cli_info "Verify with: um --version"
fi
