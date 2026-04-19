#!/usr/bin/env bash
# hooks/session-start.test.sh — integration tests for session-start.sh
#
# Run: bash session-start.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   1. UM_ENDPOINT unset → emit '{}', exit 0 silently
#   2. No state.md (API returns {state:null}) → additionalContext empty/absent
#   3. Fresh state.md (valid_from within 7 days) → body injected verbatim
#   4. 7-30 days old → prefix added with last-active date
#   5. >30 days old → empty additionalContext (skipped)
#   6. No orphans → no background fork, read branch runs
#   7. Orphans exist → detached fork triggers; marker file appears within 5s
#   8. Return time — full script (with mocked curl) completes in <500ms

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_START="$SCRIPT_DIR/session-start.sh"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s\n' "$1"
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name (got='$got', want='$want')"; fi
}

assert_empty() {
  local name="$1" got="$2"
  if [ -z "$got" ]; then pass "$name"
  else fail "$name (expected empty, got='${got:0:120}')"; fi
}

assert_not_empty() {
  local name="$1" got="$2"
  if [ -n "$got" ]; then pass "$name"
  else fail "$name (expected non-empty, got empty)"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got='${haystack:0:200}')"; fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$name"
  else fail "$name (expected NOT to contain '$needle')"; fi
}

assert_file_exists() {
  local name="$1" path="$2"
  if [ -f "$path" ]; then pass "$name"
  else fail "$name (file not found: $path)"; fi
}

assert_file_missing() {
  local name="$1" path="$2"
  if [ ! -f "$path" ]; then pass "$name"
  else fail "$name (file should not exist: $path)"; fi
}

# ---------------------------------------------------------------------------
# Temp dir + global setup
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export UM_VAULT_DIR="$TMPDIR_ROOT/vault"
export CLAUDE_CWD="$TMPDIR_ROOT/testproject"
# No UM_PROJECT set — let project_name() derive from CLAUDE_CWD
PROJECT="testproject"

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

# ---------------------------------------------------------------------------
# Helper: write a mock curl script that returns a given JSON response
# ---------------------------------------------------------------------------
write_mock_curl() {
  local response_json="$1"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
# Mock curl — ignores all args, returns canned JSON
printf '%s' '$response_json'
exit 0
MOCK
  chmod +x "$MOCK_BIN/curl"
}

# Helper: write a mock curl that exits non-zero (simulates server error)
write_mock_curl_fail() {
  cat > "$MOCK_BIN/curl" <<'MOCK'
#!/bin/bash
exit 22
MOCK
  chmod +x "$MOCK_BIN/curl"
}

# Helper: extract additionalContext string value from JSON output
extract_additional_context() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("additionalContext", ""))
except Exception:
    print("")
' 2>/dev/null || echo ""
}

# Helper: write a state.md API response with given body and valid_from
make_state_response() {
  local body="$1"
  local valid_from="$2"  # ISO-8601
  python3 -c "
import json, sys
body = sys.argv[1]
vf = sys.argv[2]
resp = {
    'ok': True,
    'project': 'testproject',
    'state': {
        'frontmatter': {'valid_from': vf},
        'body': body,
        'valid_from': vf
    },
    'valid_from': vf
}
print(json.dumps(resp))
" "$body" "$valid_from"
}

# Helper: compute ISO date N days ago
days_ago_iso() {
  local n="$1"
  python3 -c "
from datetime import datetime, timedelta, timezone
dt = datetime.now(timezone.utc) - timedelta(days=$n)
print(dt.strftime('%Y-%m-%dT%H:%M:%SZ'))
"
}

# Fixture state body (no frontmatter — body only)
STATE_BODY="# State of play

## Current focus
Working on close-continuity-gap feature.

## In flight
- Task 16: session-start.sh rewrite

## Recent decisions
- 2026-04-17: Use /api/state instead of /api/search

## Next actions
- Implement catchup branch"

# ---------------------------------------------------------------------------
# Shared helper: assert rubric is present in additionalContext
# ---------------------------------------------------------------------------
assert_rubric_present() {
  local ac="$1" label_prefix="${2:-}"
  assert_contains "${label_prefix}additionalContext contains 'memory_capture'" "$ac" "memory_capture"
  assert_contains "${label_prefix}additionalContext contains 'Memory routing'" "$ac" "Memory routing"
}

# ---------------------------------------------------------------------------
# Test 1: UM_ENDPOINT unset → rubric-only additionalContext, exit 0
# ---------------------------------------------------------------------------
printf '\nTest 1: UM_ENDPOINT unset\n'
{
  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" 2>/dev/null)
  exit_code=$?
  assert_eq "exit 0 when UM_ENDPOINT unset" "$exit_code" "0"
  # Rubric should still be injected even when endpoint unset
  ac=$(extract_additional_context "$output")
  assert_rubric_present "$ac" "T1: "
}

# ---------------------------------------------------------------------------
# Test 2: state:null from API → rubric-only additionalContext
# ---------------------------------------------------------------------------
printf '\nTest 2: state:null from API\n'
{
  write_mock_curl '{"ok":true,"project":"testproject","state":null}'
  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" 2>/dev/null)
  ac=$(extract_additional_context "$output")
  assert_rubric_present "$ac" "T2: "
  assert_not_contains "T2: no State of play heading when state is null" "$ac" "State of play"
}

# ---------------------------------------------------------------------------
# Test 3: Fresh state.md (valid_from within 7 days) → body injected verbatim
# ---------------------------------------------------------------------------
printf '\nTest 3: Fresh state.md (< 7 days)\n'
{
  vf=$(days_ago_iso 2)
  resp=$(make_state_response "$STATE_BODY" "$vf")
  # Escape single quotes for embedding in mock (use temp file instead)
  resp_file="$TMPDIR_ROOT/resp3.json"
  printf '%s' "$resp" > "$resp_file"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
cat "$resp_file"
MOCK
  chmod +x "$MOCK_BIN/curl"

  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" 2>/dev/null)
  ac=$(extract_additional_context "$output")
  assert_not_empty "additionalContext non-empty for fresh state" "$ac"
  assert_contains "body injected verbatim (contains focus)" "$ac" "Current focus"
  assert_not_contains "no staleness prefix for fresh state" "$ac" "may be outdated"
  assert_rubric_present "$ac" "T3: "
}

# ---------------------------------------------------------------------------
# Test 4: State is 7-30 days old → prefix added with last-active date
# ---------------------------------------------------------------------------
printf '\nTest 4: Stale state.md (7-30 days)\n'
{
  vf=$(days_ago_iso 14)
  date_str="${vf:0:10}"  # YYYY-MM-DD
  resp=$(make_state_response "$STATE_BODY" "$vf")
  resp_file="$TMPDIR_ROOT/resp4.json"
  printf '%s' "$resp" > "$resp_file"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
cat "$resp_file"
MOCK
  chmod +x "$MOCK_BIN/curl"

  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" 2>/dev/null)
  ac=$(extract_additional_context "$output")
  assert_not_empty "additionalContext non-empty for 14-day-old state" "$ac"
  assert_contains "staleness prefix present" "$ac" "may be outdated"
  assert_contains "last-active date in prefix" "$ac" "$date_str"
  assert_contains "body content still present" "$ac" "Current focus"
  assert_rubric_present "$ac" "T4: "
}

# ---------------------------------------------------------------------------
# Test 5: State is >30 days old → empty additionalContext
# ---------------------------------------------------------------------------
printf '\nTest 5: Very stale state.md (>30 days)\n'
{
  vf=$(days_ago_iso 45)
  resp=$(make_state_response "$STATE_BODY" "$vf")
  resp_file="$TMPDIR_ROOT/resp5.json"
  printf '%s' "$resp" > "$resp_file"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
cat "$resp_file"
MOCK
  chmod +x "$MOCK_BIN/curl"

  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" 2>/dev/null)
  ac=$(extract_additional_context "$output")
  assert_rubric_present "$ac" "T5: "
  assert_not_contains "T5: no State of play when state is >30 days" "$ac" "State of play"
}

# ---------------------------------------------------------------------------
# Test 6: No orphans → no background fork, read branch runs normally
# ---------------------------------------------------------------------------
printf '\nTest 6: No orphans (read branch only)\n'
{
  # Clean vault — no raw captures
  rm -rf "$UM_VAULT_DIR"
  mkdir -p "$UM_VAULT_DIR"

  vf=$(days_ago_iso 1)
  resp=$(make_state_response "$STATE_BODY" "$vf")
  resp_file="$TMPDIR_ROOT/resp6.json"
  printf '%s' "$resp" > "$resp_file"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
cat "$resp_file"
MOCK
  chmod +x "$MOCK_BIN/curl"

  # Stub session-end.sh to write a marker if invoked
  marker_file="$TMPDIR_ROOT/catchup_marker_no_orphans"
  MOCK_SESSION_END="$TMPDIR_ROOT/mock_session_end.sh"
  cat > "$MOCK_SESSION_END" <<MEND
#!/bin/bash
touch "$marker_file"
MEND
  chmod +x "$MOCK_SESSION_END"

  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" 2>/dev/null)

  # No orphans → no fork → marker file should NOT exist
  assert_file_missing "no catchup fork when no orphans" "$marker_file"

  ac=$(extract_additional_context "$output")
  assert_not_empty "read branch still injects state when no orphans" "$ac"
  assert_rubric_present "$ac" "T6: "
}

# ---------------------------------------------------------------------------
# Test 7: Orphans exist → detached catchup fork triggered
# ---------------------------------------------------------------------------
printf '\nTest 7: Orphans exist → catchup fork\n'
{
  # Set up orphan raw captures (no state.md, no session summaries)
  rm -rf "$UM_VAULT_DIR"
  mkdir -p "$UM_VAULT_DIR/captures/$PROJECT/raw"

  # Create two raw files with specific mtimes
  raw1="$UM_VAULT_DIR/captures/$PROJECT/raw/2026-04-15.md"
  raw2="$UM_VAULT_DIR/captures/$PROJECT/raw/2026-04-16.md"
  printf '## content\nUser: did stuff\n' > "$raw1"
  printf '## content\nUser: did more stuff\n' > "$raw2"
  # Touch with specific times (raw1 older, raw2 newer)
  touch -t 202604150900 "$raw1" 2>/dev/null || true
  touch -t 202604161500 "$raw2" 2>/dev/null || true

  # Marker file path to detect fork
  marker_file="$TMPDIR_ROOT/catchup_marker_orphans"

  # Replace session-end.sh with a stub that writes the marker
  REAL_SESSION_END="$SCRIPT_DIR/session-end.sh"
  STUB_SESSION_END="$TMPDIR_ROOT/stub_session_end.sh"
  cat > "$STUB_SESSION_END" <<STUBEOF
#!/bin/bash
# Stub session-end.sh — writes marker to confirm invocation
touch "$marker_file"
exit 0
STUBEOF
  chmod +x "$STUB_SESSION_END"

  # API returns state:null (no state to inject — testing fork path)
  write_mock_curl '{"ok":true,"project":"testproject","state":null}'

  # Patch SESSION_START to use our stub session-end.sh
  # We create a wrapper that overrides the script dir's session-end.sh path
  # by creating a symlink in TMPDIR_ROOT/stub_hooks/
  stub_hooks="$TMPDIR_ROOT/stub_hooks"
  mkdir -p "$stub_hooks/lib"
  # Symlink all real hook files except session-end.sh
  ln -sf "$SCRIPT_DIR/auto-start.sh" "$stub_hooks/auto-start.sh" 2>/dev/null || true
  cp "$STUB_SESSION_END" "$stub_hooks/session-end.sh"
  # Symlink lib directory
  ln -sf "$SCRIPT_DIR/lib/vault.sh" "$stub_hooks/lib/vault.sh" 2>/dev/null || true
  ln -sf "$SCRIPT_DIR/lib/frontmatter.sh" "$stub_hooks/lib/frontmatter.sh" 2>/dev/null || true

  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$stub_hooks/../$(basename "$SESSION_START")" 2>/dev/null) || \
  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    SCRIPT_DIR_OVERRIDE="$stub_hooks" \
    bash "$SESSION_START" 2>/dev/null)

  # Wait up to 5s for marker file to appear (background fork)
  waited=0
  while [ ! -f "$marker_file" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done

  if [ -f "$marker_file" ]; then
    pass "catchup fork triggered (marker appeared within 5s)"
  else
    # The above symlink approach may not work because session-start.sh uses
    # SCRIPT_DIR internally. Try a direct approach: copy session-start.sh
    # to stub_hooks and run it from there.
    rm -f "$marker_file"
    cp "$SESSION_START" "$stub_hooks/session-start.sh"
    chmod +x "$stub_hooks/session-start.sh"

    output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
      UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
      bash "$stub_hooks/session-start.sh" 2>/dev/null) || true

    waited=0
    while [ ! -f "$marker_file" ] && [ "$waited" -lt 50 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done

    if [ -f "$marker_file" ]; then
      pass "catchup fork triggered (marker appeared within 5s)"
    else
      fail "catchup fork not triggered (marker '$marker_file' not found within 5s)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Test 8: Return time < 500ms (mocked curl, no orphans)
# ---------------------------------------------------------------------------
printf '\nTest 8: Return time < 500ms\n'
{
  # Clean vault — no orphans
  rm -rf "$UM_VAULT_DIR"
  mkdir -p "$UM_VAULT_DIR"

  vf=$(days_ago_iso 1)
  resp=$(make_state_response "$STATE_BODY" "$vf")
  resp_file="$TMPDIR_ROOT/resp8.json"
  printf '%s' "$resp" > "$resp_file"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
cat "$resp_file"
MOCK
  chmod +x "$MOCK_BIN/curl"

  start_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')
  PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" >/dev/null 2>&1
  end_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')
  elapsed=$((end_ms - start_ms))

  printf '    elapsed: %dms\n' "$elapsed"
  if [ "$elapsed" -lt 500 ]; then
    pass "return time <500ms (${elapsed}ms)"
  else
    fail "return time exceeded 500ms (${elapsed}ms)"
  fi
}

# ---------------------------------------------------------------------------
# Test 9: state.md missing + endpoint reachable → rubric injected, no state section
# ---------------------------------------------------------------------------
printf '\nTest 9: state missing + endpoint reachable → rubric-only context\n'
{
  rm -rf "$UM_VAULT_DIR"
  mkdir -p "$UM_VAULT_DIR"

  write_mock_curl '{"ok":true,"project":"testproject","state":null}'

  output=$(PATH="$MOCK_BIN:$PATH" UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
    bash "$SESSION_START" 2>/dev/null)
  ac=$(extract_additional_context "$output")
  assert_rubric_present "$ac" "T9: "
  assert_not_contains "T9: no State of play section when state missing" "$ac" "State of play"
  assert_not_contains "T9: no 'Current focus' when state missing" "$ac" "Current focus"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n---\n'
printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '\nFailed tests:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
