#!/usr/bin/env bash
# installer/lib/endpoint.test.sh — unit tests for um_resolve_endpoint().
#
# Run from repo root:
#   bash installer/lib/endpoint.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=installer/lib/endpoint.sh
source "$SCRIPT_DIR/endpoint.sh"

PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s — %s\n' "$1" "${2:-}"
}

# call_resolve <expected_stdout> <expected_warn_substring_or_empty> [env...]
# Captures stdout + stderr separately. Empty <expected_warn_substring> means
# stderr MUST be empty.
call_resolve() {
  local name="$1"
  local expect_stdout="$2"
  local expect_warn="$3"
  shift 3

  local out_file err_file
  out_file=$(mktemp)
  err_file=$(mktemp)

  # `env -i` clears the inherited env (so prior test cases don't leak),
  # but we MUST preserve PATH or bash itself becomes unfindable. Re-source
  # in a subshell because env -i drops the resolver function from scope.
  ( env -i PATH="$PATH" UM_SERVER_URL="${UM_SERVER_URL:-}" UM_ENDPOINT="${UM_ENDPOINT:-}" "$@" \
      bash -c "source '$SCRIPT_DIR/endpoint.sh'; um_resolve_endpoint" ) \
    >"$out_file" 2>"$err_file"

  local got_stdout got_stderr
  got_stdout=$(cat "$out_file")
  got_stderr=$(cat "$err_file")
  rm -f "$out_file" "$err_file"

  if [ "$got_stdout" = "$expect_stdout" ]; then
    pass "$name (stdout)"
  else
    fail "$name (stdout)" "want='$expect_stdout' got='$got_stdout'"
  fi

  if [ -z "$expect_warn" ]; then
    if [ -z "$got_stderr" ]; then
      pass "$name (no warn)"
    else
      fail "$name (no warn)" "expected empty stderr, got: $got_stderr"
    fi
  else
    if [[ "$got_stderr" == *"$expect_warn"* ]]; then
      pass "$name (warn)"
    else
      fail "$name (warn)" "expected stderr to contain '$expect_warn', got: $got_stderr"
    fi
  fi
}

# ─── T1: only UM_SERVER_URL set → returned silently ──────────────────────────
echo ""
echo "=== T1: only UM_SERVER_URL set ==="
UM_SERVER_URL="http://server.example:6335" UM_ENDPOINT="" \
  call_resolve "T1" "http://server.example:6335" ""

# ─── T2: only UM_ENDPOINT set (legacy) → returned with deprecation warn ──────
echo ""
echo "=== T2: only UM_ENDPOINT set (legacy) ==="
UM_SERVER_URL="" UM_ENDPOINT="http://legacy.example:6335" \
  call_resolve "T2" "http://legacy.example:6335" "UM_ENDPOINT is deprecated"

# ─── T3: both set with same value → returned silently (no warn) ──────────────
echo ""
echo "=== T3: both set, same value ==="
UM_SERVER_URL="http://same.example:6335" UM_ENDPOINT="http://same.example:6335" \
  call_resolve "T3" "http://same.example:6335" ""

# ─── T4: both set with different values → UM_SERVER_URL wins, conflict warn ──
echo ""
echo "=== T4: both set, different values (conflict) ==="
UM_SERVER_URL="http://canonical.example:6335" UM_ENDPOINT="http://stale.example:6335" \
  call_resolve "T4" "http://canonical.example:6335" "both set with different values"

# ─── T5: neither set → default fallback ──────────────────────────────────────
echo ""
echo "=== T5: neither set (default fallback) ==="
UM_SERVER_URL="" UM_ENDPOINT="" \
  call_resolve "T5" "http://localhost:6335" ""

# ─── T6: T2 warn message references MIGRATION.md (operator-actionable) ───────
echo ""
echo "=== T6: T2 warn includes MIGRATION.md pointer ==="
UM_SERVER_URL="" UM_ENDPOINT="http://legacy.example:6335" \
  call_resolve "T6" "http://legacy.example:6335" "MIGRATION.md"

# ─── T7: T4 warn message names the value being used (audit trail) ────────────
echo ""
echo "=== T7: T4 warn names the chosen value ==="
UM_SERVER_URL="http://canonical.example:6335" UM_ENDPOINT="http://stale.example:6335" \
  call_resolve "T7" "http://canonical.example:6335" "UM_SERVER_URL=http://canonical.example:6335"

# ─── T8/T9: um_endpoint_configured detection ─────────────────────────────────
configured_check() {
  local name="$1"
  local expect_rc="$2"
  shift 2
  local rc=0
  ( env -i PATH="$PATH" "$@" \
      bash -c "source '$SCRIPT_DIR/endpoint.sh'; um_endpoint_configured" ) >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq "$expect_rc" ]; then pass "$name"
  else fail "$name" "want rc=$expect_rc got rc=$rc"; fi
}

echo ""
echo "=== T8: um_endpoint_configured returns 0 when configured ==="
configured_check "T8a: UM_SERVER_URL set"  0  UM_SERVER_URL="http://x:6335"
configured_check "T8b: UM_ENDPOINT set"    0  UM_ENDPOINT="http://x:6335"
configured_check "T8c: both set"           0  UM_SERVER_URL="http://x:6335" UM_ENDPOINT="http://y:6335"
echo ""
echo "=== T9: um_endpoint_configured returns 1 when neither set ==="
configured_check "T9: neither set"         1

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=================================================="
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All endpoint resolver tests pass."
