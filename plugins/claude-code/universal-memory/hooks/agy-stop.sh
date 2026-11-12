#!/usr/bin/env bash
# agy-stop.sh — Antigravity's Stop, served by the existing stop.sh (#410).
#
# Antigravity fires Stop once per user turn and names a transcript file that
# is complete and append-only at that moment (agy 1.5.3, measured
# 2026-11-09). lib/agy.sh translates the hook input; stop.sh does the capture
# (cursor, cap, truncation, error handling and the anomaly self-report are
# shared with Claude Code and Codex) and reads Antigravity's transcript as its
# third dialect.
#
# stdin:  Antigravity's hook JSON (conversationId, workspacePaths,
#         transcriptPath).
# stdout: exactly {} — "let the stop proceed". This plugin never asks
#         Antigravity to continue.
#
# The same two guarantees as agy-session-start.sh: always exit 0 with one line
# of JSON, and one log line of its own per run (`agy-stop ok sid=<id>` or
# `agy-stop skip=<reason>`).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UM_HOOK_NAME="agy-stop"
# shellcheck source=lib/um-api.sh
source "$SCRIPT_DIR/lib/um-api.sh"
# shellcheck source=lib/agy.sh
source "$SCRIPT_DIR/lib/agy.sh"

trap 'printf "{}\n"; exit 0' EXIT
trap 'exit 0' HUP INT TERM

RAW=$(cat)
if [ -z "${RAW//[[:space:]]/}" ]; then um_log "skip=empty-stdin"; exit 0; fi

PY=$(um_find_python) || { um_log "skip=no-python"; exit 0; }

TRANSLATE_RC=0
TRANSLATED=$(printf '%s' "$RAW" | um_agy_to_claude) || TRANSLATE_RC=$?
case "$TRANSLATE_RC" in
  0) ;;
  2) um_log "skip=no-workspace"; exit 0 ;;
  *) um_log "skip=bad-stdin"; exit 0 ;;
esac

printf '%s' "$TRANSLATED" | bash "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true

um_log "ok sid=$(um_agy_sid "$TRANSLATED")"
exit 0
