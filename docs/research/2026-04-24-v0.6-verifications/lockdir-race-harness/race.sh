#!/usr/bin/env bash
# V4 — cross-process lockdir race harness
# Spawns a bash `mkdir` + a node `fs.mkdirSync` targeting the same lockdir
# in parallel. Invariant: for each iteration, exactly ONE wins (creates the
# dir) and ONE loses (receives EEXIST or errno equivalent).
#
# Cross-platform path handling: on Windows/MSYS/Cygwin, bash's `/tmp` is a
# virtual mount that does NOT map 1:1 to the Windows path Node sees. We use
# `cygpath -w` when available to compute a single real filesystem path that
# both surfaces address identically. On Linux/macOS this is a no-op.
#
# Fair-race design: on msys Windows, bash's external `/usr/bin/mkdir` takes
# ~30 ms per invocation (process-spawn cost) while node's `fs.mkdirSync` is
# ~200 µs — so when both racers start from a cold state, node always "gets
# there first" regardless of ordering. To stress the invariant from both
# sides, the harness runs three variants:
#
#   A. symmetric — both racers busy-wait on GO, fire simultaneously. On
#      Windows node wins by timing; on Linux/macOS this is a true race.
#   B. bash-preacquired — bash creates the lock BEFORE node starts, then
#      node tries to acquire. Exercises the "pre-existing lock" case the
#      way production session-end.sh encounters it.
#   C. node-preacquired — node creates the lock BEFORE bash starts, then
#      bash tries to acquire. The reverse direction.
#
# Invariant under test in ALL variants: exactly-one-winner per iteration.

set -u

# Base directory both surfaces can address (single physical path).
BASE_DIR="${TMPDIR:-/tmp}/lockdir-race-harness-$$"
mkdir -p "$BASE_DIR"
trap 'rm -rf "$BASE_DIR" 2>/dev/null' EXIT

if command -v cygpath >/dev/null 2>&1; then
  BASE_WIN="$(cygpath -w "$BASE_DIR")"
else
  BASE_WIN="$BASE_DIR"
fi

iters="${1:-100}"
total_bash_wins=0; total_node_wins=0
total_bash_losses=0; total_node_losses=0
total_anomalies=0; total_errors=0

# Canonicalize a bash path to whatever node resolves to the same FS object.
to_node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

# Variant A: symmetric race — both processes spin on GO, fire together.
run_symmetric() {
  local iters="$1"
  local bash_wins=0 node_wins=0 bash_losses=0 node_losses=0
  local anomalies=0 errors=0

  for i in $(seq 1 "$iters"); do
    local BASH_LOCK="$BASE_DIR/sym-$i.lockdir"
    local NODE_LOCK; NODE_LOCK="$(to_node_path "$BASH_LOCK")"
    local GO="$BASE_DIR/sym-$i.go"
    local LOG_B="$BASE_DIR/sym-$i.b.log"
    local LOG_N="$BASE_DIR/sym-$i.n.log"

    rm -rf "$BASH_LOCK" 2>/dev/null
    rm -f "$GO" 2>/dev/null

    (
      while [ ! -e "$GO" ]; do :; done
      if mkdir "$BASH_LOCK" 2>/dev/null; then echo "B:$i:win"
      else echo "B:$i:loss"; fi
    ) > "$LOG_B" &
    local BASH_PID=$!

    LOCK="$NODE_LOCK" GOFILE="$GO" ITER="$i" node -e "
      const fs = require('fs');
      const lock = process.env.LOCK;
      const gofile = process.env.GOFILE;
      const iter = process.env.ITER;
      while (!fs.existsSync(gofile)) {}
      try { fs.mkdirSync(lock); console.log('N:' + iter + ':win'); }
      catch(e) {
        if (e.code === 'EEXIST') console.log('N:' + iter + ':loss');
        else console.log('N:' + iter + ':error:' + e.code);
      }
    " > "$LOG_N" 2>&1 &
    local NODE_PID=$!

    # Give both processes time to reach busy-wait.
    sleep 0.05
    : > "$GO"
    wait "$BASH_PID"
    wait "$NODE_PID"

    local b n
    b=$(cat "$LOG_B" 2>/dev/null)
    n=$(cat "$LOG_N" 2>/dev/null)

    case "$b" in *":win") bash_wins=$((bash_wins+1)) ;; esac
    case "$b" in *":loss") bash_losses=$((bash_losses+1)) ;; esac
    case "$n" in *":win") node_wins=$((node_wins+1)) ;; esac
    case "$n" in *":loss") node_losses=$((node_losses+1)) ;; esac
    case "$n" in *":error:"*) errors=$((errors+1)) ;; esac

    local b_won=0 n_won=0 winners
    case "$b" in *":win") b_won=1 ;; esac
    case "$n" in *":win") n_won=1 ;; esac
    winners=$((b_won + n_won))
    if [ "$winners" -ne 1 ]; then
      anomalies=$((anomalies+1))
      echo "ANOMALY variant=symmetric iter=$i: bash=$b node=$n" >&2
    fi

    rm -rf "$BASH_LOCK" "$GO" "$LOG_B" "$LOG_N" 2>/dev/null
  done

  echo "=== Variant A: symmetric ($iters iters) ==="
  echo "  Bash wins: $bash_wins, losses: $bash_losses"
  echo "  Node wins: $node_wins, losses: $node_losses"
  echo "  Node errors (non-EEXIST): $errors"
  echo "  Anomalies (not exactly-one winner): $anomalies"

  total_bash_wins=$((total_bash_wins + bash_wins))
  total_node_wins=$((total_node_wins + node_wins))
  total_bash_losses=$((total_bash_losses + bash_losses))
  total_node_losses=$((total_node_losses + node_losses))
  total_anomalies=$((total_anomalies + anomalies))
  total_errors=$((total_errors + errors))
}

# Variant B: bash pre-acquires, node tries second.
run_bash_preacquired() {
  local iters="$1"
  local bash_wins=0 node_wins=0 bash_losses=0 node_losses=0
  local anomalies=0 errors=0

  for i in $(seq 1 "$iters"); do
    local BASH_LOCK="$BASE_DIR/bpre-$i.lockdir"
    local NODE_LOCK; NODE_LOCK="$(to_node_path "$BASH_LOCK")"
    local LOG_B="$BASE_DIR/bpre-$i.b.log"
    local LOG_N="$BASE_DIR/bpre-$i.n.log"

    rm -rf "$BASH_LOCK" 2>/dev/null

    # Bash acquires first (single-threaded here).
    if mkdir "$BASH_LOCK" 2>/dev/null; then echo "B:$i:win" > "$LOG_B"
    else echo "B:$i:loss" > "$LOG_B"; fi

    # Then node tries.
    LOCK="$NODE_LOCK" ITER="$i" node -e "
      const fs = require('fs');
      const lock = process.env.LOCK;
      const iter = process.env.ITER;
      try { fs.mkdirSync(lock); console.log('N:' + iter + ':win'); }
      catch(e) {
        if (e.code === 'EEXIST') console.log('N:' + iter + ':loss');
        else console.log('N:' + iter + ':error:' + e.code);
      }
    " > "$LOG_N" 2>&1

    local b n
    b=$(cat "$LOG_B" 2>/dev/null)
    n=$(cat "$LOG_N" 2>/dev/null)

    case "$b" in *":win") bash_wins=$((bash_wins+1)) ;; esac
    case "$b" in *":loss") bash_losses=$((bash_losses+1)) ;; esac
    case "$n" in *":win") node_wins=$((node_wins+1)) ;; esac
    case "$n" in *":loss") node_losses=$((node_losses+1)) ;; esac
    case "$n" in *":error:"*) errors=$((errors+1)) ;; esac

    local b_won=0 n_won=0 winners
    case "$b" in *":win") b_won=1 ;; esac
    case "$n" in *":win") n_won=1 ;; esac
    winners=$((b_won + n_won))
    if [ "$winners" -ne 1 ]; then
      anomalies=$((anomalies+1))
      echo "ANOMALY variant=bash-preacquired iter=$i: bash=$b node=$n" >&2
    fi

    rm -rf "$BASH_LOCK" "$LOG_B" "$LOG_N" 2>/dev/null
  done

  echo "=== Variant B: bash-preacquired ($iters iters) ==="
  echo "  Bash wins: $bash_wins, losses: $bash_losses"
  echo "  Node wins: $node_wins, losses: $node_losses"
  echo "  Node errors (non-EEXIST): $errors"
  echo "  Anomalies (not exactly-one winner): $anomalies"

  total_bash_wins=$((total_bash_wins + bash_wins))
  total_node_wins=$((total_node_wins + node_wins))
  total_bash_losses=$((total_bash_losses + bash_losses))
  total_node_losses=$((total_node_losses + node_losses))
  total_anomalies=$((total_anomalies + anomalies))
  total_errors=$((total_errors + errors))
}

# Variant C: node pre-acquires, bash tries second.
run_node_preacquired() {
  local iters="$1"
  local bash_wins=0 node_wins=0 bash_losses=0 node_losses=0
  local anomalies=0 errors=0

  for i in $(seq 1 "$iters"); do
    local BASH_LOCK="$BASE_DIR/npre-$i.lockdir"
    local NODE_LOCK; NODE_LOCK="$(to_node_path "$BASH_LOCK")"
    local LOG_B="$BASE_DIR/npre-$i.b.log"
    local LOG_N="$BASE_DIR/npre-$i.n.log"

    rm -rf "$BASH_LOCK" 2>/dev/null

    # Node acquires first.
    LOCK="$NODE_LOCK" ITER="$i" node -e "
      const fs = require('fs');
      const lock = process.env.LOCK;
      const iter = process.env.ITER;
      try { fs.mkdirSync(lock); console.log('N:' + iter + ':win'); }
      catch(e) {
        if (e.code === 'EEXIST') console.log('N:' + iter + ':loss');
        else console.log('N:' + iter + ':error:' + e.code);
      }
    " > "$LOG_N" 2>&1

    # Then bash tries.
    if mkdir "$BASH_LOCK" 2>/dev/null; then echo "B:$i:win" > "$LOG_B"
    else echo "B:$i:loss" > "$LOG_B"; fi

    local b n
    b=$(cat "$LOG_B" 2>/dev/null)
    n=$(cat "$LOG_N" 2>/dev/null)

    case "$b" in *":win") bash_wins=$((bash_wins+1)) ;; esac
    case "$b" in *":loss") bash_losses=$((bash_losses+1)) ;; esac
    case "$n" in *":win") node_wins=$((node_wins+1)) ;; esac
    case "$n" in *":loss") node_losses=$((node_losses+1)) ;; esac
    case "$n" in *":error:"*) errors=$((errors+1)) ;; esac

    local b_won=0 n_won=0 winners
    case "$b" in *":win") b_won=1 ;; esac
    case "$n" in *":win") n_won=1 ;; esac
    winners=$((b_won + n_won))
    if [ "$winners" -ne 1 ]; then
      anomalies=$((anomalies+1))
      echo "ANOMALY variant=node-preacquired iter=$i: bash=$b node=$n" >&2
    fi

    rm -rf "$BASH_LOCK" "$LOG_B" "$LOG_N" 2>/dev/null
  done

  echo "=== Variant C: node-preacquired ($iters iters) ==="
  echo "  Bash wins: $bash_wins, losses: $bash_losses"
  echo "  Node wins: $node_wins, losses: $node_losses"
  echo "  Node errors (non-EEXIST): $errors"
  echo "  Anomalies (not exactly-one winner): $anomalies"

  total_bash_wins=$((total_bash_wins + bash_wins))
  total_node_wins=$((total_node_wins + node_wins))
  total_bash_losses=$((total_bash_losses + bash_losses))
  total_node_losses=$((total_node_losses + node_losses))
  total_anomalies=$((total_anomalies + anomalies))
  total_errors=$((total_errors + errors))
}

# Split iterations across the three variants.
third=$((iters / 3))
rest=$((iters - 2 * third))
run_symmetric "$third"
run_bash_preacquired "$third"
run_node_preacquired "$rest"

echo ""
echo "=== TOTAL ($iters iters across 3 variants) ==="
echo "Bash wins: $total_bash_wins, losses: $total_bash_losses"
echo "Node wins: $total_node_wins, losses: $total_node_losses"
echo "Node errors (non-EEXIST): $total_errors"
echo "Anomalies (not exactly-one winner): $total_anomalies"
if [ "$total_anomalies" -eq 0 ] && [ "$total_errors" -eq 0 ]; then
  echo "VERDICT: mkdir is atomic across bash + node on this platform"
  exit 0
else
  echo "VERDICT: race violation — mkdir is NOT safe as the cross-process primitive"
  exit 1
fi
