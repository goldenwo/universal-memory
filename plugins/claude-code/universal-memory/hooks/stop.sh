#!/bin/bash
# stop.sh — append-only raw capture. No LLM, no state update.

# Recursive-hook guard — if invoked inside a summarizer subprocess (A3's
# claude-agent-sdk backend spawns `claude -p`), exit immediately. Without
# this, the nested `claude` process would re-trigger this hook, causing
# duplicate captures at best and infinite loop at worst.
if [ "${UM_IN_SUMMARIZER_SUBPROCESS:-}" = "1" ]; then exit 0; fi

set -uo pipefail

TRANSCRIPT=$(cat)
[ -z "$TRANSCRIPT" ] && exit 0

PROJECT=$(basename "${CLAUDE_CWD:-$(pwd)}")
VAULT="${UM_VAULT_DIR:-$HOME/.um/vault}"
DATE=$(date -u +%Y-%m-%d)
TIME=$(date -u +%H:%M:%SZ)
RAW_DIR="$VAULT/captures/$PROJECT/raw"
mkdir -p "$RAW_DIR"

RAW_FILE="$RAW_DIR/$DATE.md"
LOCK="$RAW_FILE.lockdir"

# Truncate transcript to 10KB up-front (kept in a variable, no temp file).
TRANSCRIPT_TRUNC=$(printf '%s' "$TRANSCRIPT" | head -c 10000)

# ---------------------------------------------------------------------------
# Acquire an exclusive advisory lock on the sibling `.lockdir` directory before
# appending, so that concurrent stop.sh invocations and the memory_append_turn
# MCP tool (server/lib/append-turn.mjs) do not interleave writes. Both writers
# now coordinate on the same <date>.md.lockdir path.
#
# B.11 (v0.6): migrated from `perl Fcntl::flock` against `<date>.md.lock` to
# bash mkdir-based lockdir. flock and proper-lockfile/lockdir.mjs use
# incompatible primitives — coexisting on the same file caused cross-process
# races in v0.5. V4 verification (commit 3ae36ef) confirmed mkdir is atomic
# across bash + node on Windows NTFS, so this primitive is safe for both sides.
#
# Stale recovery: if a lockdir's mtime is older than 10 minutes, assume the
# previous owner crashed and reclaim it. Mirrors the Node-side lockdir.mjs
# 10-min threshold (DEFAULT_STALE_MS).
# ---------------------------------------------------------------------------
STALE_MIN=10                # find -mmin +10 = 10 minutes
TRIES=0
MAX_TRIES=200               # 200 * 25ms = 5s timeout

while ! mkdir "$LOCK" 2>/dev/null; do
  # Stale check inside the loop so a crashed previous owner can be reclaimed
  # without waiting the full 5 seconds first.
  if [ -d "$LOCK" ] && \
     [ -n "$(find "$LOCK" -maxdepth 0 -mmin +${STALE_MIN} 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
    continue                # retry mkdir immediately after reclaim
  fi
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -gt "$MAX_TRIES" ]; then
    echo "[stop] could not acquire $LOCK after ~5s — abandoning turn capture" >&2
    exit 0
  fi
  sleep 0.025
done

# Release lockdir on any exit (clean or signal). Single trap covers both the
# lockdir and any future cleanup; bash only honors the most recent trap per
# signal, so consolidate here rather than registering two.
# shellcheck disable=SC2064
trap "rmdir '$LOCK' 2>/dev/null; true" EXIT INT TERM

# Append turn under lock. Plain bash redirect — no perl spawn needed.
{
  printf '## %s\n\n%s\n\n' "$TIME" "$TRANSCRIPT_TRUNC"
} >> "$RAW_FILE"

exit 0
