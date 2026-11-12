#!/usr/bin/env bash
# installer/lib/codex-hook-approval.sh — ask whether Codex still has
# universal-memory's hooks approved, in a way that cannot fail the caller.
#
# The answer comes from codex_hook_approval.py beside this file (read its header
# for what it reads and why). This wrapper exists because both callers run under
# `set -euo pipefail`, and a check must never stop an install or a server
# verify: a missing or failing Python, no output, several lines, or a first word
# that is not a known state all become "unknown".
#
# Usage (sourced):
#   um_codex_hook_approval <codex_home> [python]
# Sets:
#   UM_CODEX_HOOKS_STATE    approved | needs-approval | never-approved |
#                           disabled | unknown | not-installed
#   UM_CODEX_HOOKS_MESSAGE  one sentence for the user
# Always returns 0. Runs no `codex` command and writes nothing.

_UM_CODEX_HOOKS_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex_hook_approval.py"
_UM_CODEX_HOOKS_STATES=" approved needs-approval never-approved disabled unknown not-installed "

# The hooks' own probe (um_find_python in hooks/lib/um-api.sh): on Windows a
# bare python3 or python is often a Store stub, so only one that runs counts.
_um_codex_hooks_python() {
  local candidate
  for candidate in py python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c '' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# _um_codex_hooks_native_path <python> <path> — the path in the form that
# Python reads. A native Windows Python needs C:\...; Git Bash usually rewrites
# an argument that looks like a path, but not under MSYS_NO_PATHCONV=1, so
# convert here. A Cygwin or MSYS2 Python reads POSIX paths and must be left
# alone, which is why the interpreter is asked what it is.
_um_codex_hooks_native_path() {
  local python="$1" path="$2"
  if command -v cygpath >/dev/null 2>&1 \
     && [ "$("$python" -c 'import os; print(os.name)' 2>/dev/null | tr -d '\r')" = "nt" ]; then
    cygpath -w "$path" 2>/dev/null || printf '%s\n' "$path"
  else
    printf '%s\n' "$path"
  fi
}

# shellcheck disable=SC2034  # UM_CODEX_HOOKS_STATE and _MESSAGE are the caller's to read
um_codex_hook_approval() {
  local codex_home="$1" python="${2:-}" answer state message
  UM_CODEX_HOOKS_STATE="unknown"
  UM_CODEX_HOOKS_MESSAGE="Could not tell whether Codex has universal-memory's hooks approved (the check did not run)."
  if [ -z "$python" ]; then
    python=$(_um_codex_hooks_python) || {
      UM_CODEX_HOOKS_MESSAGE="Could not tell whether Codex has universal-memory's hooks approved (no working Python)."
      return 0
    }
  fi
  answer=$("$python" "$(_um_codex_hooks_native_path "$python" "$_UM_CODEX_HOOKS_CHECK")" \
    --codex-home "$(_um_codex_hooks_native_path "$python" "$codex_home")" 2>/dev/null) || return 0
  answer="${answer%$'\r'}"
  case "$answer" in
    *$'\n'* | *$'\r'*) return 0 ;;
  esac
  state="${answer%%$'\t'*}"
  message="${answer#*$'\t'}"
  # No tab leaves both equal to the whole answer.
  if [ "$state" = "$answer" ] || [ -z "$message" ]; then return 0; fi
  case "$_UM_CODEX_HOOKS_STATES" in
    *" $state "*) ;;
    *) return 0 ;;
  esac
  UM_CODEX_HOOKS_STATE="$state"
  UM_CODEX_HOOKS_MESSAGE="$message"
  return 0
}
