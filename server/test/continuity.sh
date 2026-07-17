#!/bin/bash
# continuity.sh — end-to-end continuity test (v2, API-always hook contract).
# Exercises: stop.sh (per-message capture) → session-end.sh (server checkpoint)
#            → second session delta → session-start.sh state injection.
#
# Usage: bash continuity.sh
#   Env: UM_CONTINUITY_LIVE=1  to run against a real local server (otherwise
#                              all hook HTTP traffic is captured by a mock curl)
#        UM_ENDPOINT / UM_SERVER_URL  server URL for live mode + the /api/search
#                              soft check (default: http://localhost:6335)
#
# #159 rewrite (spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §5): the
# hooks are now thin HTTP clients — stop.sh reads a metadata JSON on stdin,
# parses the transcript JSONL at transcript_path, and POSTs one
# /api/append-turn per new eligible message behind a delta cursor at
# ~/.um/state/stop-cursor-<session_id>; session-end.sh POSTs /api/checkpoint
# {project} from a detached child; session-start.sh GETs /api/state/<project>
# and injects it via the hookSpecificOutput.additionalContext envelope. NO
# client-side vault writes exist anymore.
#
# Old-contract assertions and their v2 equivalents:
#   raw file created + grows on 5 stop fires
#       → exactly N append-turn POSTs on fire 1, ZERO on fires 2-5 (delta
#         cursor idempotency), cursor file advanced to the transcript line count.
#   session-end writes summary + state.md locally
#       → session-end POSTs /api/checkpoint {project} (detached child observed
#         via the mock capture / hook.log). Server-side synthesis (summary +
#         state.md written FROM the appended turns, real LLM) is proven by
#         smoke.sh S10 (UM_SMOKE_REMOTE_RT=1 leg in CI) — not re-proven here.
#   orphan-catchup fork (Step 5 of the old test)
#       → RETIRED with the feature (spec §5): no client-side raw files exist,
#         so there is nothing to orphan. Missed-capture recovery is now the
#         delta cursor's at-least-once resend, covered by hooks/stop.test.sh
#         S3 (failure-half resend) and by the idempotency leg here.
#   second session updates state.md
#       → transcript extended by 2 eligible lines ⇒ exactly 2 NEW append-turn
#         POSTs (delta, not a resend) + a second /api/checkpoint POST.
#   session-start injects state.md into additionalContext
#       → mock /api/state returns a canned state doc; assert the emitted
#         hookSpecificOutput.additionalContext envelope carries the state body
#         + the routing rubric, and no G7 "captures are OFF" banner (the write
#         probe sees a healthy 400-on-empty-body response).
#   /api/search returns results (soft, real server)
#       → kept as-is (hook-independent; auth-aware; connect-class soft skip).
#
# Exit 0 = all hard checks passed; WARN lines are non-blocking soft checks.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOKS_DIR="$REPO_ROOT/plugins/claude-code/universal-memory/hooks"
HOOK_FIXTURES="$HOOKS_DIR/fixtures"

LIVE="${UM_CONTINUITY_LIVE:-0}"

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
fail() { printf '\n[continuity] FAIL: %s\n' "$1" >&2; exit 1; }
warn() { printf '[continuity] WARN: %s\n' "$1"; }
info() { printf '[continuity] %s\n' "$1"; }

# ---------------------------------------------------------------------------
# Cleanup traps (populated incrementally below)
# ---------------------------------------------------------------------------
TMP_ROOT=$(mktemp -d)
_UM_CONT_AUTH_CONFIG=""
cleanup() {
  [ -d "$TMP_ROOT" ] && rm -rf "$TMP_ROOT"
  [ -n "$_UM_CONT_AUTH_CONFIG" ] && [ -f "$_UM_CONT_AUTH_CONFIG" ] && rm -f "$_UM_CONT_AUTH_CONFIG"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Interpreter probe — same order the hooks use (py → python3 → python;
# Windows Store `python3` stubs exist on PATH but don't run).
# ---------------------------------------------------------------------------
PYBIN=""
for _c in py python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c '' >/dev/null 2>&1; then
    PYBIN="$_c"; break
  fi
done
[ -n "$PYBIN" ] || fail "no working python interpreter (need py/python3/python)"

# Bash path → platform-native shape (what Claude Code puts in transcript_path
# on Windows). No-op on Linux CI.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"
  else printf '%s' "$1"; fi
}

# ---------------------------------------------------------------------------
# v0.6 auth for the /api/search soft check: read UM_AUTH_TOKEN from .env
# (same pattern as smoke.sh; PR #31 R1 caught the silent-401 degrade). Token
# goes to a 0600 tempfile passed via curl --config so it never appears in
# `ps auxe` argv. In live mode the SAME token also feeds the hooks via
# UM_TOKEN_FILE (CI reaches the container through Docker's NAT bridge —
# non-loopback — so bearer auth is required on every /api/* call).
# ---------------------------------------------------------------------------
_UM_CONT_TOKEN=""
if [ -f "$REPO_ROOT/server/.env" ]; then
  _UM_CONT_TOKEN=$(grep -E '^UM_AUTH_TOKEN=' "$REPO_ROOT/server/.env" | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//;s/^'\''//;s/'\''$//' || true)
fi
if [ -n "$_UM_CONT_TOKEN" ]; then
  _UM_CONT_AUTH_CONFIG=$(mktemp -t cont-auth.XXXXXX 2>/dev/null || mktemp)
  chmod 600 "$_UM_CONT_AUTH_CONFIG"
  printf 'header = "Authorization: Bearer %s"\n' "$_UM_CONT_TOKEN" > "$_UM_CONT_AUTH_CONFIG"
fi

# ---------------------------------------------------------------------------
# Isolated HOME — the hooks write ~/.um/state/stop-cursor-* + ~/.um/hook.log;
# both must be test-local. Endpoint + token wiring per mode.
# ---------------------------------------------------------------------------
TEST_HOME="$TMP_ROOT/home"
mkdir -p "$TEST_HOME/.um"
HOOK_LOG="$TEST_HOME/.um/hook.log"

SEARCH_ENDPOINT="${UM_SERVER_URL:-${UM_ENDPOINT:-http://localhost:6335}}"
if [ "$LIVE" = "1" ]; then
  HOOK_ENDPOINT="$SEARCH_ENDPOINT"
  if [ -n "$_UM_CONT_TOKEN" ]; then
    printf '%s' "$_UM_CONT_TOKEN" > "$TEST_HOME/.um/auth-token"
    chmod 600 "$TEST_HOME/.um/auth-token"
  fi
else
  # A non-resolvable host: if the PATH mock ever fails to intercept, calls
  # die with 000 instead of accidentally hitting a real server.
  HOOK_ENDPOINT="http://mock.example:6335"
fi
unset _UM_CONT_TOKEN

# ---------------------------------------------------------------------------
# Session fixtures — copy the hook fixture transcript to a temp path and
# build the stdin metadata JSONs pointing at it. The fixture has 13 lines of
# which 5 are eligible (lines 2,6,8,12,13); lines 1,3,4,5,7,9,10,11 exercise
# the skip rules (queue-op / isMeta / system-reminder / thinking-only /
# tool_result / isSidechain / type:system / synthetic api-error).
# ---------------------------------------------------------------------------
SESSION_ID="continuity-test-0001"
PROJECT="continuity-test"
FAKE_CWD="/fake/path/$PROJECT"
TRANSCRIPT="$TMP_ROOT/transcript.jsonl"
cp "$HOOK_FIXTURES/transcript-sample.jsonl" "$TRANSCRIPT"
TRANSCRIPT_NATIVE=$(native_path "$TRANSCRIPT")

EXPECT_MSGS_1=5     # eligible messages in the fixture transcript
EXPECT_CURSOR_1=13  # total transcript lines after fire 1 (clean uncapped fire)
EXPECT_MSGS_2=2     # eligible messages appended for the "second session"
EXPECT_CURSOR_2=15

make_stdin() {  # <hook_event_name>
  "$PYBIN" -c '
import json, sys
print(json.dumps({
    "session_id": sys.argv[1],
    "transcript_path": sys.argv[2],
    "cwd": sys.argv[3],
    "permission_mode": "default",
    "hook_event_name": sys.argv[4],
    "stop_hook_active": False,
    "reason": "exit",
}))' "$SESSION_ID" "$TRANSCRIPT_NATIVE" "$FAKE_CWD" "$1"
}
STOP_STDIN=$(make_stdin Stop)
END_STDIN=$(make_stdin SessionEnd)
CURSOR_FILE="$TEST_HOME/.um/state/stop-cursor-$SESSION_ID"

# ---------------------------------------------------------------------------
# Mock curl (mock mode only) — stop.test.sh conventions: captures the URL and
# -d body of every call to $CAP_DIR/url_N + $CAP_DIR/body_N, then answers
# with the __UM_HTTP_CODE__ sentinel the hooks' um-api.sh parses. Routing:
#   /api/append-turn with body '{}'  → 400  (session-start G7 probe: healthy —
#                                      validation rejected the empty body
#                                      AFTER the write gate passed)
#   /api/append-turn otherwise       → 200 {"ok":true}
#   /api/checkpoint                  → 200 {"ok":true}
#   /api/state/<project>             → 200 canned state doc (fresh valid_from)
#   anything else (/health, …)       → 200 {"ok":true}
# ---------------------------------------------------------------------------
CAP_DIR="$TMP_ROOT/captured"
mkdir -p "$CAP_DIR"

if [ "$LIVE" != "1" ]; then
  MOCK_BIN="$TMP_ROOT/mock_bin"
  mkdir -p "$MOCK_BIN"

  # Canned /api/state response — body must carry the headers session-start
  # injects verbatim; valid_from is NOW so the ≤7d "fresh" rule applies.
  "$PYBIN" - "$CAP_DIR/state_response.json" <<'PYEOF'
import json, sys
from datetime import datetime, timezone
body = """# State of play — continuity-test

## Current focus
Authentication implementation with JWT and password reset flow using SendGrid.

## In flight
- Password reset rate limiting (open question, not yet implemented)

## Recent decisions
- 2026-04-18: JWT over session cookies for stateless horizontal scaling
- 2026-04-18: bcrypt salt rounds = 12 (balance of security and latency)

## Next actions
- Evaluate rate limiting for /auth/reset-request (needs Redis)

## Open questions
- Should we rate-limit reset requests? (Redis dep)

## Environment
- Branch: main
"""
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
resp = {"ok": True, "project": "continuity-test",
        "state": {"body": body, "frontmatter": {"valid_from": now}}}
with open(sys.argv[1], "w") as f:
    json.dump(resp, f)
PYEOF

  cat > "$MOCK_BIN/curl" <<MOCK_EOF
#!/usr/bin/env bash
CAP_DIR="$CAP_DIR"
MOCK_EOF
  cat >> "$MOCK_BIN/curl" <<'MOCK_EOF'
count=$(cat "$CAP_DIR/count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$CAP_DIR/count"

url=""; body=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then body="$arg"; fi
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
  prev="$arg"
done
printf '%s' "$url"  > "$CAP_DIR/url_$count"
printf '%s' "$body" > "$CAP_DIR/body_$count"

case "$url" in
  */api/append-turn*)
    if [ "$body" = "{}" ]; then
      printf '{"ok":false,"error":"content is required"}\n__UM_HTTP_CODE__400'
    else
      printf '{"ok":true}\n__UM_HTTP_CODE__200'
    fi
    ;;
  */api/checkpoint*)
    printf '{"ok":true}\n__UM_HTTP_CODE__200'
    ;;
  */api/state/*)
    cat "$CAP_DIR/state_response.json"
    printf '\n__UM_HTTP_CODE__200'
    ;;
  *)
    printf '{"ok":true}\n__UM_HTTP_CODE__200'
    ;;
esac
exit 0
MOCK_EOF
  chmod +x "$MOCK_BIN/curl"
fi

# run_hook <script> <stdin> — run a hook with the isolated HOME + endpoint
# wiring (mock curl first on PATH in mock mode). stdout → $RUN_OUT.
run_hook() {
  local stdin_json="$2" hookpath="$HOOKS_DIR/$1"
  local run_path="$PATH"
  [ "$LIVE" != "1" ] && run_path="$MOCK_BIN:$PATH"
  RUN_EXIT=0
  RUN_OUT=$(HOME="$TEST_HOME" PATH="$run_path" \
    UM_SERVER_URL="$HOOK_ENDPOINT" \
    UM_TOKEN_FILE="$TEST_HOME/.um/auth-token" \
    CLAUDE_CWD="$FAKE_CWD" \
    bash "$hookpath" <<< "$stdin_json" 2>/dev/null) || RUN_EXIT=$?
}

# Mock-capture scanners (append-turn counting EXCLUDES the '{}' G7 probe).
# Iterate in strict call order via the mock's own counter — no ls parsing.
mock_call_total() { cat "$CAP_DIR/count" 2>/dev/null || echo 0; }
append_post_count() {
  local n=0 i total
  total=$(mock_call_total)
  for i in $(seq 1 "$total"); do
    [ -f "$CAP_DIR/url_$i" ] || continue
    case "$(cat "$CAP_DIR/url_$i")" in
      */api/append-turn*)
        [ "$(cat "$CAP_DIR/body_$i")" != "{}" ] && n=$((n + 1)) ;;
    esac
  done
  echo "$n"
}
checkpoint_count() {
  local n=0 i total
  total=$(mock_call_total)
  for i in $(seq 1 "$total"); do
    [ -f "$CAP_DIR/url_$i" ] || continue
    case "$(cat "$CAP_DIR/url_$i")" in
      */api/checkpoint*) n=$((n + 1)) ;;
    esac
  done
  echo "$n"
}
# append_body <n> — path of the Nth (1-based, call order) append-turn body.
append_body() {
  local want="$1" n=0 i total
  total=$(mock_call_total)
  for i in $(seq 1 "$total"); do
    [ -f "$CAP_DIR/url_$i" ] || continue
    case "$(cat "$CAP_DIR/url_$i")" in
      */api/append-turn*)
        if [ "$(cat "$CAP_DIR/body_$i")" != "{}" ]; then
          n=$((n + 1))
          if [ "$n" = "$want" ]; then printf '%s' "$CAP_DIR/body_$i"; return 0; fi
        fi ;;
    esac
  done
  return 1
}
body_field() {  # <body_path> <field>
  "$PYBIN" -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    b = json.load(fh)
v = b.get(sys.argv[2])
sys.stdout.write("" if v is None else str(v))' "$1" "$2"
}

log_count() {
  local n
  n=$(grep -c "$1" "$HOOK_LOG" 2>/dev/null) || n=0
  echo "${n:-0}"
}
wait_for_log() {  # <pattern> <min_count> <timeout_s> — rc 0 when reached
  local pattern="$1" want="$2" timeout="$3" i
  for i in $(seq 1 "$timeout"); do
    [ "$(log_count "$pattern")" -ge "$want" ] && return 0
    sleep 1
  done
  return 1
}

info "home:     $TEST_HOME"
info "endpoint: $HOOK_ENDPOINT"
info "mode:     $LIVE (0=mock curl, 1=live server)"
info ""

# ===========================================================================
# Step 1: fire stop.sh 5× on the same transcript — first fire captures every
# eligible message; fires 2-5 are ZERO-post no-ops (delta cursor idempotency,
# the v2 equivalent of the old "raw file grows then dedups").
# ===========================================================================
info "Step 1: stop.sh x5 on the fixture transcript"

for i in $(seq 1 5); do
  run_hook stop.sh "$STOP_STDIN"
  [ "$RUN_EXIT" = 0 ] || fail "stop.sh exited $RUN_EXIT on fire $i (fail-open contract broken)"
done

# Wire-level count (mock) — exactly EXPECT_MSGS_1 POSTs total across 5 fires.
if [ "$LIVE" != "1" ]; then
  GOT=$(append_post_count)
  [ "$GOT" = "$EXPECT_MSGS_1" ] \
    || fail "Step 1: expected exactly $EXPECT_MSGS_1 append-turn POSTs after 5 fires, got $GOT (idempotency or eligibility regression)"

  # Body spot-checks: first + last eligible message; skip-rule content must
  # never appear in any POSTed body.
  B1=$(append_body 1) || fail "Step 1: first append-turn body missing"
  [ "$(body_field "$B1" project)" = "$PROJECT" ] || fail "Step 1: body 1 project != $PROJECT"
  [ "$(body_field "$B1" role)" = "user" ]        || fail "Step 1: body 1 role != user"
  case "$(body_field "$B1" content)" in
    *"review the config loader"*) : ;;
    *) fail "Step 1: body 1 content is not the first user message" ;;
  esac
  B5=$(append_body 5) || fail "Step 1: fifth append-turn body missing"
  [ "$(body_field "$B5" role)" = "user" ] || fail "Step 1: body 5 role != user"
  case "$(body_field "$B5" content)" in
    *CHANGELOG*) : ;;
    *) fail "Step 1: body 5 content missing the mixed-line real text" ;;
  esac
  ALL_BODIES=$(cat "$CAP_DIR"/body_* 2>/dev/null)
  case "$ALL_BODIES" in
    *"Mixed-line reminder"*) fail "Step 1: a system-reminder block leaked into a POST" ;;
  esac
  case "$ALL_BODIES" in
    *"Scrubbed thinking"*) fail "Step 1: thinking-only content leaked into a POST" ;;
  esac
  info "Step 1: wire check passed ($GOT POSTs, bodies well-formed, skip rules held)"
fi

# hook.log evidence (both modes): one posted n=5 line + four empty-delta skips.
[ "$(log_count "stop posted http=2[0-9][0-9] n=$EXPECT_MSGS_1")" -ge 1 ] \
  || fail "Step 1: hook.log missing 'stop posted … n=$EXPECT_MSGS_1' (got: $(grep ' stop ' "$HOOK_LOG" 2>/dev/null | tail -5 | tr '\n' '|'))"
EMPTY_DELTAS=$(log_count "stop skip=empty-delta")
[ "$EMPTY_DELTAS" = 4 ] \
  || fail "Step 1: expected 4 empty-delta fires (2-5), hook.log has $EMPTY_DELTAS"

# Cursor advanced to the full transcript line count and held there.
[ -f "$CURSOR_FILE" ] || fail "Step 1: cursor file not created at $CURSOR_FILE"
CURSOR_VAL=$(cat "$CURSOR_FILE")
[ "$CURSOR_VAL" = "$EXPECT_CURSOR_1" ] \
  || fail "Step 1: cursor=$CURSOR_VAL, want $EXPECT_CURSOR_1"

info "Step 1 passed: $EXPECT_MSGS_1 captures on fire 1, zero on fires 2-5, cursor=$CURSOR_VAL"

# ===========================================================================
# Step 2: session-end.sh — detached child POSTs /api/checkpoint {project}.
# The parent returns immediately; poll for the child's result. In live mode
# this triggers a REAL server-side checkpoint (LLM synthesis from the turns
# appended in Step 1) — content correctness of that synthesis is S10's job
# (smoke.sh remote round-trip); here we assert the hook's wire behavior.
# ===========================================================================
info "Step 2: session-end.sh (first session checkpoint)"

run_hook session-end.sh "$END_STDIN"
[ "$RUN_EXIT" = 0 ] || fail "session-end.sh exited $RUN_EXIT (fail-open contract broken)"

CKPT_TIMEOUT=30
[ "$LIVE" = "1" ] && CKPT_TIMEOUT=120   # real LLM synthesis, child max-time 120s
wait_for_log " session-end posted http=2[0-9][0-9]" 1 "$CKPT_TIMEOUT" \
  || fail "Step 2: no 'session-end posted' hook.log line within ${CKPT_TIMEOUT}s (log tail: $(tail -3 "$HOOK_LOG" 2>/dev/null | tr '\n' '|'))"

if [ "$LIVE" != "1" ]; then
  GOT=$(checkpoint_count)
  [ "$GOT" = 1 ] || fail "Step 2: expected 1 /api/checkpoint POST, got $GOT"
  # Find and verify the checkpoint body.
  for i in $(seq 1 "$(mock_call_total)"); do
    [ -f "$CAP_DIR/url_$i" ] || continue
    case "$(cat "$CAP_DIR/url_$i")" in
      */api/checkpoint*)
        CKPT_PROJECT=$(body_field "$CAP_DIR/body_$i" project)
        [ "$CKPT_PROJECT" = "$PROJECT" ] \
          || fail "Step 2: checkpoint body project='$CKPT_PROJECT', want '$PROJECT'"
        ;;
    esac
  done
fi

info "Step 2 passed: checkpoint POSTed for project=$PROJECT"

# ===========================================================================
# Step 3: /api/search returns results (soft check — server may not be
# running). Kept from the old test verbatim: hook-independent, auth-aware
# (PR #31 R1), connect-class-only soft skip (R2 hardening).
# ===========================================================================
info "Step 3: checking /api/search (soft — server may not be running)"
# bash 3.2 portability: `${arr[@]+"${arr[@]}"}` idiom for empty-array
# expansion under `set -u` (stock macOS bash 3.2 errors on plain `"${arr[@]}"`).
_UM_CONT_CFG_FLAG=()
if [ -n "$_UM_CONT_AUTH_CONFIG" ] && [ -f "$_UM_CONT_AUTH_CONFIG" ]; then
  _UM_CONT_CFG_FLAG=(--config "$_UM_CONT_AUTH_CONFIG")
fi
# Absolute curl path bypasses the mock on PATH — this step must hit the REAL
# server when one is up.
if [ -x /usr/bin/curl ]; then
  _UM_CONT_CURL=/usr/bin/curl
elif [ -x /bin/curl ]; then
  _UM_CONT_CURL=/bin/curl
else
  _UM_CONT_CURL=""
fi
SEARCH_EXIT=0
SEARCH_RESULT=""
if [ -n "$_UM_CONT_CURL" ]; then
  SEARCH_RESULT=$("$_UM_CONT_CURL" -sf --max-time 3 \
    ${_UM_CONT_CFG_FLAG[@]+"${_UM_CONT_CFG_FLAG[@]}"} \
    -X POST "$SEARCH_ENDPOINT/api/search" \
    -H 'Content-Type: application/json' \
    -d '{"query":"config loader missing-file guard","limit":5}' 2>/dev/null) || SEARCH_EXIT=$?
fi
case "$SEARCH_EXIT" in
  0)
    : ;;
  6|7|28)
    # Connect-class: server unreachable. Legitimate soft skip.
    SEARCH_RESULT='{"results":[]}' ;;
  *)
    # 22 (HTTP error via -f), 35 (TLS), 60 (cert), or anything else — server
    # reached but call failed for a non-reachability reason (auth misconfig
    # or /api/search shape regression). Surface it.
    fail "Step 3: /api/search returned curl exit=$SEARCH_EXIT (HTTP error or malformed; auth or shape regression)" ;;
esac
if echo "$SEARCH_RESULT" | "$PYBIN" -c \
    'import json,sys; d=json.load(sys.stdin); sys.exit(0 if isinstance(d.get("results"),list) else 1)' \
    2>/dev/null; then
  RESULT_COUNT=$(echo "$SEARCH_RESULT" | "$PYBIN" -c \
    'import json,sys; d=json.load(sys.stdin); print(len(d.get("results",[])))' 2>/dev/null || echo 0)
  info "Step 3 passed: /api/search responded with $RESULT_COUNT result(s)"
else
  warn "Step 3: /api/search response malformed (server reachable, JSON unparseable)"
fi

# ===========================================================================
# Step 4: second session — extend the transcript with 2 new eligible
# messages; one stop fire must POST exactly those 2 (delta, not a resend),
# then a second session-end must trigger a second checkpoint.
# ===========================================================================
info "Step 4: second session — transcript delta + second checkpoint"

"$PYBIN" - "$TRANSCRIPT" <<'PYEOF'
import json, sys
lines = [
    {"type": "user", "isSidechain": False,
     "message": {"role": "user",
                 "content": "Second session: please tighten the config-loader error message."},
     "uuid": "c0000000-0000-4000-8000-00000000000d",
     "timestamp": "2026-07-17T15:00:00.000Z"},
    {"type": "assistant", "isSidechain": False,
     "message": {"role": "assistant", "model": "claude-opus-4-8",
                 "content": [{"type": "text",
                              "text": "Tightened the error message; tests still pass."}]},
     "uuid": "c0000000-0000-4000-8000-00000000000e",
     "timestamp": "2026-07-17T15:00:10.000Z"},
]
with open(sys.argv[1], "a", encoding="utf-8") as fh:
    for l in lines:
        fh.write(json.dumps(l) + "\n")
PYEOF

if [ "$LIVE" != "1" ]; then PRE_COUNT=$(append_post_count); fi
run_hook stop.sh "$STOP_STDIN"
[ "$RUN_EXIT" = 0 ] || fail "stop.sh exited $RUN_EXIT on the second-session fire"

if [ "$LIVE" != "1" ]; then
  GOT=$(( $(append_post_count) - PRE_COUNT ))
  [ "$GOT" = "$EXPECT_MSGS_2" ] \
    || fail "Step 4: expected exactly $EXPECT_MSGS_2 new append-turn POSTs, got $GOT (delta regression)"
fi
[ "$(log_count "stop posted http=2[0-9][0-9] n=$EXPECT_MSGS_2")" -ge 1 ] \
  || fail "Step 4: hook.log missing 'stop posted … n=$EXPECT_MSGS_2'"
CURSOR_VAL=$(cat "$CURSOR_FILE")
[ "$CURSOR_VAL" = "$EXPECT_CURSOR_2" ] \
  || fail "Step 4: cursor=$CURSOR_VAL after second-session fire, want $EXPECT_CURSOR_2"

run_hook session-end.sh "$END_STDIN"
[ "$RUN_EXIT" = 0 ] || fail "second session-end.sh exited $RUN_EXIT"
wait_for_log " session-end posted http=2[0-9][0-9]" 2 "$CKPT_TIMEOUT" \
  || fail "Step 4: second 'session-end posted' hook.log line not seen within ${CKPT_TIMEOUT}s"
if [ "$LIVE" != "1" ]; then
  GOT=$(checkpoint_count)
  [ "$GOT" = 2 ] || fail "Step 4: expected 2 /api/checkpoint POSTs total, got $GOT"
fi

info "Step 4 passed: 2 delta captures (cursor=$CURSOR_VAL) + second checkpoint"

# ===========================================================================
# Step 5: session-start.sh — GET /api/state/<project>, inject via the
# hookSpecificOutput.additionalContext envelope. Mock returns the canned
# fresh state doc; live returns whatever the Step 2/4 checkpoints synthesized
# (content shape is LLM output — S10 owns its correctness; here we assert the
# envelope + rubric hard, state-body presence soft in live mode).
# ===========================================================================
info "Step 5: session-start.sh — state injection envelope"

run_hook session-start.sh '{}'
START_OUT="$RUN_OUT"

ENVELOPE_CHECK=$(printf '%s' "$START_OUT" | "$PYBIN" -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("BAD-JSON"); sys.exit(0)
h = d.get("hookSpecificOutput") or {}
if h.get("hookEventName") != "SessionStart":
    print("BAD-EVENT"); sys.exit(0)
sys.stdout.write("OK\n" + (h.get("additionalContext") or ""))
' 2>/dev/null)

case "$ENVELOPE_CHECK" in
  OK*) : ;;
  *)   fail "Step 5: bad session-start envelope ($ENVELOPE_CHECK; raw: ${START_OUT:0:200})" ;;
esac
AC="${ENVELOPE_CHECK#OK}"

# Hard: routing rubric always present regardless of state presence.
case "$AC" in
  *memory_capture*) : ;;
  *) fail "Step 5: additionalContext missing 'memory_capture' (routing rubric not injected)" ;;
esac
case "$AC" in
  *"Memory routing"*) : ;;
  *) fail "Step 5: additionalContext missing 'Memory routing' heading (routing rubric not injected)" ;;
esac

# Hard: no G7 "captures are OFF" banner — the write-path probe must have seen
# a healthy server (mock: 400-on-empty-body; live: real validation 400).
case "$AC" in
  *"captures are OFF"*) fail "Step 5: G7 banner present against a healthy server (probe taxonomy regression)" ;;
esac

if [ "$LIVE" != "1" ]; then
  # Hard (mock): the canned state body must be injected verbatim-fresh.
  case "$AC" in
    *"State of play"*) : ;;
    *) fail "Step 5: additionalContext missing the canned 'State of play' heading" ;;
  esac
  case "$AC" in
    *"Current focus"*) : ;;
    *) fail "Step 5: additionalContext missing the canned '## Current focus' section" ;;
  esac
  info "Step 5 passed: envelope valid, state body + rubric injected, no G7 banner"
else
  # Live: state body is real LLM output from the Step 2/4 checkpoints. Its
  # exact shape is S10-owned; presence of ANY state content beyond the rubric
  # is the continuity signal here.
  case "$AC" in
    *"Current focus"*) info "Step 5: live state body injected (contains 'Current focus')" ;;
    *) warn "Step 5: live additionalContext lacks 'Current focus' — checkpoint synthesis shape drifted or state not yet indexed (S10 owns synthesis correctness)" ;;
  esac
  info "Step 5 passed: envelope valid, rubric injected, no G7 banner"
fi

# ===========================================================================
# Final summary
# ===========================================================================
info ""
info "=== PASS: end-to-end continuity lifecycle verified (v2 API-always) ==="
info "  stop.sh x5 → $EXPECT_MSGS_1 append-turn POSTs once, idempotent after (cursor=$EXPECT_CURSOR_1)"
info "  session-end.sh → detached /api/checkpoint {project}"
info "  2nd session delta → $EXPECT_MSGS_2 new POSTs (cursor=$EXPECT_CURSOR_2) + 2nd checkpoint"
info "  session-start.sh → hookSpecificOutput envelope w/ state + rubric"
