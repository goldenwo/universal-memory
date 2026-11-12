#!/usr/bin/env bash
# agy-session-start.sh — Antigravity's SessionStart, served by the existing
# session-start.sh and user-prompt-submit.sh (#410).
#
# Antigravity fires SessionStart at the FIRST PROMPT of a conversation and
# passes that prompt as lastUserInput; it has no per-prompt event and does not
# fire this again on resume (agy 1.5.3, measured 2026-11-09). So this one hook
# does both jobs the two Claude Code hooks do: the project's state of play and
# routing rubric (session-start.sh), then the first-prompt memory search
# (user-prompt-submit.sh). The inner hooks are not changed and do not learn
# Antigravity's input: lib/agy.sh translates in front of them and behind them.
#
# stdin:  Antigravity's hook JSON (conversationId, workspacePaths,
#         transcriptPath, lastUserInput).
# stdout: ONE line. {"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}
#         when there is something to inject, else {}.
#
# Two guarantees, both pinned by agy-hooks.test.sh:
#   - ALWAYS exit 0 with one line of JSON, whatever the inner hooks do. The
#     hooks.json command is `hooks\run-hook.cmd <script> || bash hooks/<script>`
#     and on Windows a non-zero exit runs the second half, where bare `bash`
#     is the WSL launcher.
#   - ONE log line of its own per run (`agy-session-start ok sid=<id>` or
#     `agy-session-start skip=<reason>`). The inner hooks log under their own
#     names, the same lines Claude Code writes on the same machine; this line
#     is what tells the hosts apart in ~/.um/hook.log.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UM_HOOK_NAME="agy-session-start"
# shellcheck source=lib/um-api.sh
source "$SCRIPT_DIR/lib/um-api.sh"
# shellcheck source=lib/agy.sh
source "$SCRIPT_DIR/lib/agy.sh"

OUT='{}'
trap 'printf "%s\n" "$OUT"; exit 0' EXIT
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

# stderr is dropped: the inner hooks print an operator banner there, and what
# Antigravity does with a hook's stderr is not measured. The same warning is
# already inside the injected context.
STATE_OUT=$(printf '%s' "$TRANSLATED" | bash "$SCRIPT_DIR/session-start.sh" 2>/dev/null) || true

# Only with a prompt. user-prompt-submit.sh falls back to its raw stdin when
# it finds no prompt field, so a promptless input would itself be sent to
# /api/search as the query, local paths included.
SEARCH_OUT=""
if um_agy_has_prompt "$TRANSLATED"; then
  SEARCH_OUT=$(printf '%s' "$TRANSLATED" | bash "$SCRIPT_DIR/user-prompt-submit.sh" 2>/dev/null) || true
fi

INJECT=$(printf '%s\n%s\n' "$STATE_OUT" "$SEARCH_OUT" | um_agy_inject) || INJECT=""
[ -z "$INJECT" ] || OUT="$INJECT"

um_log "ok sid=$(um_agy_sid "$TRANSLATED")"
exit 0
