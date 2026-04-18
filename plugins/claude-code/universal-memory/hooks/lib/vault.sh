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

# Find orphan raw captures for the current project.
# Orphan = a raw capture (captures/<project>/raw/YYYY-MM-DD.md) whose mtime
# is newer than state.md's valid_from AND has no corresponding session summary
# (sessions/<project>/*.md) with valid_from > raw-file mtime.
#
# Usage: find_orphans [PROJECT]
#   PROJECT defaults to project_name
# Outputs: one orphan raw path per line, relative to vault root
find_orphans() {
  local project="${1:-$(project_name)}"
  local vault
  vault=$(vault_path)
  local state_file="$vault/state/$project/state.md"
  local raw_dir="$vault/captures/$project/raw"
  local sessions_dir="$vault/sessions/$project"

  [ -d "$raw_dir" ] || return 0  # no captures = no orphans

  # Get state.md's valid_from as epoch seconds, or 0 if no state.md
  local state_valid_from=0
  if [ -f "$state_file" ]; then
    local vf
    vf=$(fm_read "$state_file" "valid_from")
    if [ -n "$vf" ]; then
      state_valid_from=$(date -d "$vf" +%s 2>/dev/null || echo 0)
    fi
  fi

  # For each raw capture file
  find "$raw_dir" -type f -name '*.md' 2>/dev/null | while read -r raw; do
    # Get raw file mtime as epoch seconds
    # Try Linux stat first (-c %Y), fall back to BSD/macOS stat (-f %m)
    local raw_mtime
    raw_mtime=$(stat -c %Y "$raw" 2>/dev/null || stat -f %m "$raw" 2>/dev/null || echo 0)

    # Must be newer than state.md's valid_from to be an orphan candidate
    if [ "$raw_mtime" -le "$state_valid_from" ]; then
      continue
    fi

    # Check if any session summary has valid_from > raw_mtime
    local covered=0
    if [ -d "$sessions_dir" ]; then
      for summary in "$sessions_dir"/*.md; do
        [ -e "$summary" ] || continue
        local summary_vf
        summary_vf=$(fm_read "$summary" "valid_from")
        if [ -n "$summary_vf" ]; then
          local summary_epoch
          summary_epoch=$(date -d "$summary_vf" +%s 2>/dev/null || echo 0)
          if [ "$summary_epoch" -gt "$raw_mtime" ]; then
            covered=1
            break
          fi
        fi
      done
    fi

    if [ "$covered" -eq 0 ]; then
      # Output path relative to vault root
      echo "${raw#"$vault/"}"
    fi
  done
}
