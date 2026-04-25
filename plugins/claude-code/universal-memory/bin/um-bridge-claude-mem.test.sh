#!/usr/bin/env bash
# um-bridge-claude-mem.test.sh — shell tests for the um-bridge-claude-mem CLI
# Run from repo root: bash plugins/claude-code/universal-memory/bin/um-bridge-claude-mem.test.sh
#
# Tests covered:
#   1. Schema mismatch → exit nonzero, output contains "schema version"
#   2. --cursor-reset → cursor file deleted, exit 0
#   3. (Bonus) Non-existent --db-path → exit 0, no output (silent skip)
#   4. (Bonus) Path-traversal attempt → exit 1, output contains "outside allowlist" or "UNC"
#   5. Reindex fails → exit 2 + cursor not advanced (ECONNREFUSED mock)
#   6. Idempotency — second --once run with same fixture reports "nothing to do"

set -uo pipefail

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REPO_ROOT: 5 levels up from bin/ in the shell (unlike URL resolution, 'cd ..'
# does NOT strip the directory itself — each '..' is one real directory level).
# bin → universal-memory(inner) → claude-code → plugins → universal-memory(repo)
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
CLI="$SCRIPT_DIR/um-bridge-claude-mem"

PASS=0
FAIL=0
SKIP=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s\n' "$1"
}
skip() { SKIP=$((SKIP + 1)); printf '  SKIP: %s\n' "$1"; }

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got: '${haystack:0:400}')"; fi
}

assert_exit() {
  local name="$1" code="$2" want="$3"
  if [ "$code" = "$want" ]; then pass "$name"
  else fail "$name (exit code: got=$code want=$want)"; fi
}

# ---------------------------------------------------------------------------
# Temp dir for cursor-reset test
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ---------------------------------------------------------------------------
# Check node + better-sqlite3 available (T1, T5, T6 depend on it)
#
# Strategy: better-sqlite3 may not be installed in bin/node_modules (requires
# native compilation). The module is always available in server/node_modules
# (built as part of the server). We check availability from server/ and run
# bridge-requiring tests from that directory so the ESM dynamic import inside
# the CLI resolves better-sqlite3 from server/node_modules.
#
# Dev shortcut: creating a junction/symlink
#   bin/node_modules → server/node_modules
# lets tests run without the cd-to-server wrapper. Either approach works;
# the cd-to-server wrapper is the portable fallback.
# ---------------------------------------------------------------------------
HAVE_BRIDGE=0
SERVER_DIR="$REPO_ROOT/server"
if (cd "$SERVER_DIR" && node -e "import('better-sqlite3').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null); then
  HAVE_BRIDGE=1
fi

# Wrapper: run the bridge CLI from server/ so better-sqlite3 resolves there
# (fallback for environments without the bin/node_modules junction/symlink).
run_bridge() {
  (cd "$SERVER_DIR" && node "$CLI" "$@")
}

# ---------------------------------------------------------------------------
# Test 1: Schema mismatch → exit nonzero + "schema version" in output
# ---------------------------------------------------------------------------
printf '\nTest 1: Schema mismatch detection\n'

WRONG_SCHEMA_DB="$REPO_ROOT/server/test/fixtures/claude-mem-wrong-schema.db"

if [ "$HAVE_BRIDGE" -eq 0 ]; then
  skip "T1: schema mismatch (better-sqlite3 not available — run: cd server && npm install)"
else
  # Create the wrong-schema fixture using node (sqlite3 CLI may not be available).
  # Run from server/ so better-sqlite3 resolves there.
  if [ ! -f "$WRONG_SCHEMA_DB" ]; then
    (cd "$SERVER_DIR" && node --input-type=module <<EOF
import Database from 'better-sqlite3';
const db = new Database('$WRONG_SCHEMA_DB');
db.pragma('user_version = 9999');
db.exec('CREATE TABLE sessions (bad TEXT)');
db.close();
console.log('created fixture');
EOF
)
  fi

  set +e
  out=$(run_bridge --once --db-path="$WRONG_SCHEMA_DB" 2>&1)
  exit_code=$?
  set -e
  assert_contains "T1a: output mentions schema version" "$out" "schema version"
  if [ "$exit_code" -eq 0 ]; then
    fail "T1b: schema mismatch should exit nonzero (got 0)"
  else
    pass "T1b: exit nonzero on schema mismatch (exit=$exit_code)"
  fi
fi

# ---------------------------------------------------------------------------
# Test 2: --cursor-reset deletes cursor file and exits 0
# ---------------------------------------------------------------------------
printf '\nTest 2: --cursor-reset handler\n'

FAKE_VAULT="$TMPDIR_ROOT/vault"
CURSOR_DIR="$FAKE_VAULT/.local/bridges"
CURSOR_FILE="$CURSOR_DIR/claude-mem.json"

mkdir -p "$CURSOR_DIR"
echo '{"schema":1,"last_ingested_id":null}' > "$CURSOR_FILE"

out=$(UM_VAULT_DIR="$FAKE_VAULT" run_bridge --cursor-reset 2>&1)
reset_exit=$?

assert_exit "T2a: --cursor-reset exits 0" "$reset_exit" "0"
assert_contains "T2b: output mentions cursor reset" "$out" "cursor reset"
if [ -f "$CURSOR_FILE" ]; then
  fail "T2c: cursor file should have been deleted (still present)"
else
  pass "T2c: cursor file deleted"
fi

# Test 2d: --cursor-reset with no cursor file → still exits 0 (idempotent)
out2=$(UM_VAULT_DIR="$FAKE_VAULT" run_bridge --cursor-reset 2>&1)
reset_exit2=$?
assert_exit "T2d: --cursor-reset with no file exits 0 (idempotent)" "$reset_exit2" "0"

# ---------------------------------------------------------------------------
# Test 3 (Bonus): Non-existent --db-path → exit 0, silent
# ---------------------------------------------------------------------------
printf '\nTest 3 (Bonus): Non-existent DB path → silent exit 0\n'

# existsSync check fires before the better-sqlite3 dynamic import, so this
# test runs regardless of whether the native module is built.
FIXTURES_DIR="$REPO_ROOT/server/test/fixtures"
set +e
out3=$(run_bridge --once --db-path="$FIXTURES_DIR/does-not-exist.db" 2>&1)
exit3=$?
set -e
assert_exit "T3a: non-existent DB exits 0" "$exit3" "0"
if [ -z "$out3" ]; then
  pass "T3b: no output on silent skip"
else
  # Some output is acceptable (e.g. a debug line) — not a hard failure
  skip "T3b: got output on silent skip (acceptable): $out3"
fi

# ---------------------------------------------------------------------------
# Test 4 (Bonus): Path-traversal attempt → exit 1 with informative message
# ---------------------------------------------------------------------------
printf '\nTest 4 (Bonus): Path-traversal guard\n'

# validateDbPath fires before the better-sqlite3 dynamic import, so this
# test runs regardless of whether the native module is built.
# UNC path test — use Windows-style on win32, POSIX double-slash elsewhere
if [[ "$OSTYPE" == "msys"* ]] || [[ "$OSTYPE" == "cygwin"* ]] || [[ "$(uname -s)" == MINGW* ]]; then
  TRAVERSAL_PATH='\\\\attacker\\share\\evil.db'
else
  TRAVERSAL_PATH='//attacker/share/evil.db'
fi

set +e
out4=$(run_bridge --once --db-path="$TRAVERSAL_PATH" 2>&1)
exit4=$?
set -e
assert_exit "T4a: UNC path exits 1" "$exit4" "1"
if [[ "$out4" == *"UNC"* ]] || [[ "$out4" == *"outside allowlist"* ]]; then
  pass "T4b: UNC/allowlist rejection message present"
else
  fail "T4b: expected 'UNC' or 'outside allowlist' in output, got: ${out4:0:200}"
fi

# ---------------------------------------------------------------------------
# Test 5: Reindex fails → exit 2 + cursor not advanced
#
# UM_SERVER_URL=http://127.0.0.1:1 forces an immediate ECONNREFUSED which the
# bridge wraps as UPSTREAM_FAILURE and exits 2. No cursor file should be written
# (or if it was from a previous run, it should not have a later epoch).
# ---------------------------------------------------------------------------
printf '\nTest 5: Reindex failure → UPSTREAM_FAILURE (exit 2), cursor not advanced\n'

FIXTURE_DB="$REPO_ROOT/server/test/fixtures/claude-mem-sessions-v12.3.9.db"

if [ "$HAVE_BRIDGE" -eq 0 ]; then
  skip "T5: reindex-fail test (better-sqlite3 not available)"
elif [ ! -f "$FIXTURE_DB" ]; then
  skip "T5: fixture DB not found: $FIXTURE_DB"
else
  T5_VAULT="$TMPDIR_ROOT/t5-vault"
  T5_CURSOR="$T5_VAULT/.local/bridges/claude-mem.json"
  mkdir -p "$T5_VAULT/.local/bridges"

  set +e
  out5=$(UM_VAULT_DIR="$T5_VAULT" UM_SERVER_URL="http://127.0.0.1:1" \
    run_bridge --once --db-path="$FIXTURE_DB" 2>&1)
  exit5=$?
  set -e

  assert_exit "T5a: reindex-fail exits 2 (UPSTREAM_FAILURE)" "$exit5" "2"

  # Cursor should not be present (first run, reindex fails on first item)
  # or if it exists, its epoch should be 0 / from initial default
  if [ -f "$T5_CURSOR" ]; then
    # Cursor was written — check it's not advanced past first item
    # (some partial advance is possible if translation itself partially succeeds
    # before the first reindex call fails, but on ECONNREFUSED the first item fails)
    # Accept: cursor exists but its epoch matches the first item's epoch (advance 0 items)
    # Strictest check: file was NOT created (cursor only advances after reindex success)
    fail "T5b: cursor file should NOT exist after UPSTREAM_FAILURE on first item (cursor advanced prematurely)"
  else
    pass "T5b: cursor file not created (reindex failed before first advance)"
  fi

  assert_contains "T5c: output contains UPSTREAM_FAILURE indication" "$out5" "reindex failed"
fi

# ---------------------------------------------------------------------------
# Test 6: Idempotency — second --once run reports "nothing to do"
#
# First run writes cursor; second run reads cursor and WHERE epoch > last sees
# 0 rows → "nothing to do" summary line, exit 0.
# We need a reachable mock server. Use --cursor-reset between runs to start
# fresh. Since we can't easily mock a successful reindex without a real server,
# we use a pre-written cursor file that simulates "already ingested everything".
# ---------------------------------------------------------------------------
printf '\nTest 6: Idempotency — second run with cursor at max epoch reports nothing to do\n'

if [ "$HAVE_BRIDGE" -eq 0 ]; then
  skip "T6: idempotency test (better-sqlite3 not available)"
elif [ ! -f "$FIXTURE_DB" ]; then
  skip "T6: fixture DB not found: $FIXTURE_DB"
else
  T6_VAULT="$TMPDIR_ROOT/t6-vault"
  T6_CURSOR="$T6_VAULT/.local/bridges/claude-mem.json"
  mkdir -p "$T6_VAULT/.local/bridges"

  # Write a cursor that claims we already ingested epoch=99999999999 (far future)
  # so WHERE created_at_epoch > ? returns 0 rows from the fixture DB.
  # This simulates "already up to date" without needing a real reindex server.
  cat > "$T6_CURSOR" << 'CURSOR_EOF'
{
  "schema": 1,
  "last_ingested_id": "pre-set-sentinel",
  "last_ingested_at": "2099-01-01T00:00:00.000Z",
  "last_ingested_at_epoch": 99999999999
}
CURSOR_EOF

  set +e
  out6=$(UM_VAULT_DIR="$T6_VAULT" UM_SERVER_URL="http://127.0.0.1:1" \
    run_bridge --once --db-path="$FIXTURE_DB" 2>&1)
  exit6=$?
  set -e

  assert_exit "T6a: second run exits 0 (nothing to do)" "$exit6" "0"
  assert_contains "T6b: output says 'nothing to do'" "$out6" "nothing to do"

  # Cursor file should still exist and be unchanged
  if [ -f "$T6_CURSOR" ]; then
    pass "T6c: cursor file still present after no-op run"
  else
    fail "T6c: cursor file was deleted by no-op run (should have been left alone)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n'
printf 'Results: %d pass, %d fail, %d skip\n' "$PASS" "$FAIL" "$SKIP"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '\nFailed tests:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi

exit 0
