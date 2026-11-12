#!/usr/bin/env bash
# hooks/lib/agy.sh — translation between Antigravity's hook shapes and the
# Claude-shaped ones the existing hooks read and write (#410).
#
# Sourced (NOT executed) by agy-session-start.sh and agy-stop.sh, after
# um-api.sh (which provides um_find_python and the UTF-8 exports). The
# existing hooks do not learn a second input format: these functions sit in
# front of them and behind them. Defines:
#
#   um_agy_to_claude   — stdin: Antigravity hook JSON. stdout: ONE line, the
#                        Claude-shaped object. rc 1 = not a JSON object,
#                        rc 2 = no workspace, rc 3 = no python.
#   um_agy_inject      — stdin: the stdout of one or more existing hooks, one
#                        JSON object per line. stdout: ONE line, Antigravity's
#                        injectSteps object, or {} when nothing is to inject.
#   um_agy_sid         — the session id of a translated line, for a log line.
#   um_agy_has_prompt  — rc 0 iff a translated line carries a prompt.
#
# Field map (Antigravity CLI 1.5.3, measured 2026-11-09):
#   conversationId     → session_id
#   workspacePaths[0]  → cwd
#   transcriptPath     → transcript_path
#   lastUserInput      → prompt, only when it is a string with non-blank text
# Nothing else is copied. stop_hook_active is never set: this plugin never
# asks Antigravity to continue a stop.

_um_agy_python() {
  if [ -n "${PY:-}" ]; then printf '%s\n' "$PY"; return 0; fi
  um_find_python
}

um_agy_to_claude() {
  local py
  py=$(_um_agy_python) || return 3
  "$py" -c '
import json, sys
# Windows python writes LF as CRLF on a pipe; emit LF at the source.
sys.stdout.reconfigure(newline="\n")
try:
    d = json.loads(sys.stdin.buffer.read().decode("utf-8"))
except Exception:
    sys.exit(1)
if not isinstance(d, dict):
    sys.exit(1)
ws = d.get("workspacePaths")
if not (isinstance(ws, list) and ws and isinstance(ws[0], str) and ws[0].strip()):
    sys.exit(2)
sid = d.get("conversationId")
# Key order is fixed and json.dumps escapes every quote inside a value, so
# um_agy_sid and um_agy_has_prompt below can read this line without python.
out = {"session_id": sid if isinstance(sid, str) else "", "cwd": ws[0]}
tp = d.get("transcriptPath")
if isinstance(tp, str) and tp:
    out["transcript_path"] = tp
prompt = d.get("lastUserInput")
if isinstance(prompt, str) and prompt.strip():
    out["prompt"] = prompt
print(json.dumps(out))
' 2>/dev/null
}

um_agy_inject() {
  local py
  py=$(_um_agy_python) || { printf '{}\n'; return 0; }
  "$py" -c '
import json, sys
sys.stdout.reconfigure(newline="\n")
parts = []
for raw in sys.stdin.buffer.read().decode("utf-8", errors="replace").splitlines():
    try:
        text = json.loads(raw)["hookSpecificOutput"]["additionalContext"]
    except Exception:
        continue
    if isinstance(text, str) and text.strip():
        parts.append(text.strip())
if parts:
    # The nesting is Antigravity`s: a step whose kind is systemMessage, holding
    # a systemMessage string.
    print(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": "\n\n".join(parts)}}]}))
else:
    print("{}")
' 2>/dev/null || printf '{}\n'
}

# um_agy_sid <translated-line>
# Prints the session id when it is safe to put in a log line, else "unknown".
um_agy_sid() {
  if [[ "${1:-}" =~ ^\{\"session_id\":\ \"([A-Za-z0-9._-]+)\" ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf 'unknown\n'
  fi
}

# um_agy_has_prompt <translated-line>
# A quote inside a JSON value is always escaped, so an unescaped `, "prompt": "`
# can only be the key um_agy_to_claude wrote.
um_agy_has_prompt() {
  [[ "${1:-}" == *', "prompt": "'* ]]
}
