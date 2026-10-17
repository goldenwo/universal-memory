#!/usr/bin/env bash
# hooks/lib/update-state.test.sh — unit tests for update-state.sh
# Run: bash update-state.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Tests stub OpenAI via mock curl injected into PATH.
# No real API calls are made.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_STATE="$SCRIPT_DIR/update-state.sh"

# --- Test harness ---

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

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle')"; fi
}

assert_not_empty() {
  local name="$1" got="$2"
  if [ -n "$got" ]; then pass "$name"
  else fail "$name (expected non-empty, got empty)"; fi
}

# --- Temp dir setup ---

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Use a fake vault so tests don't pollute the real vault
export UM_VAULT_DIR="$TMPDIR_ROOT/vault"

# Shared mock bin directory
MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

# Helper: build valid separated stdin for update-state.sh
make_stdin() {
  local old_state="$1"
  local summary="$2"
  printf '===UM-OLD-STATE===\n%s\n===UM-SESSION-SUMMARY===\n%s\n===UM-END===\n' \
    "$old_state" "$summary"
}

# Helper: write a mock curl that returns a given content string as OpenAI response
# Usage: write_mock_curl "$MOCK_BIN" "$content_string"
write_mock_curl() {
  local bin_dir="$1"
  local content_file="$2"   # path to a file containing the response content
  local mock_path="$bin_dir/curl"
  local fixture_json_file="$bin_dir/fixture.json"

  # Build the JSON response using python3, reading content from a file
  python3 - "$content_file" "$fixture_json_file" <<'PYEOF'
import sys, json

content_path = sys.argv[1]
out_path = sys.argv[2]

with open(content_path, "r") as f:
    content = f.read()

resp = {
    "choices": [{"message": {"content": content}}],
    "usage": {"prompt_tokens": 250, "completion_tokens": 180}
}
with open(out_path, "w") as f:
    json.dump(resp, f)
PYEOF

  # Write mock curl script that cats the fixture JSON then emits the sentinel
  cat > "$mock_path" <<MOCK_EOF
#!/usr/bin/env bash
cat "$fixture_json_file"
printf '\n__UM_HTTP_CODE__200'
MOCK_EOF
  chmod +x "$mock_path"
}

# ---------------------------------------------------------------------------
# Shared fixture content
# ---------------------------------------------------------------------------

# Well-formed initial state (empty old state case)
FIXTURE_STATE_INITIAL_FILE="$TMPDIR_ROOT/fixture_initial.md"
cat > "$FIXTURE_STATE_INITIAL_FILE" <<'FIXTURE_EOF'
---
schema_version: 1
type: state
id: state-testproject
title: State of play — testproject
status: current
valid_from: 2026-04-17T00:00:00Z
project: testproject
---

# State of play — testproject

## Current focus
Implementing update-state.sh for session-continuity.

## In flight
- Task 13: update-state.sh — writing and testing

## Recent decisions
- 2026-04-17: Chose LLM-driven merge over template-based approach

## Next actions
- Run full test suite
- Commit and open PR

## Open questions
- Should telemetry also track state-update calls separately?

## Environment
Branch: close-continuity-gap
FIXTURE_EOF

# Updated state (existing old state, one section changed)
FIXTURE_STATE_UPDATED_FILE="$TMPDIR_ROOT/fixture_updated.md"
cat > "$FIXTURE_STATE_UPDATED_FILE" <<'FIXTURE_EOF'
---
schema_version: 1
type: state
id: state-testproject
title: State of play — testproject
status: current
valid_from: 2026-04-17T12:00:00Z
project: testproject
---

# State of play — testproject

## Current focus
Completed update-state.sh; now running integration tests.

## In flight
- Task 14: wire update-state.sh into stop hook

## Recent decisions
- 2026-04-17: Chose LLM-driven merge over template-based approach
- 2026-04-17: Added validation for 6 required H2 headers

## Next actions
- Run full test suite
- Commit Task 13

## Open questions
- Should telemetry also track state-update calls separately?

## Environment
Branch: close-continuity-gap
FIXTURE_EOF

# Old state (used as base for tests 3 and 4)
SAMPLE_OLD_STATE_FILE="$TMPDIR_ROOT/sample_old_state.md"
cat > "$SAMPLE_OLD_STATE_FILE" <<'FIXTURE_EOF'
---
schema_version: 1
type: state
id: state-testproject
title: State of play — testproject
status: current
valid_from: 2026-04-16T00:00:00Z
project: testproject
---

# State of play — testproject

## Current focus
Writing update-state.sh.

## In flight
- Task 13: update-state.sh — in progress

## Recent decisions
- 2026-04-17: Chose LLM-driven merge over template-based approach

## Next actions
- Finish implementation
- Write tests

## Open questions
- How to handle very large old states?

## Environment
Branch: close-continuity-gap
FIXTURE_EOF

SAMPLE_OLD_STATE=$(cat "$SAMPLE_OLD_STATE_FILE")

SAMPLE_SUMMARY="## What happened

Implemented update-state.sh with stdin parsing, LLM call, and output validation.

## Key decisions

- Validate 6 required H2 headers before returning output

## Next steps

- Run test suite
- Commit Task 13"

# Malformed LLM output (missing several required headers)
FIXTURE_MALFORMED_FILE="$TMPDIR_ROOT/fixture_malformed.md"
cat > "$FIXTURE_MALFORMED_FILE" <<'FIXTURE_EOF'
---
schema_version: 1
type: state
id: state-testproject
title: Truncated state
status: current
valid_from: 2026-04-17T00:00:00Z
project: testproject
---

# State of play — testproject

## Current focus
Something is happening here.

## Recent decisions
- 2026-04-17: Some decision

## Next actions
- Do something
FIXTURE_EOF

# ============================================================
# Test 1: Missing API key — silent exit 0, empty stdout
# ============================================================
echo "=== Test 1: Missing API key ==="

T1_INPUT=$(make_stdin "$SAMPLE_OLD_STATE" "$SAMPLE_SUMMARY")

T1_OUT=$(env -u UM_OPENAI_API_KEY -u OPENAI_API_KEY \
  bash "$UPDATE_STATE" <<< "$T1_INPUT" 2>/dev/null)
T1_EXIT=$?

assert_eq "T1: exit code 0 on missing key" "$T1_EXIT" "0"
assert_empty "T1: empty stdout on missing key" "$T1_OUT"

# ============================================================
# Test 2: Empty old state (initial state) — mock returns well-formed
#         initial state.md → stdout matches, validation passes
# ============================================================
echo "=== Test 2: Empty old state → initial state generation ==="

export UM_OPENAI_API_KEY="sk-test-fake-key-for-testing"
export CLAUDE_CWD="$TMPDIR_ROOT/testproject"

write_mock_curl "$MOCK_BIN" "$FIXTURE_STATE_INITIAL_FILE"

T2_INPUT=$(make_stdin "" "$SAMPLE_SUMMARY")
T2_PATH="$MOCK_BIN:$PATH"

T2_OUT=$(PATH="$T2_PATH" bash "$UPDATE_STATE" <<< "$T2_INPUT" 2>/dev/null)
T2_EXIT=$?
T2_STDERR=$(PATH="$T2_PATH" bash "$UPDATE_STATE" <<< "$T2_INPUT" 2>&1 >/dev/null)

assert_eq "T2: exit code 0 on empty old state" "$T2_EXIT" "0"
assert_not_empty "T2: stdout is non-empty" "$T2_OUT"
assert_contains "T2: stdout has frontmatter start" "$T2_OUT" "---"
assert_contains "T2: stdout has schema_version" "$T2_OUT" "schema_version: 1"
assert_contains "T2: stdout has Current focus header" "$T2_OUT" "## Current focus"
assert_contains "T2: stdout has In flight header" "$T2_OUT" "## In flight"
assert_contains "T2: stdout has Recent decisions header" "$T2_OUT" "## Recent decisions"
assert_contains "T2: stdout has Next actions header" "$T2_OUT" "## Next actions"
assert_contains "T2: stdout has Open questions header" "$T2_OUT" "## Open questions"
assert_contains "T2: stdout has Environment header" "$T2_OUT" "## Environment"
assert_contains "T2: telemetry on stderr" "$T2_STDERR" "[um-update-state]"

# ============================================================
# Test 3: Existing state + summary updating one section
#         mock returns state with updated Current focus
# ============================================================
echo "=== Test 3: Existing state + summary → updated Current focus ==="

write_mock_curl "$MOCK_BIN" "$FIXTURE_STATE_UPDATED_FILE"

T3_INPUT=$(make_stdin "$SAMPLE_OLD_STATE" "$SAMPLE_SUMMARY")
T3_PATH="$MOCK_BIN:$PATH"

T3_OUT=$(PATH="$T3_PATH" bash "$UPDATE_STATE" <<< "$T3_INPUT" 2>/dev/null)
T3_EXIT=$?

assert_eq "T3: exit code 0 on update" "$T3_EXIT" "0"
assert_not_empty "T3: stdout is non-empty" "$T3_OUT"
assert_contains "T3: updated Current focus content" "$T3_OUT" "Completed update-state.sh"
assert_contains "T3: all 6 headers present — Current focus" "$T3_OUT" "## Current focus"
assert_contains "T3: all 6 headers present — In flight" "$T3_OUT" "## In flight"
assert_contains "T3: all 6 headers present — Recent decisions" "$T3_OUT" "## Recent decisions"
assert_contains "T3: all 6 headers present — Next actions" "$T3_OUT" "## Next actions"
assert_contains "T3: all 6 headers present — Open questions" "$T3_OUT" "## Open questions"
assert_contains "T3: all 6 headers present — Environment" "$T3_OUT" "## Environment"
assert_contains "T3: new decision appended" "$T3_OUT" "Added validation for 6 required H2 headers"

# ============================================================
# Test 4: Existing state + summary with no material change
#         mock returns the old state verbatim → stdout matches, validates passes
# ============================================================
echo "=== Test 4: No material change — old state returned verbatim ==="

write_mock_curl "$MOCK_BIN" "$SAMPLE_OLD_STATE_FILE"

T4_INPUT=$(make_stdin "$SAMPLE_OLD_STATE" "## What happened

Minor housekeeping session. No material changes.")
T4_PATH="$MOCK_BIN:$PATH"

T4_OUT=$(PATH="$T4_PATH" bash "$UPDATE_STATE" <<< "$T4_INPUT" 2>/dev/null)
T4_EXIT=$?

assert_eq "T4: exit code 0 on no-change" "$T4_EXIT" "0"
assert_not_empty "T4: stdout is non-empty" "$T4_OUT"
assert_contains "T4: old content preserved — Current focus" "$T4_OUT" "Writing update-state.sh"
assert_contains "T4: all headers present" "$T4_OUT" "## Current focus"

# ============================================================
# Test 5: Malformed LLM output (missing required headers)
#         → empty stdout, error on stderr
# ============================================================
echo "=== Test 5: Malformed LLM output → empty stdout, error on stderr ==="

write_mock_curl "$MOCK_BIN" "$FIXTURE_MALFORMED_FILE"

T5_INPUT=$(make_stdin "$SAMPLE_OLD_STATE" "$SAMPLE_SUMMARY")
T5_PATH="$MOCK_BIN:$PATH"

T5_OUT=$(PATH="$T5_PATH" bash "$UPDATE_STATE" <<< "$T5_INPUT" 2>/dev/null)
T5_EXIT=$?
T5_STDERR=$(PATH="$T5_PATH" bash "$UPDATE_STATE" <<< "$T5_INPUT" 2>&1 >/dev/null)

assert_eq "T5: exit code 0 on malformed output" "$T5_EXIT" "0"
assert_empty "T5: empty stdout on malformed output" "$T5_OUT"
assert_contains "T5: stderr mentions malformed" "$T5_STDERR" "malformed"

# ============================================================
# Test 6: Missing separators in stdin
#         → stderr error, empty stdout, exit 0
# ============================================================
echo "=== Test 6: Missing separators in stdin ==="

# Write a no-op curl (should never be reached, but in place for completeness)
cat > "$MOCK_BIN/curl" <<'MOCK_EOF'
#!/usr/bin/env bash
printf '{"choices":[{"message":{"content":"should not reach"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n'
printf '\n__UM_HTTP_CODE__200'
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

T6_INPUT="This is just plain text with no separators at all."
T6_PATH="$MOCK_BIN:$PATH"

T6_OUT=$(PATH="$T6_PATH" bash "$UPDATE_STATE" <<< "$T6_INPUT" 2>/dev/null)
T6_EXIT=$?
T6_STDERR=$(PATH="$T6_PATH" bash "$UPDATE_STATE" <<< "$T6_INPUT" 2>&1 >/dev/null)

assert_eq "T6: exit code 0 on missing separators" "$T6_EXIT" "0"
assert_empty "T6: empty stdout on missing separators" "$T6_OUT"
assert_contains "T6: stderr mentions missing separator" "$T6_STDERR" "missing"

# ============================================================
# Test 7: --stdout mode (B1a) — renders merge without side effects
#   - Writes merged content to stdout (same as default)
#   - Does NOT append to cost-log.csv telemetry
#   - Existing state.md on disk is never read or written by this script
#     (session-end.sh owns that), but we still assert no telemetry side
#     effect occurs in the vault.
# ============================================================
echo "=== Test 7: --stdout mode — renders merge, skips telemetry ==="

write_mock_curl "$MOCK_BIN" "$FIXTURE_STATE_UPDATED_FILE"

# Use an isolated vault for this test so we can observe telemetry side effects
T7_VAULT="$TMPDIR_ROOT/vault_t7"
mkdir -p "$T7_VAULT/state/testproject"
printf 'old state content' > "$T7_VAULT/state/testproject/state.md"

T7_INPUT=$(make_stdin "$SAMPLE_OLD_STATE" "$SAMPLE_SUMMARY")
T7_PATH="$MOCK_BIN:$PATH"

T7_OUT=$(UM_VAULT_DIR="$T7_VAULT" PATH="$T7_PATH" \
  bash "$UPDATE_STATE" --stdout --project testproject <<< "$T7_INPUT" 2>/dev/null)
T7_EXIT=$?

assert_eq "T7: --stdout exit code 0" "$T7_EXIT" "0"
assert_not_empty "T7: --stdout stdout is non-empty" "$T7_OUT"
assert_contains "T7: --stdout has frontmatter" "$T7_OUT" "---"
assert_contains "T7: --stdout has Current focus header" "$T7_OUT" "## Current focus"
assert_contains "T7: --stdout has In flight header" "$T7_OUT" "## In flight"
assert_contains "T7: --stdout has Recent decisions header" "$T7_OUT" "## Recent decisions"
assert_contains "T7: --stdout has Next actions header" "$T7_OUT" "## Next actions"
assert_contains "T7: --stdout has Open questions header" "$T7_OUT" "## Open questions"
assert_contains "T7: --stdout has Environment header" "$T7_OUT" "## Environment"

# Original state.md must remain unchanged (script never writes it anyway,
# but this is the contract callers rely on)
T7_STATE_AFTER=$(cat "$T7_VAULT/state/testproject/state.md")
assert_eq "T7: --stdout preserves state.md verbatim" "$T7_STATE_AFTER" "old state content"

# Telemetry (cost-log.csv) must NOT have been created/appended
if [ -f "$T7_VAULT/.telemetry/cost-log.csv" ]; then
  fail "T7: --stdout should not write cost-log.csv telemetry"
else
  pass "T7: --stdout skips cost-log.csv telemetry"
fi

# No lockdir created by the script (it doesn't create one anyway, but assert)
if [ -d "$T7_VAULT/state/testproject/state.md.lockdir" ]; then
  fail "T7: --stdout should not create a lockdir"
else
  pass "T7: --stdout creates no lockdir"
fi

# ============================================================
# Test 8: --stdout default-mode parity — confirm non-stdout call still
#   writes telemetry (regression guard for existing callers)
# ============================================================
echo "=== Test 8: default mode still writes cost-log.csv (regression guard) ==="

write_mock_curl "$MOCK_BIN" "$FIXTURE_STATE_UPDATED_FILE"

T8_VAULT="$TMPDIR_ROOT/vault_t8"
mkdir -p "$T8_VAULT"

T8_INPUT=$(make_stdin "$SAMPLE_OLD_STATE" "$SAMPLE_SUMMARY")
T8_PATH="$MOCK_BIN:$PATH"

T8_OUT=$(UM_VAULT_DIR="$T8_VAULT" PATH="$T8_PATH" UM_PROJECT="testproject" \
  bash "$UPDATE_STATE" <<< "$T8_INPUT" 2>/dev/null)
T8_EXIT=$?

assert_eq "T8: default-mode exit code 0" "$T8_EXIT" "0"
assert_not_empty "T8: default-mode stdout is non-empty" "$T8_OUT"

if [ -f "$T8_VAULT/.telemetry/cost-log.csv" ]; then
  pass "T8: default mode writes cost-log.csv (regression guard)"
else
  fail "T8: default mode must still write cost-log.csv"
fi

unset CLAUDE_CWD

# ============================================================
# Test T-PROMPT-DIR: update-state.sh honors $UM_PROMPT_DIR
#
# Verifies that the UM_PROMPT_DIR resolution block in update-state.sh reads
# from the override directory when $UM_PROMPT_DIR is set. Scoped bash -c
# isolates the path-resolution logic without running the full script.
# ============================================================
echo "=== Test T-PROMPT-DIR: update-state.sh honors \$UM_PROMPT_DIR ==="

TPROMPT_DIR=$(mktemp -d)
echo "CUSTOM_PROMPT_MARKER_UNIQUE_XYZ" > "$TPROMPT_DIR/update-state.txt"

CAPTURED_PROMPT=$(UM_PROMPT_DIR="$TPROMPT_DIR" bash -c '
  # Replicate the resolution block from update-state.sh
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
  UM_PROMPT_DIR="${UM_PROMPT_DIR:-$SCRIPT_DIR/prompts}"
  cat "$UM_PROMPT_DIR/update-state.txt"
' 2>&1)

if [[ "$CAPTURED_PROMPT" == *"CUSTOM_PROMPT_MARKER_UNIQUE_XYZ"* ]]; then
  pass "T-PROMPT-DIR: update-state.sh reads from \$UM_PROMPT_DIR when set"
else
  fail "T-PROMPT-DIR: expected custom marker; got: $CAPTURED_PROMPT"
fi
rm -rf "$TPROMPT_DIR"

# ============================================================
# Test SDK (#385): UM_SUMMARIZER dispatch, same backends as summarize.sh
#
# um-preview runs summarize.sh then update-state.sh, so both must honor
# UM_SUMMARIZER. A stub `claude` replies with $STUB_REPLY_FILE and logs its
# argv + stdin; a stub `curl` logs any call so the tests can prove OpenAI
# was (or was not) reached.
# ============================================================

# Strip the directory holding a real `claude` from PATH (the dev machine
# has one; CI does not).
path_without_claude() {
  local claude_bin
  claude_bin=$(command -v claude 2>/dev/null || true)
  if [ -z "$claude_bin" ]; then
    printf '%s' "$PATH"
    return
  fi
  printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$(dirname "$claude_bin")" | tr '\n' ':' | sed 's/:$//'
}

SDK_TMP=$(mktemp -d)
SDK_BIN="$SDK_TMP/bin"
mkdir -p "$SDK_BIN"
cat > "$SDK_BIN/claude" <<'BIN'
#!/usr/bin/env bash
echo "$@" > "$SDK_LOG.claude-args"
cat > "$SDK_LOG.claude-stdin"
[ -n "${STUB_EXIT:-}" ] && exit "$STUB_EXIT"
cat "$STUB_REPLY_FILE"
BIN
cat > "$SDK_BIN/curl" <<'BIN'
#!/usr/bin/env bash
echo "curl called" >> "$SDK_LOG.curl"
exit 7
BIN
chmod +x "$SDK_BIN/claude" "$SDK_BIN/curl"
export SDK_LOG="$SDK_TMP/log"
export CLAUDE_CWD="$TMPDIR_ROOT/sdkproject"
SDK_INPUT=$(make_stdin "$SAMPLE_OLD_STATE" "$SAMPLE_SUMMARY")
sdk_reset() { rm -f "$SDK_LOG".*; }

echo "=== Test SDK.1: claude-agent-sdk, no OpenAI key → claude's state doc ==="
sdk_reset
SDK1_COST_LOG="$UM_VAULT_DIR/.telemetry/cost-log.csv"
SDK1_ROWS_BEFORE=$(wc -l < "$SDK1_COST_LOG" 2>/dev/null || echo 0)
SDK1_OUT=$(env -u UM_OPENAI_API_KEY -u OPENAI_API_KEY STUB_REPLY_FILE="$FIXTURE_STATE_INITIAL_FILE" \
  PATH="$SDK_BIN:$PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$UPDATE_STATE" <<< "$SDK_INPUT" 2>/dev/null)
SDK1_EXIT=$?
SDK1_ROWS_AFTER=$(wc -l < "$SDK1_COST_LOG" 2>/dev/null || echo 0)
assert_eq "SDK.1: exit 0" "$SDK1_EXIT" "0"
assert_contains "SDK.1: stdout is claude's state doc" "$SDK1_OUT" "Implementing update-state.sh for session-continuity."
assert_contains "SDK.1: claude got -p" "$(cat "$SDK_LOG.claude-args" 2>/dev/null)" "-p"
assert_contains "SDK.1: claude got --output-format text" "$(cat "$SDK_LOG.claude-args" 2>/dev/null)" "--output-format text"
assert_contains "SDK.1: claude stdin has the system prompt" "$(cat "$SDK_LOG.claude-stdin" 2>/dev/null)" "state of play"
assert_contains "SDK.1: claude stdin has the session summary" "$(cat "$SDK_LOG.claude-stdin" 2>/dev/null)" "Validate 6 required H2 headers"
assert_contains "SDK.1: claude stdin asks for the merge" "$(cat "$SDK_LOG.claude-stdin" 2>/dev/null)" "Produce the updated state.md"
assert_eq "SDK.1: OpenAI not called" "$([ -f "$SDK_LOG.curl" ] && echo called || echo none)" "none"
assert_eq "SDK.1: no cost-log row (claude -p reports no tokens)" "$SDK1_ROWS_AFTER" "$SDK1_ROWS_BEFORE"

echo "=== Test SDK.2: claude's reply is malformed → rejected, no OpenAI retry ==="
sdk_reset
SDK2_ERR=$(env -u UM_OPENAI_API_KEY -u OPENAI_API_KEY STUB_REPLY_FILE="$FIXTURE_MALFORMED_FILE" \
  PATH="$SDK_BIN:$PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$UPDATE_STATE" <<< "$SDK_INPUT" 2>&1 >"$SDK_TMP/sdk2.out")
assert_empty "SDK.2: empty stdout" "$(cat "$SDK_TMP/sdk2.out")"
assert_contains "SDK.2: stderr names the rejection" "$SDK2_ERR" "malformed"
assert_eq "SDK.2: OpenAI not called" "$([ -f "$SDK_LOG.curl" ] && echo called || echo none)" "none"

echo "=== Test SDK.3: claude-agent-sdk with no claude CLI → openai fallback ==="
sdk_reset
write_mock_curl "$MOCK_BIN" "$FIXTURE_STATE_INITIAL_FILE"
SDK3_OUT=$(PATH="$MOCK_BIN:$(path_without_claude)" UM_SUMMARIZER=claude-agent-sdk \
  UM_OPENAI_API_KEY=sk-fake bash "$UPDATE_STATE" <<< "$SDK_INPUT" 2>"$SDK_TMP/sdk3.err")
assert_contains "SDK.3: stdout is the OpenAI state doc" "$SDK3_OUT" "## Current focus"
assert_contains "SDK.3: stderr warns about the fallback" "$(cat "$SDK_TMP/sdk3.err")" "falling back to openai"

echo "=== Test SDK.4: claude fails, no OpenAI key → empty stdout, reason on stderr ==="
sdk_reset
SDK4_ERR=$(env -u UM_OPENAI_API_KEY -u OPENAI_API_KEY STUB_EXIT=1 STUB_REPLY_FILE="$FIXTURE_STATE_INITIAL_FILE" \
  PATH="$SDK_BIN:$PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$UPDATE_STATE" <<< "$SDK_INPUT" 2>&1 >"$SDK_TMP/sdk4.out")
SDK4_EXIT=$?
assert_eq "SDK.4: exit 0 (fail-soft)" "$SDK4_EXIT" "0"
assert_empty "SDK.4: empty stdout" "$(cat "$SDK_TMP/sdk4.out")"
assert_contains "SDK.4: stderr says claude failed" "$SDK4_ERR" "claude -p failed"
assert_contains "SDK.4: stderr names the missing key" "$SDK4_ERR" "UM_OPENAI_API_KEY"
assert_eq "SDK.4: OpenAI not called" "$([ -f "$SDK_LOG.curl" ] && echo called || echo none)" "none"

echo "=== Test SDK.5: unknown UM_SUMMARIZER → warning + openai ==="
sdk_reset
SDK5_OUT=$(PATH="$MOCK_BIN:$PATH" UM_SUMMARIZER=garbage \
  UM_OPENAI_API_KEY=sk-fake bash "$UPDATE_STATE" <<< "$SDK_INPUT" 2>"$SDK_TMP/sdk5.err")
assert_contains "SDK.5: stdout is the OpenAI state doc" "$SDK5_OUT" "## Current focus"
assert_contains "SDK.5: stderr warns about the unknown value" "$(cat "$SDK_TMP/sdk5.err")" "'garbage' unknown"

rm -rf "$SDK_TMP"
unset CLAUDE_CWD SDK_LOG

# ============================================================
# Summary
# ============================================================

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
exit 0
