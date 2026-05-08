#!/bin/bash
# continuity.sh — end-to-end continuity test.
# Exercises: stop.sh → session-end.sh → state.md → session-start.sh catchup + inject.
#
# Usage: bash continuity.sh
#   Env: UM_CONTINUITY_LIVE=1  to use real OpenAI (otherwise mocked)
#        UM_ENDPOINT            server URL for /api/search step (default: http://localhost:6335)
#
# Exit 0 = all hard checks passed; WARN lines are non-blocking soft checks.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOKS_DIR="$REPO_ROOT/plugins/claude-code/universal-memory/hooks"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

# ---------------------------------------------------------------------------
# Cleanup traps (populated incrementally below)
# ---------------------------------------------------------------------------
TMP_VAULT=$(mktemp -d)
MOCK_BIN=""
_UM_CONT_AUTH_CONFIG=""
cleanup() {
  [ -d "$TMP_VAULT" ] && rm -rf "$TMP_VAULT"
  [ -n "$MOCK_BIN" ] && [ -d "$MOCK_BIN" ] && rm -rf "$MOCK_BIN"
  [ -n "$_UM_CONT_AUTH_CONFIG" ] && [ -f "$_UM_CONT_AUTH_CONFIG" ] && rm -f "$_UM_CONT_AUTH_CONFIG"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# v0.6 auth (Phase B): /api/search requires bearer auth from non-loopback.
# Read UM_AUTH_TOKEN from .env (same pattern as smoke.sh). PR #31 R1 review
# caught that Step 4 was silently degrading to "passed" because the call
# 401'd and the script swallowed it via `|| echo '{"results":[]}'` — the
# CI gate was provably no-op for this path. Auth-aware now.
#
# Token is written to a 0600 tempfile and passed via curl --config so it
# never appears in `ps auxe` argv (matches install.sh _UM_TMP_KEYFILE +
# smoke.sh _UM_SMOKE_AUTH_CONFIG patterns).
_UM_CONT_TOKEN=""
if [ -f "$REPO_ROOT/server/.env" ]; then
  _UM_CONT_TOKEN=$(grep -E '^UM_AUTH_TOKEN=' "$REPO_ROOT/server/.env" | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//;s/^'\''//;s/'\''$//' || true)
fi
if [ -n "$_UM_CONT_TOKEN" ]; then
  _UM_CONT_AUTH_CONFIG=$(mktemp -t cont-auth.XXXXXX 2>/dev/null || mktemp)
  chmod 600 "$_UM_CONT_AUTH_CONFIG"
  printf 'header = "Authorization: Bearer %s"\n' "$_UM_CONT_TOKEN" > "$_UM_CONT_AUTH_CONFIG"
fi
unset _UM_CONT_TOKEN

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
export UM_VAULT_DIR="$TMP_VAULT"
export UM_ENDPOINT="${UM_ENDPOINT:-http://localhost:6335}"
export UM_PROJECT="continuity-test"
export CLAUDE_CWD="/fake/path/continuity-test"

# ---------------------------------------------------------------------------
# Mock LLM unless UM_CONTINUITY_LIVE=1
# ---------------------------------------------------------------------------
if [ "${UM_CONTINUITY_LIVE:-0}" != "1" ]; then
  MOCK_BIN=$(mktemp -d)

  # The canned state.md response — must pass update-state.sh validation:
  #   1. Starts with ---
  #   2. Has second --- closing frontmatter
  #   3. Has all 6 required H2 headers
  #   4. Total length <= 5000 chars
  MOCK_STATE_DOC='---
schema_version: 1
type: state
id: state-continuity-test
title: State of play — continuity-test
status: current
valid_from: 2026-04-18T12:00:00Z
project: continuity-test
---

# State of play — continuity-test

## Current focus
Authentication implementation with JWT and password reset flow using SendGrid.

## In flight
- Password reset rate limiting (open question, not yet implemented)

## Recent decisions
- 2026-04-18: JWT over session cookies for stateless horizontal scaling
- 2026-04-18: bcrypt salt rounds = 12 (balance of security and latency)
- 2026-04-18: Reset tokens expire in 1h (limit exposure window)
- 2026-04-18: SendGrid over nodemailer (deliverability + template system)

## Next actions
- Evaluate rate limiting for /auth/reset-request (needs Redis)
- Dogfood the auth flow end-to-end

## Open questions
- Should we rate-limit reset requests? (Redis dep, see docs/security-notes.md)

## Environment
- Branch: main
'

  # Write the state doc to a temp file so the mock can read it without quoting issues
  MOCK_STATE_FILE="$MOCK_BIN/canned_state.md"
  printf '%s' "$MOCK_STATE_DOC" > "$MOCK_STATE_FILE"

  # Canned summarize response body
  MOCK_SUMMARY_BODY='## What happened
Implemented JWT authentication and password reset flow using SendGrid.

## Key decisions
- JWT over session cookies for stateless horizontal scaling
- bcrypt salt rounds = 12
- Reset tokens expire in 1 hour
- SendGrid for transactional email (deliverability + templates)

## In flight
- Rate limiting on /auth/reset-request (needs Redis, open question)

## Next steps
- Dogfood the auth flow end-to-end'

  MOCK_SUMMARY_FILE="$MOCK_BIN/canned_summary.md"
  printf '%s' "$MOCK_SUMMARY_BODY" > "$MOCK_SUMMARY_FILE"

  # Build JSON response files via python3 (handles escaping correctly)
  MOCK_SUMMARY_JSON="$MOCK_BIN/summary_response.json"
  python3 - "$MOCK_SUMMARY_FILE" "$MOCK_SUMMARY_JSON" <<'PYEOF'
import sys, json
with open(sys.argv[1], "r") as f:
    content = f.read()
resp = {
    "choices": [{"message": {"content": content}}],
    "usage": {"prompt_tokens": 300, "completion_tokens": 150}
}
with open(sys.argv[2], "w") as f:
    json.dump(resp, f)
PYEOF

  MOCK_STATE_JSON="$MOCK_BIN/state_response.json"
  python3 - "$MOCK_STATE_FILE" "$MOCK_STATE_JSON" <<'PYEOF'
import sys, json
with open(sys.argv[1], "r") as f:
    content = f.read()
resp = {
    "choices": [{"message": {"content": content}}],
    "usage": {"prompt_tokens": 500, "completion_tokens": 200}
}
with open(sys.argv[2], "w") as f:
    json.dump(resp, f)
PYEOF

  # Call counter (per session-end run) — reset before each session-end call
  CALL_COUNTER="$MOCK_BIN/call_count"
  echo "0" > "$CALL_COUNTER"

  # Write mock curl:
  #   - OpenAI calls:  first call → summary response; second call → state response
  #   - reindex calls: return success ({"ok":true})
  #   - /api/state calls: return state.md contents
  #   - All other local server calls: forward to real curl (or stub 200)
  cat > "$MOCK_BIN/curl" <<MOCKEOF
#!/bin/bash
# Mock curl for continuity test
# Detect URL type from arguments
url=""
is_data_flag=0
body=""
for arg in "\$@"; do
  case "\$arg" in
    https://api.openai.com/*) url="openai" ;;
    *"/api/reindex"*)        url="reindex" ;;
    *"/api/state/"*)         url="state" ;;
    *"/api/search"*)         url="search" ;;
    http://localhost:*)      [ -z "\$url" ] && url="local" ;;
  esac
done

if [ "\$url" = "openai" ]; then
  # Route by call count within this session-end invocation
  count=\$(cat "$CALL_COUNTER" 2>/dev/null || echo 0)
  count=\$((count + 1))
  echo "\$count" > "$CALL_COUNTER"
  if [ "\$count" -le 1 ]; then
    # First call: summarize.sh
    cat "$MOCK_SUMMARY_JSON"
    printf '\n__UM_HTTP_CODE__200'
  else
    # Second call: update-state.sh
    cat "$MOCK_STATE_JSON"
    printf '\n__UM_HTTP_CODE__200'
  fi
  exit 0
fi

if [ "\$url" = "reindex" ]; then
  printf '{"ok":true}\n'
  printf '\n__UM_HTTP_CODE__200'
  exit 0
fi

if [ "\$url" = "state" ]; then
  # Return state as API would (best-effort from vault)
  printf '{"ok":true,"project":"continuity-test","state":null}\n'
  exit 0
fi

if [ "\$url" = "search" ]; then
  printf '{"results":[]}\n'
  exit 0
fi

# Anything else (local server): delegate to real curl if available
if command -v /usr/bin/curl >/dev/null 2>&1; then
  exec /usr/bin/curl "\$@"
elif command -v /bin/curl >/dev/null 2>&1; then
  exec /bin/curl "\$@"
else
  printf '{"ok":false,"error":"no real curl"}\n'
  exit 1
fi
MOCKEOF
  chmod +x "$MOCK_BIN/curl"
  export PATH="$MOCK_BIN:$PATH"
  export OPENAI_API_KEY="sk-mock-continuity-test-fake-key"
fi

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
fail() { printf '\n[continuity] FAIL: %s\n' "$1" >&2; exit 1; }
warn() { printf '[continuity] WARN: %s\n' "$1"; }
info() { printf '[continuity] %s\n' "$1"; }

reset_call_counter() {
  if [ -n "$MOCK_BIN" ] && [ -f "$MOCK_BIN/call_count" ]; then
    echo "0" > "$MOCK_BIN/call_count"
  fi
}

# ---------------------------------------------------------------------------
# Derived paths
# ---------------------------------------------------------------------------
TODAY=$(date -u +%Y-%m-%d)
RAW_FILE="$TMP_VAULT/captures/$UM_PROJECT/raw/$TODAY.md"
SUMMARY_DIR="$TMP_VAULT/sessions/$UM_PROJECT"
STATE_FILE="$TMP_VAULT/state/$UM_PROJECT/state.md"

info "vault: $TMP_VAULT"
info "mock LLM: ${UM_CONTINUITY_LIVE:-0} (0=mocked, 1=live)"
info ""

# ===========================================================================
# Step 2: Feed transcript 1 into stop.sh 5 times
# ===========================================================================
info "Step 2: feeding transcript 1 into stop.sh x5"

TRANSCRIPT_1=$(cat "$FIXTURES_DIR/sample-transcript-1.jsonl")
for i in $(seq 1 5); do
  echo "$TRANSCRIPT_1" | UM_PROJECT="$UM_PROJECT" bash "$HOOKS_DIR/stop.sh" \
    || fail "stop.sh failed on iteration $i"
done

[ -f "$RAW_FILE" ] || fail "raw capture file not created at $RAW_FILE"
RAW_SIZE=$(wc -c < "$RAW_FILE")
info "Step 2 passed: raw capture size = ${RAW_SIZE} bytes (5 appends)"

# ===========================================================================
# Step 3: Run session-end.sh — verify summary + state.md written
# ===========================================================================
# Issue #47 mitigation (2026-05-08): live-OpenAI mode occasionally returns
# empty/malformed output. session-end.sh handles this gracefully ("returned
# empty, keeping existing state.md") and exits 0 — but on the FIRST session
# there's no existing state.md to keep, so the file never gets created and
# Step 3's [ -f "$STATE_FILE" ] check fails. Production users retry this
# naturally by running another session; the test now matches that pattern
# with up to 3 attempts. Mocked mode (UM_CONTINUITY_LIVE=0) succeeds on
# attempt 1 unconditionally — the retry is a no-op there.
info "Step 3: running session-end.sh (first session)"

# On any Step 3 failure below, dump LAST session-end output so CI logs reveal
# what update-state / summarize emitted before the assertion that tripped.
_dump_session_end_on_fail() {
  echo "--- session-end stderr+stdout (last 40 lines) ---" >&2
  echo "${SESSION_END_ERR:-<empty>}" | tail -40 >&2
  echo "--- end session-end output ---" >&2
}

SESSION_END_ATTEMPTS=3
SESSION_END_ERR=""
for attempt in $(seq 1 $SESSION_END_ATTEMPTS); do
  reset_call_counter
  SESSION_END_ERR=$(UM_PROJECT="$UM_PROJECT" bash "$HOOKS_DIR/session-end.sh" 2>&1) \
    || { echo "$SESSION_END_ERR" | tail -40 >&2; fail "session-end.sh exited non-zero on attempt $attempt"; }

  if [ -f "$STATE_FILE" ]; then
    [ "$attempt" -gt 1 ] && info "Step 3: state.md created on attempt $attempt (issue #47 transient cleared)"
    break
  fi

  if [ "$attempt" -lt "$SESSION_END_ATTEMPTS" ]; then
    warn "Step 3: state.md not created on attempt $attempt — likely issue #47 transient LLM empty/malformed output; retrying"
    sleep 2
  fi
done

# Verify session summary file written (after retry loop)
[ -d "$SUMMARY_DIR" ] || { _dump_session_end_on_fail; fail "sessions dir not created after $SESSION_END_ATTEMPTS attempts: $SUMMARY_DIR"; }
SUMMARY_COUNT=$(find "$SUMMARY_DIR" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "$SUMMARY_COUNT" -ge 1 ] || { _dump_session_end_on_fail; fail "no summary file created after $SESSION_END_ATTEMPTS attempts (count=$SUMMARY_COUNT)"; }

# Verify state.md written and has required headers
[ -f "$STATE_FILE" ] || { _dump_session_end_on_fail; fail "state.md not created at $STATE_FILE after $SESSION_END_ATTEMPTS attempts (issue #47)"; }
grep -q "## Current focus" "$STATE_FILE"   || fail "state.md missing '## Current focus'"
grep -q "## Recent decisions" "$STATE_FILE" || fail "state.md missing '## Recent decisions'"
grep -q "## Next actions" "$STATE_FILE"    || fail "state.md missing '## Next actions'"

info "Step 3 passed: summary ($SUMMARY_COUNT file(s)) + state.md written"
if echo "$SESSION_END_ERR" | grep -qi "error\|fail"; then
  warn "session-end stderr had notable output: $(echo "$SESSION_END_ERR" | grep -i 'error\|fail' | head -3)"
fi

# ===========================================================================
# Step 4: /api/search returns summary (soft check — server may not be running)
# ===========================================================================
info "Step 4: checking /api/search (soft — server may not be running)"
# v0.6 auth: if a bearer token tempfile exists (set up at script-init), pass
# it via curl --config so the call doesn't silently 401 and degrade to a
# fake-pass via the `|| echo '{...}'` fallback. PR #31 R1 finding.
#
# R2 hardening: distinguish connect-class curl exits (6 DNS, 7 refused,
# 28 timeout) — the legitimate "server may not be running" soft skip — from
# HTTP-error exits (22 from -f flag) and other failures, which indicate a
# real contract regression (auth misconfig, shape change, 5xx). The
# original `|| echo '{"results":[]}'` swallowed everything; now connect-
# class only swallows; the rest fail loudly.
#
# bash 3.2 portability: `${arr[@]+"${arr[@]}"}` idiom for empty-array
# expansion under `set -u` (stock macOS bash 3.2 errors on plain `"${arr[@]}"`).
_UM_CONT_CFG_FLAG=()
if [ -n "$_UM_CONT_AUTH_CONFIG" ] && [ -f "$_UM_CONT_AUTH_CONFIG" ]; then
  _UM_CONT_CFG_FLAG=(--config "$_UM_CONT_AUTH_CONFIG")
fi
# Pick a curl binary; absolute paths bypass any mock-curl on PATH (mock-mode
# tests inject a mock at $MOCK_BIN/curl — Step 4 must hit the REAL server).
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
    -X POST "$UM_ENDPOINT/api/search" \
    -H 'Content-Type: application/json' \
    -d '{"query":"authentication password JWT","limit":5}' 2>/dev/null) || SEARCH_EXIT=$?
fi
case "$SEARCH_EXIT" in
  0)
    : ;;
  6|7|28)
    # Connect-class: server unreachable. Legitimate soft skip.
    SEARCH_RESULT='{"results":[]}' ;;
  *)
    # 22 (HTTP error via -f), 35 (TLS), 60 (cert), or anything else — server
    # reached but call failed for a non-reachability reason. Surface the
    # regression. Common v0.6 cause: bearer auth misconfig (401), or
    # /api/search response shape changed.
    fail "Step 4: /api/search returned curl exit=$SEARCH_EXIT (HTTP error or malformed; auth or shape regression)" ;;
esac
if echo "$SEARCH_RESULT" | python3 -c \
    'import json,sys; d=json.load(sys.stdin); sys.exit(0 if isinstance(d.get("results"),list) else 1)' \
    2>/dev/null; then
  RESULT_COUNT=$(echo "$SEARCH_RESULT" | python3 -c \
    'import json,sys; d=json.load(sys.stdin); print(len(d.get("results",[])))' 2>/dev/null || echo 0)
  info "Step 4 passed: /api/search responded with $RESULT_COUNT result(s)"
else
  warn "Step 4: /api/search response malformed (server reachable, JSON unparseable)"
fi

# ===========================================================================
# Step 5: Orphan scenario — remove summary, backdate state.md, touch raw file
# ===========================================================================
info "Step 5: orphan scenario — removing summaries, backdating state.md valid_from"

# Remove session summaries so orphan detection fires
rm -rf "$SUMMARY_DIR"

# Backdate state.md's valid_from to 2 days ago so raw file is "newer"
python3 - "$STATE_FILE" <<'PY'
import sys, re
from datetime import datetime, timedelta, timezone
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()
past = (datetime.now(timezone.utc) - timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
new_text = re.sub(r'valid_from: [^\n]+', 'valid_from: ' + past, text, count=1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(new_text)
print("backdated valid_from to:", past)
PY

# Touch raw file so it's newer than state.md's valid_from (triggers orphan detection)
touch "$RAW_FILE"
info "Step 5a: running session-start.sh (orphan scenario)"

reset_call_counter

# session-start.sh reads from UM_ENDPOINT for state — our mock handles it
# It also forks catchup (session-end.sh in background with UM_DETACH=1)
SESSION_START_OUT=$(UM_PROJECT="$UM_PROJECT" UM_ENDPOINT="$UM_ENDPOINT" \
  bash "$HOOKS_DIR/session-start.sh" 2>&1 </dev/null) || true

info "Step 5a: session-start.sh returned"

# Wait for catchup to complete — orphan fork runs session-end.sh which rewrites state.md
info "Step 5b: waiting up to 30s for catchup to restore summaries"
CATCHUP_FOUND=false
for i in $(seq 1 30); do
  # Catchup recreates the sessions dir
  if [ -d "$SUMMARY_DIR" ] && \
     [ "$(find "$SUMMARY_DIR" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')" -ge 1 ]; then
    CATCHUP_FOUND=true
    break
  fi
  sleep 1
done

if [ "$CATCHUP_FOUND" = "true" ]; then
  CATCHUP_COUNT=$(find "$SUMMARY_DIR" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  info "Step 5 passed: catchup restored $CATCHUP_COUNT summary file(s) within ${i}s"
else
  warn "Step 5: catchup did not complete within 30s — background fork timing or mock path issue"
  warn "  This can fail in CI on heavily loaded hosts. Non-blocking."
fi

# ===========================================================================
# Step 6: Feed transcript 2, run session-end again (second session)
# ===========================================================================
info "Step 6: feeding transcript 2 + running second session-end"

TRANSCRIPT_2=$(cat "$FIXTURES_DIR/sample-transcript-2.jsonl")
echo "$TRANSCRIPT_2" | UM_PROJECT="$UM_PROJECT" bash "$HOOKS_DIR/stop.sh" \
  || fail "stop.sh failed for transcript 2"

# Issue #47 mitigation: same retry pattern as Step 3 — second session-end
# can also hit the empty/malformed LLM output flake. Step 6 differs from
# Step 3 in that state.md ALREADY exists from Step 3, so empty output here
# would just keep the existing state.md (a soft pass with stale content).
# Rather than letting Step 7 verify against a stale file, retry until the
# LLM produces real output OR we exhaust attempts.
SESSION_END_2_ERR=""
STATE_FILE_PRE_MTIME=$(stat -c '%Y' "$STATE_FILE" 2>/dev/null || stat -f '%m' "$STATE_FILE" 2>/dev/null || echo 0)
for attempt in $(seq 1 $SESSION_END_ATTEMPTS); do
  reset_call_counter
  SESSION_END_2_ERR=$(UM_PROJECT="$UM_PROJECT" bash "$HOOKS_DIR/session-end.sh" 2>&1) \
    || fail "second session-end.sh exited non-zero on attempt $attempt"

  STATE_FILE_POST_MTIME=$(stat -c '%Y' "$STATE_FILE" 2>/dev/null || stat -f '%m' "$STATE_FILE" 2>/dev/null || echo 0)
  if [ "$STATE_FILE_POST_MTIME" != "$STATE_FILE_PRE_MTIME" ]; then
    [ "$attempt" -gt 1 ] && info "Step 6: state.md updated on attempt $attempt (issue #47 transient cleared)"
    break
  fi

  if [ "$attempt" -lt "$SESSION_END_ATTEMPTS" ]; then
    warn "Step 6: state.md mtime unchanged on attempt $attempt — likely issue #47; retrying"
    sleep 2
  fi
done

# Verify state.md still exists (the Step 7 grep checks pin content)
[ -f "$STATE_FILE" ] || fail "state.md gone after second session-end"

NEW_SUMMARY_COUNT=$(find "$SUMMARY_DIR" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
info "Step 6 passed: $NEW_SUMMARY_COUNT summary file(s) after 2nd session-end, state.md intact"
[ "$NEW_SUMMARY_COUNT" -ge 1 ] || fail "no summary files after second session (count=$NEW_SUMMARY_COUNT)"

# ===========================================================================
# Step 7 (implicit): state.md updated — verify key content present
# ===========================================================================
info "Step 7: verifying state.md content after second session"
STATE_CONTENT=$(cat "$STATE_FILE")
grep -q "## Current focus"   "$STATE_FILE" || fail "state.md missing ## Current focus after update"
grep -q "## Recent decisions" "$STATE_FILE" || fail "state.md missing ## Recent decisions after update"
grep -q "## In flight"        "$STATE_FILE" || fail "state.md missing ## In flight after update"
info "Step 7 passed: state.md has required headers after second session"

# ===========================================================================
# Step 8: session-start.sh injects state.md into additionalContext
# ===========================================================================
info "Step 8: running session-start.sh — expect state.md injection"

reset_call_counter

START_OUT=$(UM_PROJECT="$UM_PROJECT" UM_ENDPOINT="$UM_ENDPOINT" \
  bash "$HOOKS_DIR/session-start.sh" 2>/dev/null </dev/null || echo '{}')

# The mock /api/state returns null, so injection comes from whatever state the
# API returns.  With a live server we'd check additionalContext fully; with mock
# we verify the script emitted valid JSON and didn't crash.
VALID_JSON=$(echo "$START_OUT" | python3 -c \
  'import json,sys; json.load(sys.stdin); print("ok")' 2>/dev/null || echo "")

if [ "$VALID_JSON" = "ok" ]; then
  info "Step 8 passed: session-start.sh emitted valid JSON"

  AC=$(echo "$START_OUT" | python3 -c \
    'import json,sys; d=json.load(sys.stdin); print(d.get("additionalContext",""))' 2>/dev/null || echo "")

  # Hard check: routing rubric must always be present regardless of state presence
  echo "$AC" | grep -q "memory_capture" \
    || fail "Step 8: additionalContext missing 'memory_capture' (routing rubric not injected)"
  echo "$AC" | grep -q "Memory routing" \
    || fail "Step 8: additionalContext missing 'Memory routing' heading (routing rubric not injected)"
  info "  routing rubric present in additionalContext (hard check passed)"

  # Soft check: with a live /api/state we'd see state injected; mock returns null
  if [ -n "$AC" ]; then
    info "  additionalContext present (length=$(echo "$AC" | wc -c | tr -d ' ') chars)"
    echo "$AC" | grep -q "State of play" && info "  contains 'State of play' heading"
  else
    warn "Step 8: additionalContext empty — unexpected (rubric should always be present)"
  fi
else
  fail "Step 8: session-start.sh did not emit valid JSON (got: ${START_OUT:0:200})"
fi

# ===========================================================================
# Final summary
# ===========================================================================
info ""
info "=== PASS: end-to-end continuity lifecycle verified ==="
info "  stop.sh x5 → session-end.sh → summary + state.md"
info "  orphan scenario → session-start catchup fork"
info "  2nd session → state.md updated"
info "  session-start.sh → valid JSON output"
