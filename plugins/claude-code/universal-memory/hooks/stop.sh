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
#   - #267 anomaly self-report: the six measured-zero anomalous reasons
#     (empty-stdin, no-python, bad-stdin, no-transcript, nothing-extracted,
#     and the empty-delta split below) POST one signal.capture_anomaly row
#     via um_signal_anomaly and append ` signal=<token>` to their log line
#     (first token stays skip=<reason> — frequency-analysis contract).
#     Benign guards and the transport-error family do NOT self-report.
#   - #267 empty-delta SPLIT: skip=empty-delta is REPLACED by
#     skip=empty-delta-stalled (file did not grow past the cursor; includes
#     zero-byte and replaced-shorter, which also rewinds the cursor via END)
#     vs skip=empty-delta-filtered (new lines existed, none survived the
#     eligibility filters — the format-drift family, the 2026-07-16 class).
#     Pass 2 ALWAYS emits an EMPTY record when the delta is empty; the bash
#     ${SHAPE:-stalled} default is a set-u-safe tripwire, not a path.
#   - Age sweep: cursor files >7 days old are removed in the same pass.
#   - Fail-open: never exits non-zero — CC session integrity beats capture.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UM_HOOK_NAME="stop"
# shellcheck source=lib/um-api.sh
source "$SCRIPT_DIR/lib/um-api.sh"

# Per-fire POST cap, no-cursor fallback window ("last 6 exchanges" = 12
# messages, spec §5), and server content-byte cap (append-turn.mjs).
UM_STOP_CAP=6
UM_STOP_WINDOW=12
UM_STOP_MAXBYTES=8192

# ---------------------------------------------------------------------------
# stdin = hook metadata JSON, NOT the transcript.
# ---------------------------------------------------------------------------
HOOK_INPUT=$(cat)
# #267: the anomalous classes below self-report (measured-zero benign base
# rate — any occurrence is signal). PRE-PROJECT sites pass NO project arg:
# $PROJECT is unbound here under set -u, and the helper reads "${2:-}".
if [ -z "$HOOK_INPUT" ]; then um_log "skip=empty-stdin signal=$(um_signal_anomaly empty-stdin)"; exit 0; fi

PY=$(um_find_python) || { um_log "skip=no-python signal=$(um_signal_anomaly no-python)"; exit 0; }

# ---------------------------------------------------------------------------
# Pass 1: extract metadata fields. One field per line (session_id is
# regex-validated IN python so a newline-smuggling value can't shift fields).
# #186/#294: the project slug runs through the non-project guard
# (lib/project_guard.py — home-check + marker walk-up on the FULL cwd, with
# the $CLAUDE_CWD/pwd fallback guarded too; #294: the slug names the project
# ROOT the walk finds — naming rule: the D1 algorithm comment inside
# guard(), the canonical statement). A skip prints the SKIP sentinel as the ONLY output line,
# preserving the `case "$META" in SKIP:*)` contract.
# ---------------------------------------------------------------------------
UM_GUARD_LIB="$SCRIPT_DIR/lib"
if command -v cygpath >/dev/null 2>&1; then UM_GUARD_LIB=$(cygpath -w "$UM_GUARD_LIB"); fi
META=$(printf '%s' "$HOOK_INPUT" | \
  UM_GUARD_LIB="$UM_GUARD_LIB" UM_GUARD_FALLBACK="${CLAUDE_CWD:-$(pwd)}" "$PY" -c '
import json, os, re, sys
sys.path.insert(0, os.environ["UM_GUARD_LIB"])
from project_guard import guard
try:
    meta = json.load(sys.stdin)
except Exception:
    print("SKIP:bad-stdin"); sys.exit(0)
sid = meta.get("session_id") or ""
if not re.fullmatch(r"[A-Za-z0-9._-]+", sid):
    print("SKIP:bad-session-id"); sys.exit(0)
cwd = meta.get("cwd") or ""
fallback = os.environ.get("UM_GUARD_FALLBACK", "")
res = guard(cwd, fallback)
if res.startswith("SKIP:"):
    shown = (cwd or fallback or "<none>").replace("\n", " ").replace("\r", " ")
    print(f"{res} cwd={shown}"); sys.exit(0)
print(sid)
print("true" if meta.get("stop_hook_active") else "false")
print(meta.get("transcript_path") or "")
print(res)
' 2>/dev/null)

case "$META" in
  # #267: bad-stdin is anomalous and self-reports (the empty-META arm — the
  # pass-1 interpreter died — shares the reason and the body); every OTHER
  # SKIP sentinel (bad-session-id, the non-project guards) is a benign class
  # and stays exactly as before. Exact match — benign sentinels carry
  # suffixes.
  SKIP:bad-stdin|'') um_log "skip=bad-stdin signal=$(um_signal_anomaly bad-stdin)"; exit 0 ;;
  SKIP:*) um_log "skip=${META#SKIP:}"; exit 0 ;;
esac

SESSION_ID=$(printf '%s\n' "$META" | sed -n '1p')
STOP_ACTIVE=$(printf '%s\n' "$META" | sed -n '2p')
TRANSCRIPT_PATH=$(printf '%s\n' "$META" | sed -n '3p')
PROJECT=$(printf '%s\n' "$META" | sed -n '4p')
# Sanitize the derived project slug AT ASSIGNMENT (#267 hoist — this used to
# sit below the no-transcript guard, but that site now interpolates $PROJECT
# into the self-report JSON, and the guard's slug is a directory basename
# (#294: an ANCESTOR dir's, the project root) that may legally carry
# quotes/spaces/backticks). The server hard-fails non-[A-Za-z0-9._-]
# projects (400), which would otherwise loop as permanent per-fire errors
# (T3 review IMPORTANT-2 / spec §5 amendment). Empty stays empty, so the
# guard-failed check below is unaffected.
PROJECT="${PROJECT//[^A-Za-z0-9._-]/-}"

# Loop guard: a fire caused by a previous stop-hook continuation must exit
# early (fixtures/README.md field contract) — otherwise hook loops.
if [ "$STOP_ACTIVE" = "true" ]; then um_log "skip=stop-hook-active"; exit 0; fi

# Defense-in-depth: re-validate before path use even though python already did.
if ! [[ "$SESSION_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  um_log "skip=bad-session-id"; exit 0
fi
if [ -z "$TRANSCRIPT_PATH" ]; then um_log "skip=no-transcript signal=$(um_signal_anomaly no-transcript "$PROJECT")"; exit 0; fi
# #186: no unguarded fallback — the guard already resolved meta.cwd →
# $CLAUDE_CWD → pwd and emits a SKIP sentinel for every non-project outcome.
# An empty slug here means the guard step itself broke: fail closed.
# (Benign-unmeasured class — deliberately NOT self-reported, #267 D11.)
if [ -z "$PROJECT" ]; then um_log "skip=guard-failed"; exit 0; fi

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
#   EMPTY\t<stalled|filtered>            — #267: ALWAYS emitted when the
#                                          delta is empty; stalled = the file
#                                          did not grow past the cursor
#                                          (zero-byte and replaced-shorter
#                                          included), filtered = new lines
#                                          existed but none survived the
#                                          eligibility filters
#   END\t<total-lines>                   — cursor target on full clean success
# ---------------------------------------------------------------------------
# Pass-2 stderr goes to a per-fire diagnostic file (see the nothing-extracted
# note below) — but ONLY if it is writable: a failed redirect would abort the
# substitution and mint a FALSE nothing-extracted alarm on read-only homes.
PASS2_ERR="$STATE_DIR/stop-pass2.err"
: > "$PASS2_ERR" 2>/dev/null || PASS2_ERR=/dev/null
MANIFEST=$(UM_STOP_TRANSCRIPT="$TRANSCRIPT_PATH" UM_STOP_CURSOR="$CURSOR" \
  UM_STOP_PROJECT="$PROJECT" UM_STOP_CAP="$UM_STOP_CAP" \
  UM_STOP_WINDOW="$UM_STOP_WINDOW" \
  UM_STOP_MAXBYTES="$UM_STOP_MAXBYTES" "$PY" -c '
import json, os, sys

# Windows python translates \n to \r\n on pipes; emit clean LF at the source
# (the C8 spirit) so no manifest field can carry a stray \r into the read
# loop. The bash-side strip below stays as a belt.
sys.stdout.reconfigure(newline="\n")

path = os.environ["UM_STOP_TRANSCRIPT"]
cursor = os.environ.get("UM_STOP_CURSOR", "")
project = os.environ["UM_STOP_PROJECT"]
cap = int(os.environ["UM_STOP_CAP"])
window = int(os.environ["UM_STOP_WINDOW"])
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
            # Plain-string reminder content is reminder-only — skip whole.
            text = c.strip()
            if text.startswith("<system-reminder>"):
                continue
        elif isinstance(c, list):
            # Filter at the BLOCK level: a reminder block can precede the
            # user`s real text block in one message — dropping on the JOINED
            # text would lose the real content (T3 review IMPORTANT-1).
            parts = []
            for b in c:
                if not (isinstance(b, dict) and b.get("type") == "text"
                        and b.get("text")):
                    continue
                if b["text"].strip().startswith("<system-reminder>"):
                    continue
                parts.append(b["text"])
            text = "\n".join(parts).strip()
        else:
            continue
        if not text:
            continue
        msgs.append((lineno, role, text, e.get("timestamp")))

# isascii() guard (review catch): str.isdigit() is True for Unicode digits
# where int() raises — bash pre-validates ^[0-9]+$, but this block must not
# depend on that distant guard.
if cursor.isascii() and cursor.isdigit():
    delta = [m for m in msgs if m[0] > int(cursor)]
else:
    # Cursor absent/unreadable: bounded trailing window (spec §5, "last 6
    # exchanges" = 12 messages) — older messages are dropped by decision, so
    # the baseline is safe to write before any ack. The per-fire cap +
    # cursor carry the window remainder across fires.
    delta = msgs[-window:]
    if delta:
        print("BASELINE\t%d" % (delta[0][0] - 1))

# #267: classify the empty delta — the shape rule is exhaustive over the
# cursor/total orderings (spec D10). Emitted UNCONDITIONALLY whenever the
# delta is empty, so the bash-side default can only ever be a tripwire.
if not delta:
    if cursor.isascii() and cursor.isdigit():
        shape = "stalled" if total <= int(cursor) else "filtered"
    else:
        shape = "filtered" if total > 0 else "stalled"
    print("EMPTY\t%s" % shape)

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
' 2>"$PASS2_ERR")

# Diagnostic residue for the nothing-extracted alarm (review catch): an
# empty MANIFEST means the pass-2 interpreter DIED, and #267 turns that
# into a 7-day alarm — the traceback that explains it must exist somewhere.
# Overwritten per fire; empty on healthy fires.
if [ -z "$MANIFEST" ]; then um_log "skip=nothing-extracted signal=$(um_signal_anomaly nothing-extracted "$PROJECT")"; exit 0; fi

# Belt for the CRLF-to-pipe class (primary fix: the reconfigure at the top
# of pass 2): $() strips only the TRAILING \r\n pair, so an interior
# manifest line's final field would otherwise carry a stray \r into the
# read loop (#267 caught this via the EMPTY shape token; it also corrupted
# BASELINE/END cursor writes latently). json.dumps never emits a raw \r —
# the strip can only remove the newline artifact, never content.
MANIFEST="${MANIFEST//$'\r'/}"

# ---------------------------------------------------------------------------
# POST loop. um_api_post is called OUTSIDE command substitution (it sets
# UM_API_HTTP_CODE) with stdin detached (curl must not eat the manifest).
# ---------------------------------------------------------------------------
ENDPOINT=$(um_api_endpoint 2>/dev/null)
SENT=0
FAILED=0
CAPPED=0
LAST_CODE=""
# #267: initialized BEFORE the loop, read via ${SHAPE:-stalled} — the
# tripwire case is exactly the case where the EMPTY arm never ran, and a
# bare $SHAPE would be an unbound-variable crash under set -u, violating
# the fail-open contract this file opens with.
SHAPE=""

while IFS=$'\t' read -r kind f1 f2 f3; do
  case "$kind" in
    SKIP)
      # #267: pass-2's no-transcript (open failed) is anomalous and
      # self-reports; any other SKIP record stays as-is.
      if [ "$f1" = "no-transcript" ]; then
        um_log "skip=no-transcript signal=$(um_signal_anomaly no-transcript "$PROJECT")"
      else
        um_log "skip=$f1"
      fi
      exit 0
      ;;
    EMPTY)
      SHAPE="$f1"
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
          # 400/401 carved out of server-too-old (spec §5 T3-review
          # amendment): "upgrade your server" is the wrong prescription for
          # rejected input or a rotated token.
          400)
            um_log "error=input-invalid"
            ;;
          401)
            um_log "error=auth"
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
  # #294 D7: resolved slug appended as the LAST field (see session-end.sh's
  # twin comment; naming rule: project_guard.py guard()).
  um_log "posted http=${LAST_CODE:-000} n=$SENT project=$PROJECT"
elif [ "$FAILED" = 0 ]; then
  # SENT=0 && FAILED=0 ⟺ zero MSG records ⟺ empty delta ⟺ EMPTY record
  # present (pass 2 emits it unconditionally) — the :-stalled default is a
  # tripwire for a pass-2 bug, pinned conservative (a frozen file's shape).
  # ONE expansion feeds both the log token and the wire reason (the
  # one-vocabulary contract must not be driftable between them).
  EMPTY_REASON="empty-delta-${SHAPE:-stalled}"
  um_log "skip=$EMPTY_REASON signal=$(um_signal_anomaly "$EMPTY_REASON" "$PROJECT")"
fi

exit 0
