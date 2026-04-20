#!/bin/bash
# universal-memory bootstrap installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/goldenwo/universal-memory/main/installer/install.sh | bash -s -- --yes
# or with a custom install directory:
#   curl -fsSL .../installer/install.sh | UM_INSTALL_DIR=/opt/um bash -s -- --yes

set -euo pipefail

REPO="${UM_REPO_URL:-https://github.com/goldenwo/universal-memory.git}"
INSTALL_DIR="${UM_INSTALL_DIR:-$HOME/universal-memory}"
DRY_RUN="${UM_DRY_RUN:-0}"

printf '\nUniversal-memory installer\n==========================\n\n'

# Parse --dry-run flag (for testing; actual server/install.sh args pass through)
pass_args=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) pass_args+=("$arg") ;;
  esac
done

# ─── Prerequisites ────────────────────────────────────────────────────────────
missing=()
for tool in git docker python3 bash; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
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

# ─── Dispatch to server/install.sh ────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would: bash $INSTALL_DIR/server/install.sh ${pass_args[*]:-(no args)}"
  exit 0
fi

printf '\nDelegating to server/install.sh...\n\n'
exec bash "$INSTALL_DIR/server/install.sh" "${pass_args[@]}"
