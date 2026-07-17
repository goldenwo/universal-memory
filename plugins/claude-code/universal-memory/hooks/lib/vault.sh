#!/usr/bin/env bash
# hooks/lib/vault.sh — vault path + project helpers
# Source this file; do not execute directly.
# Depends on frontmatter.sh (sourced automatically below if not already loaded).

# Source frontmatter.sh if fm_read is not yet defined
if ! declare -f fm_read >/dev/null 2>&1; then
  # shellcheck source=./frontmatter.sh
  source "$(dirname "${BASH_SOURCE[0]}")/frontmatter.sh"
fi

# Return absolute path to vault root. Respects UM_VAULT_DIR.
vault_path() {
  echo "${UM_VAULT_DIR:-$HOME/.um/vault}"
}

# Return project name derived from cwd.
# Priority: CLAUDE_CWD (set by CC), then pwd.
project_name() {
  local cwd="${CLAUDE_CWD:-$(pwd)}"
  basename "$cwd"
}

# try_clear_stale_lock LOCKDIR [GRACE_SECONDS]
#
# If LOCKDIR exists and its mtime is older than GRACE_SECONDS (default 600,
# i.e. 10 minutes), remove it. Legitimate runs complete in seconds; a lockdir
# older than 10 minutes was left by a crashed process.
#
# Call this BEFORE each retry loop that uses mkdir-based locking.
try_clear_stale_lock() {
  local lockdir="$1"
  local grace="${2:-600}"
  if [ -d "$lockdir" ]; then
    local lock_mtime lock_age
    lock_mtime=$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || echo 0)
    lock_age=$(( $(date -u +%s) - lock_mtime ))
    if [ "$lock_age" -gt "$grace" ]; then
      rmdir "$lockdir" 2>/dev/null || true
    fi
  fi
}
