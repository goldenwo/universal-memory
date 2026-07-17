#!/usr/bin/env bash
# hooks/auto-start.test.sh — tests for auto-start.sh (#159 T6b, spec §5)
#
# Run: bash auto-start.test.sh
#
# Scenarios:
#   1. No endpoint configured (env empty, no ~/.um/endpoint) → silent exit 0,
#      no docker call
#   2. File-tier config (~/.um/endpoint only), server reachable → exit 0,
#      no docker call
#   3. REMOTE resolved endpoint (non-loopback host), unreachable, compose dir
#      configured → must NOT auto-start (no docker call), diagnostic logged
#   4. Local endpoint unreachable + UM_COMPOSE_DIR → compose up runs, health
#      polled to green
#   5. Fresh lock held by another flight → skip (no docker call)
#   6. Stale lock (>5 min) → stolen, compose up runs
#   7. Two near-simultaneous starts → at most one compose up
#   8. Already-listening re-probe: health comes up between the first probe
#      and lock acquisition → no compose up

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/auto-start.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

THOME="$TMP/home"
MOCK_BIN="$TMP/mock_bin"
COMPOSE_DIR="$TMP/compose"
HEALTH_FLAG="$TMP/health-up"
DOCKER_LOG="$TMP/docker-calls.log"
mkdir -p "$THOME" "$MOCK_BIN" "$COMPOSE_DIR"
touch "$COMPOSE_DIR/docker-compose.yml"

# Mock curl: succeeds iff the health flag file exists.
cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
[ -f "$HEALTH_FLAG" ] && exit 0
exit 7
MOCK
chmod +x "$MOCK_BIN/curl"

# Mock docker: records the call, brings "health" up.
write_mock_docker() {
  local delay="${1:-0}"
  cat > "$MOCK_BIN/docker" <<MOCK
#!/bin/bash
echo "docker \$*" >> "$DOCKER_LOG"
[ "$delay" != "0" ] && /bin/sleep "$delay"
touch "$HEALTH_FLAG"
exit 0
MOCK
  chmod +x "$MOCK_BIN/docker"
}
write_mock_docker

reset_state() {
  rm -f "$HEALTH_FLAG" "$DOCKER_LOG"
  rm -rf "$THOME/.um"
}

docker_calls() { grep -c "compose up" "$DOCKER_LOG" 2>/dev/null || echo 0; }

# run_hook <extra env assignments...> — runs auto-start with isolated env
run_hook() {
  env PATH="$MOCK_BIN:$PATH" HOME="$THOME" \
      UM_SERVER_URL="" UM_ENDPOINT="" UM_COMPOSE_DIR="" \
      "$@" bash "$HOOK" 2>&1
}

# ─── T1: unconfigured → silent exit 0, no docker ────────────────────────────
echo "=== T1: unconfigured → silent, no docker ==="
reset_state
out=$(run_hook)
rc=$?
if [ "$rc" -eq 0 ]; then pass "T1-exit-0"; else fail "T1-exit-0 (rc=$rc)"; fi
if [ -z "$out" ]; then pass "T1-silent"; else fail "T1-silent: $out"; fi
if [ "$(docker_calls)" = "0" ]; then pass "T1-no-docker"; else fail "T1-no-docker"; fi

# ─── T2: file-tier config, reachable → exit 0, no docker ────────────────────
echo ""
echo "=== T2: file-tier config, server reachable ==="
reset_state
mkdir -p "$THOME/.um"
printf 'http://localhost:6335\n' > "$THOME/.um/endpoint"
touch "$HEALTH_FLAG"
out=$(run_hook)
rc=$?
if [ "$rc" -eq 0 ]; then pass "T2-exit-0"; else fail "T2-exit-0 (rc=$rc)"; fi
if [ "$(docker_calls)" = "0" ]; then pass "T2-no-docker"; else fail "T2-no-docker"; fi

# ─── T3: remote endpoint, unreachable → NO auto-start ───────────────────────
echo ""
echo "=== T3: remote endpoint ⇒ never auto-start ==="
reset_state
mkdir -p "$THOME/.um"
printf 'http://pi-openclaw:6337\n' > "$THOME/.um/endpoint"
out=$(run_hook UM_COMPOSE_DIR="$COMPOSE_DIR")
rc=$?
if [ "$rc" -eq 0 ]; then pass "T3-exit-0"; else fail "T3-exit-0 (rc=$rc)"; fi
if [ "$(docker_calls)" = "0" ]; then pass "T3-no-docker"; else fail "T3-no-docker: $(cat "$DOCKER_LOG" 2>/dev/null)"; fi
if echo "$out" | grep -qi "remote"; then
  pass "T3-remote-diagnostic"
else
  fail "T3-remote-diagnostic: $out"
fi

# ─── T4: local unreachable + compose dir → compose up + green poll ──────────
echo ""
echo "=== T4: local unreachable ⇒ compose up ==="
reset_state
out=$(run_hook UM_SERVER_URL="http://localhost:6335" UM_COMPOSE_DIR="$COMPOSE_DIR")
rc=$?
if [ "$rc" -eq 0 ]; then pass "T4-exit-0"; else fail "T4-exit-0 (rc=$rc)"; fi
if [ "$(docker_calls)" = "1" ]; then pass "T4-compose-up-once"; else fail "T4-compose-up-once: $(cat "$DOCKER_LOG" 2>/dev/null)"; fi
if echo "$out" | grep -q "started"; then
  pass "T4-reports-started"
else
  fail "T4-reports-started: $out"
fi

# ─── T5: fresh lock held → skip, no docker ──────────────────────────────────
echo ""
echo "=== T5: fresh lock held ⇒ skip ==="
reset_state
mkdir -p "$THOME/.um/state/auto-start.lock"
out=$(run_hook UM_SERVER_URL="http://localhost:6335" UM_COMPOSE_DIR="$COMPOSE_DIR")
rc=$?
if [ "$rc" -eq 0 ]; then pass "T5-exit-0"; else fail "T5-exit-0 (rc=$rc)"; fi
if [ "$(docker_calls)" = "0" ]; then pass "T5-no-docker"; else fail "T5-no-docker: $(cat "$DOCKER_LOG" 2>/dev/null)"; fi

# ─── T6: stale lock (>5 min) → stolen, compose runs ─────────────────────────
echo ""
echo "=== T6: stale lock ⇒ stolen ==="
reset_state
mkdir -p "$THOME/.um/state/auto-start.lock"
touch -d '10 minutes ago' "$THOME/.um/state/auto-start.lock" 2>/dev/null || true
out=$(run_hook UM_SERVER_URL="http://localhost:6335" UM_COMPOSE_DIR="$COMPOSE_DIR")
rc=$?
if [ "$rc" -eq 0 ]; then pass "T6-exit-0"; else fail "T6-exit-0 (rc=$rc)"; fi
if [ "$(docker_calls)" = "1" ]; then pass "T6-compose-after-steal"; else fail "T6-compose-after-steal: $(cat "$DOCKER_LOG" 2>/dev/null)"; fi
if [ ! -d "$THOME/.um/state/auto-start.lock" ]; then pass "T6-lock-released"; else fail "T6-lock-released"; fi

# ─── T7: two near-simultaneous starts → at most one compose up ──────────────
echo ""
echo "=== T7: two simultaneous starts ⇒ one compose up ==="
reset_state
write_mock_docker 1   # hold the lock ~1s so the second flight sees it
run_hook UM_SERVER_URL="http://localhost:6335" UM_COMPOSE_DIR="$COMPOSE_DIR" >/dev/null 2>&1 &
p1=$!
run_hook UM_SERVER_URL="http://localhost:6335" UM_COMPOSE_DIR="$COMPOSE_DIR" >/dev/null 2>&1 &
p2=$!
wait "$p1" "$p2"
calls="$(docker_calls)"
if [ "$calls" -le 1 ]; then
  pass "T7-at-most-one-compose (calls=$calls)"
else
  fail "T7-at-most-one-compose (calls=$calls)"
fi
write_mock_docker 0

# ─── T8: already-listening re-probe under the lock ──────────────────────────
# Health comes up between the first probe and the post-lock re-probe: the
# mock curl fails on call 1, succeeds from call 2 on.
echo ""
echo "=== T8: post-lock re-probe skips compose when server came up ==="
reset_state
count_file="$TMP/curl-count"
rm -f "$count_file"
cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
n=0
[ -f "$count_file" ] && n=\$(cat "$count_file")
n=\$((n + 1))
echo "\$n" > "$count_file"
[ "\$n" -ge 2 ] && exit 0
exit 7
MOCK
chmod +x "$MOCK_BIN/curl"
out=$(run_hook UM_SERVER_URL="http://localhost:6335" UM_COMPOSE_DIR="$COMPOSE_DIR")
rc=$?
if [ "$rc" -eq 0 ]; then pass "T8-exit-0"; else fail "T8-exit-0 (rc=$rc)"; fi
if [ "$(docker_calls)" = "0" ]; then pass "T8-no-compose"; else fail "T8-no-compose: $(cat "$DOCKER_LOG" 2>/dev/null)"; fi
# restore the flag-based curl for any later tests
cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
[ -f "$HEALTH_FLAG" ] && exit 0
exit 7
MOCK
chmod +x "$MOCK_BIN/curl"

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "auto-start.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
