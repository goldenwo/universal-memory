#!/usr/bin/env bash
# stop.sh v2 — per-message capture to POST /api/append-turn (#159 T3,
# spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §5).
#
# Claude Code passes Stop hooks a small metadata JSON on stdin
# ({session_id, transcript_path, cwd, stop_hook_active, ...}) — NOT the
# transcript. The transcript is a JSONL file at transcript_path. (The pre-#159
# version did TRANSCRIPT=$(cat) and therefore never captured anything.)
#
# Behavior (all pinned by spec §5):
#   - Delta cursor at ~/.um/state/stop-cursor-<session_id> (raw transcript
#     line number already captured). session_id validated ^[A-Za-z0-9._-]+$
#     before ANY path use. Cursor absent/unreadable ⇒ bounded trailing window
#     (last 6 eligible messages) + cursor rewrite.
#   - ONE POST PER MESSAGE: {project, content, role, timestamp} built with
#     python json.dumps (transcript text is untrusted — never shell-interpolated
#     into JSON). role = that message's own role.
#   - Cursor advances to message N's line ONLY AFTER its POST returns 2xx;
#     first non-2xx stops the loop — the next fire resends exactly the
#     unacked remainder (at-least-once; doAppendTurn has no dedup, so this
#     ordering is the only safe one).
#   - Max 6 POSTs per fire (skip=delta-capped, remainder carries via cursor).
#   - Content >8192 bytes (server MAX_CONTENT_BYTES, 413 on overflow) is
#     truncated client-side, multibyte-safe (skip=truncated logged).
#   - Log reasons: skip=writes-disabled (403) / skip=server-too-old
#     (404/other non-403 4xx) / error=http-<code> (5xx, 000=unreachable).
#   - Age sweep: cursor files >7 days old are removed in the same pass.
#   - Fail-open: never exits non-zero — CC session integrity beats capture.

# Recursive-hook guard — if invoked inside a summarizer subprocess (the
# claude-agent-sdk backend spawns `claude -p`), exit immediately. T4 retires
# this alongside the summarizer writer.
if [ "${UM_IN_SUMMARIZER_SUBPROCESS:-}" = "1" ]; then exit 0; fi

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UM_HOOK_NAME="stop"
# shellcheck source=lib/um-api.sh
source "$SCRIPT_DIR/lib/um-api.sh"

# Per-fire POST cap and server content-byte cap (spec §5 / append-turn.mjs).
UM_STOP_CAP=6
UM_STOP_MAXBYTES=8192

# ---------------------------------------------------------------------------
# stdin = hook metadata JSON, NOT the transcript.
# ---------------------------------------------------------------------------
HOOK_INPUT=$(cat)
if [ -z "$HOOK_INPUT" ]; then um_log "skip=empty-stdin"; exit 0; fi

PY=$(um_find_python) || { um_log "skip=no-python"; exit 0; }

# ---------------------------------------------------------------------------
# Pass 1: extract metadata fields. One field per line (session_id is
# regex-validated IN python so a newline-smuggling value can't shift fields).
# ---------------------------------------------------------------------------
META=$(printf '%s' "$HOOK_INPUT" | "$PY" -c '
import json, os, re, sys
try:
    meta = json.load(sys.stdin)
except Exception:
    print("SKIP:bad-stdin"); sys.exit(0)
sid = meta.get("session_id") or ""
if not re.fullmatch(r"[A-Za-z0-9._-]+", sid):
    print("SKIP:bad-session-id"); sys.exit(0)
cwd = meta.get("cwd") or ""
print(sid)
print("true" if meta.get("stop_hook_active") else "false")
print(meta.get("transcript_path") or "")
print(os.path.basename(cwd.replace("\\", "/").rstrip("/")) if cwd else "")
' 2>/dev/null)

case "$META" in
  SKIP:*) um_log "skip=${META#SKIP:}"; exit 0 ;;
  '')     um_log "skip=bad-stdin";     exit 0 ;;
esac

SESSION_ID=$(printf '%s\n' "$META" | sed -n '1p')
STOP_ACTIVE=$(printf '%s\n' "$META" | sed -n '2p')
TRANSCRIPT_PATH=$(printf '%s\n' "$META" | sed -n '3p')
PROJECT=$(printf '%s\n' "$META" | sed -n '4p')

# Loop guard: a fire caused by a previous stop-hook continuation must exit
# early (fixtures/README.md field contract) — otherwise hook loops.
if [ "$STOP_ACTIVE" = "true" ]; then exit 0; fi

# Defense-in-depth: re-validate before path use even though python already did.
if ! [[ "$SESSION_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  um_log "skip=bad-session-id"; exit 0
fi
if [ -z "$TRANSCRIPT_PATH" ]; then um_log "skip=no-transcript"; exit 0; fi
if [ -z "$PROJECT" ]; then PROJECT=$(basename "${CLAUDE_CWD:-$(pwd)}"); fi

# ---------------------------------------------------------------------------
# Cursor state dir + age sweep (>7d) in the same pass. The sweep applies the
# same session-id character guard to each candidate before deletion.
# ---------------------------------------------------------------------------
STATE_DIR="$HOME/.um/state"
mkdir -p "$STATE_DIR" 2>/dev/null || true
for f in "$STATE_DIR"/stop-cursor-*; do
  [ -f "$f" ] || continue
  sid_part="${f##*/stop-cursor-}"
  [[ "$sid_part" =~ ^[A-Za-z0-9._-]+$ ]] || continue
  if [ -n "$(find "$f" -maxdepth 0 -mtime +7 2>/dev/null)" ]; then
    rm -f "$f" 2>/dev/null || true
  fi
done

CURSOR_FILE="$STATE_DIR/stop-cursor-$SESSION_ID"
CURSOR=""
if [ -f "$CURSOR_FILE" ]; then
  CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null) || CURSOR=""
  # Non-numeric = unreadable ⇒ trailing-window fallback rewrites it.
  [[ "$CURSOR" =~ ^[0-9]+$ ]] || CURSOR=""
fi

# ---------------------------------------------------------------------------
# Pass 2: parse the transcript and emit a tab-separated manifest. All JSON
# bodies come from json.dumps (single-line, control chars escaped — safe to
# read with IFS=tab). Records:
#   SKIP\t<reason>                       — nothing to do
#   BASELINE\t<line>                     — window fallback: pre-window lines
#                                          are being skipped by decision, so
#                                          the cursor baseline is written
#                                          immediately (not an ack claim)
#   MSG\t<line>\t<truncated 0|1>\t<json> — one POST body per record
#   CAPPED\t<dropped>                    — messages beyond the per-fire cap
#   END\t<total-lines>                   — cursor target on full clean success
# ---------------------------------------------------------------------------
MANIFEST=$(UM_STOP_TRANSCRIPT="$TRANSCRIPT_PATH" UM_STOP_CURSOR="$CURSOR" \
  UM_STOP_PROJECT="$PROJECT" UM_STOP_CAP="$UM_STOP_CAP" \
  UM_STOP_MAXBYTES="$UM_STOP_MAXBYTES" "$PY" -c '
import json, os, sys

path = os.environ["UM_STOP_TRANSCRIPT"]
cursor = os.environ.get("UM_STOP_CURSOR", "")
project = os.environ["UM_STOP_PROJECT"]
cap = int(os.environ["UM_STOP_CAP"])
maxb = int(os.environ["UM_STOP_MAXBYTES"])

try:
    fh = open(path, encoding="utf-8", errors="replace")
except OSError:
    print("SKIP\tno-transcript"); sys.exit(0)

msgs = []   # (lineno, role, text, timestamp)
total = 0
with fh:
    for lineno, raw in enumerate(fh, 1):
        total = lineno
        raw = raw.strip()
        if not raw:
            continue
        try:
            e = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if e.get("isSidechain") or e.get("isMeta"):
            continue
        # Client-synthesized API-error lines pass naive type filters
        # (fixture line 11: model "<synthetic>", isApiErrorMessage) — not
        # conversation; skip. Spec §5 is silent, so conservative-skip.
        if e.get("isApiErrorMessage"):
            continue
        t = e.get("type")
        if t not in ("user", "assistant"):
            continue
        m = e.get("message") or {}
        if m.get("model") == "<synthetic>":
            continue
        role = m.get("role", t)
        if role not in ("user", "assistant"):
            continue
        c = m.get("content")
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = "\n".join(
                b.get("text", "") for b in c
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
            )
        else:
            continue
        text = text.strip()
        if not text or text.startswith("<system-reminder>"):
            continue
        msgs.append((lineno, role, text, e.get("timestamp")))

if cursor.isdigit():
    delta = [m for m in msgs if m[0] > int(cursor)]
else:
    # Cursor absent/unreadable: bounded trailing window (spec §5) — older
    # messages are dropped by decision, so the baseline is safe to write
    # before any ack.
    delta = msgs[-cap:]
    if delta:
        print("BASELINE\t%d" % (delta[0][0] - 1))

dropped = 0
if len(delta) > cap:
    dropped = len(delta) - cap
    delta = delta[:cap]

for lineno, role, text, ts in delta:
    enc = text.encode("utf-8")
    truncated = 0
    if len(enc) > maxb:
        text = enc[:maxb].decode("utf-8", "ignore")
        truncated = 1
    body = {"project": project, "content": text, "role": role}
    if ts:
        body["timestamp"] = ts
    print("MSG\t%d\t%d\t%s" % (lineno, truncated, json.dumps(body)))
if dropped:
    print("CAPPED\t%d" % dropped)
print("END\t%d" % total)
' 2>/dev/null)

if [ -z "$MANIFEST" ]; then um_log "skip=nothing-extracted"; exit 0; fi

# ---------------------------------------------------------------------------
# POST loop. um_api_post is called OUTSIDE command substitution (it sets
# UM_API_HTTP_CODE) with stdin detached (curl must not eat the manifest).
# ---------------------------------------------------------------------------
ENDPOINT=$(um_api_endpoint 2>/dev/null)
SENT=0
FAILED=0
CAPPED=0
LAST_CODE=""

while IFS=$'\t' read -r kind f1 f2 f3; do
  case "$kind" in
    SKIP)
      um_log "skip=$f1"
      exit 0
      ;;
    BASELINE)
      printf '%s' "$f1" > "$CURSOR_FILE" 2>/dev/null || true
      ;;
    MSG)
      [ "$FAILED" = 1 ] && continue
      if [ "$f2" = "1" ]; then um_log "skip=truncated line=$f1"; fi
      if um_api_post '/api/append-turn' "$f3" </dev/null >/dev/null 2>&1; then
        printf '%s' "$f1" > "$CURSOR_FILE" 2>/dev/null || true
        SENT=$((SENT + 1))
        LAST_CODE="$UM_API_HTTP_CODE"
      else
        FAILED=1
        case "$UM_API_HTTP_CODE" in
          403)
            um_log "skip=writes-disabled"
            um_g7_message writes-disabled >&2
            ;;
          000)
            um_log "error=http-000"
            um_g7_message unreachable "$ENDPOINT" >&2
            ;;
          4[0-9][0-9])
            um_log "skip=server-too-old http=$UM_API_HTTP_CODE"
            ;;
          *)
            um_log "error=http-$UM_API_HTTP_CODE"
            ;;
        esac
      fi
      ;;
    CAPPED)
      CAPPED=1
      um_log "skip=delta-capped dropped=$f1"
      ;;
    END)
      # Advance past trailing ineligible lines only on a clean, uncapped
      # fire; otherwise the cursor stays at the last-acked message line.
      if [ "$FAILED" = 0 ] && [ "$CAPPED" = 0 ]; then
        printf '%s' "$f1" > "$CURSOR_FILE" 2>/dev/null || true
      fi
      ;;
  esac
done <<< "$MANIFEST"

if [ "$SENT" -gt 0 ]; then
  um_log "posted http=${LAST_CODE:-000} n=$SENT"
elif [ "$FAILED" = 0 ]; then
  um_log "skip=empty-delta"
fi

exit 0
