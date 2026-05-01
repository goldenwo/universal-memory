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
#   --interactive   Launch the interactive wizard
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

# ---- Per-delegate arg filtering ------------------------------------------------
# COMMON_ARGS go to every delegate; per-component arrays go only to their target.
# This prevents --skip-docker (server-only) from reaching install-cli.sh (exit 2).
COMMON_ARGS=()    # --yes, --dry-run
SERVER_ARGS=()    # --skip-docker
CLI_ARGS=()       # --no-path
PLUGIN_ARGS=()    # (receives COMMON_ARGS + --server-url)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)        INSTALL_SERVER=1 ;;
    --plugin-cc)     INSTALL_PLUGIN_CC=1 ;;
    --plugin-codex)  INSTALL_PLUGIN_CODEX=1 ;;
    --cli)           INSTALL_CLI=1 ;;
    --all)           INSTALL_ALL=1 ;;
    --yes|-y)        ASSUME_YES=1; COMMON_ARGS+=("$1") ;;
    --interactive)   FORCE_WIZARD=1 ;;
    --server-url)    UM_SERVER_URL="$2"; export UM_SERVER_URL; CLI_ARGS+=("$1" "$2"); PLUGIN_ARGS+=("$1" "$2"); shift ;;
    --skip-docker)   SERVER_ARGS+=("$1") ;;
    --no-path)       CLI_ARGS+=("$1") ;;
    --dry-run)       DRY_RUN=1; COMMON_ARGS+=("$1") ;;
    -h|--help)       _show_help=1 ;;
    *)               COMMON_ARGS+=("$1") ;;
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
  --interactive     Launch the setup wizard
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

if [[ $MODE == wizard ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=installer/wizard-lib.sh
  source "$SCRIPT_DIR/wizard-lib.sh"
  wizard_header
  wizard_detect_env
  wizard_menu_main

  case "$WIZARD_CHOICE" in
    1)  # Everything detected
        INSTALL_SERVER=$DETECTED_DOCKER
        INSTALL_PLUGIN_CC=$DETECTED_CC
        INSTALL_PLUGIN_CODEX=$DETECTED_CODEX
        INSTALL_CLI=1
        [[ $DETECTED_DOCKER -eq 0 ]] && echo "[wizard] WARNING: Docker not detected — 'Everything' choice skips server install. Install Docker and re-run, or choose 4 (Just server) after installing Docker." >&2
        ;;
    2)  INSTALL_PLUGIN_CC=1 ;;
    3)  INSTALL_CLI=1
        wizard_prompt UM_SERVER_URL "UM server URL" "http://localhost:6335"
        ;;
    4)  INSTALL_SERVER=1 ;;
    5)  # Custom
        wizard_confirm "Install server stack?" && INSTALL_SERVER=1
        wizard_confirm "Install Claude Code plugin?" && INSTALL_PLUGIN_CC=1
        wizard_confirm "Install Codex plugin?" && INSTALL_PLUGIN_CODEX=1
        wizard_confirm "Install um CLI?" && INSTALL_CLI=1
        ;;
  esac

  wizard_prompt UM_VAULT_DIR "Vault directory" "$HOME/.um/vault"
  # v0.7: 4-path provider picker replaces the v0.6 single-OpenAI-key prompt.
  # wizard_menu_providers exports UM_*_PROVIDER + collects keys for the chosen
  # path; OPENAI_API_KEY (legacy var) is set by wizard_collect_keys when path
  # 1 or path 2 (with openai selected) collects it.
  wizard_menu_providers
  # Ensure wizard-set vars are exported so sub-installers inherit them.
  # wizard_prompt already calls eval "export $var=..." since fix-5; these are
  # belts-and-suspenders for any wizard path that goes through direct assignment.
  export UM_VAULT_DIR
  # Mirror OPENAI_API_KEY → UM_OPENAI_API_KEY for v0.6 sub-installer back-compat.
  [[ -n "${OPENAI_API_KEY:-}" ]] && export UM_OPENAI_API_KEY="$OPENAI_API_KEY"
  wizard_summarize
  wizard_confirm "Proceed?" || { echo "Aborted."; exit 0; }
  MODE=components  # fall through to dispatcher
fi

if [[ $INSTALL_ALL -eq 1 ]]; then
  INSTALL_SERVER=1
  [[ -d "${HOME:-}/.claude" ]] && INSTALL_PLUGIN_CC=1
  [[ -d "${HOME:-}/.codex" ]] && INSTALL_PLUGIN_CODEX=1
  INSTALL_CLI=1
fi

# ─── --yes API-key guard (G2.3 review-loop, v0.7 contract change) ─────────────
# v0.6 permitted `--yes` with no API key in env (defaults caught the openai-only
# world); v0.7 refuses with a clear error pointing at the missing var. The check
# fires only when the SERVER is in scope — plugins/CLI alone don't need keys.
# Provider sources mirror wizard_collect_keys precedence (UM_<P>_API_KEY first,
# fallback to <P>_API_KEY; google also accepts GEMINI_API_KEY). See MIGRATION.md
# for the v0.6 → v0.7 contract change rationale.
if [[ $ASSUME_YES -eq 1 && $INSTALL_SERVER -eq 1 ]]; then
  _providers=$(printf '%s\n' \
    "${UM_EMBEDDING_PROVIDER:-openai}" \
    "${UM_SUMMARIZER_PROVIDER:-openai}" \
    "${UM_FACTS_PROVIDER:-openai}" | sort -u)
  _missing_keys=()
  while IFS= read -r _p; do
    case "$_p" in
      openai)
        [[ -n "${OPENAI_API_KEY:-${UM_OPENAI_API_KEY:-}}" ]] \
          || _missing_keys+=("openai: set OPENAI_API_KEY (or UM_OPENAI_API_KEY)")
        ;;
      anthropic)
        [[ -n "${ANTHROPIC_API_KEY:-${UM_ANTHROPIC_API_KEY:-}}" ]] \
          || _missing_keys+=("anthropic: set ANTHROPIC_API_KEY (or UM_ANTHROPIC_API_KEY)")
        ;;
      google)
        [[ -n "${GOOGLE_API_KEY:-${UM_GOOGLE_API_KEY:-${GEMINI_API_KEY:-}}}" ]] \
          || _missing_keys+=("google: set GOOGLE_API_KEY (or GEMINI_API_KEY / UM_GOOGLE_API_KEY)")
        ;;
      ollama) : ;;  # local; no API key needed
    esac
  done <<< "$_providers"
  if (( ${#_missing_keys[@]} > 0 )); then
    echo "ERROR: --yes mode requires API key(s) for the configured provider(s); none found in env." >&2
    for _msg in "${_missing_keys[@]}"; do echo "  - $_msg" >&2; done
    echo "" >&2
    echo "Either set the env var(s) above and re-run, or run interactively without --yes." >&2
    echo "See MIGRATION.md (v0.6 → v0.7) for the contract change." >&2
    exit 1
  fi
fi

printf '\nUniversal-memory installer\n==========================\n\n'

# ─── Prerequisites ────────────────────────────────────────────────────────────
# Determine which tools are actually needed based on what we're installing
NEED_GIT=0
NEED_DOCKER=0
NEED_PYTHON3=0
# bash is always needed — checked unconditionally below (no NEED_BASH gate).

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
# Each delegate receives only the args relevant to it (per-delegate filtering).
#
# bash 3.2 portability: under `set -u`, spreading an empty array via
# `"${arr[@]}"` errors with "unbound variable" on stock macOS bash 3.2
# (and bash 4.0–4.3). Bash 4.4+ handles it correctly. We use the
# `${arr[@]+"${arr[@]}"}` idiom — expands to nothing when the array is
# empty, expands to the contents quoted-individually otherwise. This is
# the canonical fix for empty-array spread under set -u.
# Surfaced when install-token.test.sh was wired into CI on macos-latest.
if [[ $INSTALL_SERVER -eq 1 ]]; then
  _delegate "server/install.sh" ${COMMON_ARGS[@]+"${COMMON_ARGS[@]}"} ${SERVER_ARGS[@]+"${SERVER_ARGS[@]}"}
fi
if [[ $INSTALL_PLUGIN_CC -eq 1 ]]; then
  _delegate "installer/install-plugin-cc.sh" ${COMMON_ARGS[@]+"${COMMON_ARGS[@]}"} ${PLUGIN_ARGS[@]+"${PLUGIN_ARGS[@]}"}
fi
if [[ $INSTALL_PLUGIN_CODEX -eq 1 ]]; then
  if [[ ! -d "${HOME:-}/.codex" ]]; then
    echo "[install] ~/.codex not found — soft-skipping Codex plugin" >&2
  else
    _delegate "installer/install-plugin-codex.sh" ${COMMON_ARGS[@]+"${COMMON_ARGS[@]}"} ${PLUGIN_ARGS[@]+"${PLUGIN_ARGS[@]}"}
  fi
fi
if [[ $INSTALL_CLI -eq 1 ]]; then
  _delegate "installer/install-cli.sh" ${COMMON_ARGS[@]+"${COMMON_ARGS[@]}"} ${CLI_ARGS[@]+"${CLI_ARGS[@]}"}
fi
