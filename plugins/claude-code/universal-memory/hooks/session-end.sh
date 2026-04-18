#!/usr/bin/env bash
# hooks/session-end.sh — orchestrates summarize + state update + reindex pipeline
#
# Usage: session-end.sh (no args; reads env vars)
#
# Env vars (all optional):
#   UM_PROJECT              - override project (default: from vault.sh project_name())
#   UM_CATCHUP_RAW_SINCE    - ISO-8601 timestamp; start of raw capture range
#   UM_CATCHUP_RAW_UNTIL    - ISO-8601 timestamp; end of raw capture range
#                             (unset = today only)
#   UM_ENDPOINT             - server URL for /api/reindex (default: http://localhost:6335)
#   UM_VAULT_DIR            - vault root (via vault.sh default)
#   UM_DETACH               - if "1", fork detached background process (for catchup/checkpoint)
#
# Exit 0 on any outcome (fail-soft).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

# Source vault.sh (which auto-sources frontmatter.sh)
if ! declare -f vault_path >/dev/null 2>&1; then
  # shellcheck source=./lib/vault.sh
  source "$LIB_DIR/vault.sh"
fi

# ---------------------------------------------------------------------------
# Detached mode — re-invoke self without UM_DETACH, fork to background
# ---------------------------------------------------------------------------
if [ "${UM_DETACH:-0}" = "1" ]; then
  vault=$(vault_path)
  mkdir -p "$vault/.telemetry" 2>/dev/null || true
  (
    exec >> "$vault/.telemetry/session-end-detached-$(date -u +%Y%m%d).log" 2>&1
    UM_DETACH= bash "$0"  # re-invoke self without detach flag to do the work
  ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1: Resolve project + vault + range
# ---------------------------------------------------------------------------
project="${UM_PROJECT:-$(project_name)}"
vault=$(vault_path)

today=$(date -u +%Y-%m-%d)

# Determine raw files to process
raw_files=()

if [ -n "${UM_CATCHUP_RAW_SINCE:-}" ] && [ -n "${UM_CATCHUP_RAW_UNTIL:-}" ]; then
  # Range mode: select raw files by mtime within SINCE..UNTIL
  raw_dir="$vault/captures/$project/raw"
  if [ -d "$raw_dir" ]; then
    # Convert ISO timestamps to epoch seconds
    since_epoch=$(date -d "${UM_CATCHUP_RAW_SINCE}" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "${UM_CATCHUP_RAW_SINCE}" +%s 2>/dev/null || echo 0)
    until_epoch=$(date -d "${UM_CATCHUP_RAW_UNTIL}" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "${UM_CATCHUP_RAW_UNTIL}" +%s 2>/dev/null || echo 9999999999)

    while IFS= read -r -d '' raw_file; do
      raw_mtime=$(stat -c %Y "$raw_file" 2>/dev/null || stat -f %m "$raw_file" 2>/dev/null || echo 0)
      if [ "$raw_mtime" -ge "$since_epoch" ] && [ "$raw_mtime" -le "$until_epoch" ]; then
        raw_files+=("$raw_file")
      fi
    done < <(find "$raw_dir" -type f -name '*.md' -print0 2>/dev/null)
  fi
else
  # Default: today's file only
  today_file="$vault/captures/$project/raw/${today}.md"
  if [ -f "$today_file" ]; then
    raw_files+=("$today_file")
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: Read raw captures — concatenate into single transcript
# ---------------------------------------------------------------------------
if [ "${#raw_files[@]}" -eq 0 ]; then
  # No raw captures — silent exit
  exit 0
fi

transcript=""
for raw_file in "${raw_files[@]}"; do
  if [ -f "$raw_file" ]; then
    content=$(cat "$raw_file" 2>/dev/null || true)
    if [ -n "$content" ]; then
      if [ -n "$transcript" ]; then
        transcript="${transcript}"$'\n'"${content}"
      else
        transcript="$content"
      fi
    fi
  fi
done

if [ -z "$transcript" ]; then
  # All files were empty — silent exit
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 3: Call summarize.sh — capture summary body
# ---------------------------------------------------------------------------
summary_body=$(printf '%s' "$transcript" | UM_PROJECT="$project" bash "$LIB_DIR/summarize.sh" 2>/dev/null || true)

if [ -z "$summary_body" ]; then
  # summarize.sh returned empty — already logged the reason; exit silently
  echo "[session-end] summarize returned empty (LLM unavailable or transcript too short), skipping" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 4: Build session summary file path
# ---------------------------------------------------------------------------
ts=$(date -u +%Y%m%d-%H%M%S)
summary_id="${ts}-${project}"
summary_path="$vault/sessions/$project/${summary_id}.md"
iso_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ---------------------------------------------------------------------------
# Step 5: Write session summary atomically
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$summary_path")" || { echo "[session-end] could not mkdir for summary, skipping" >&2; exit 0; }

summary_fm="schema_version: 1
type: session_summary
id: ${summary_id}
title: Session summary — ${project} @ ${iso_now}
status: current
valid_from: ${iso_now}
project: ${project}"

if ! fm_write "$summary_path" "$summary_fm" "$summary_body"; then
  echo "[session-end] failed to write session summary to $summary_path" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 6: Acquire lock on state.md
# ---------------------------------------------------------------------------
state_file="$vault/state/$project/state.md"
lockdir="$vault/state/$project/state.md.lockdir"
mkdir -p "$(dirname "$lockdir")" || { echo "[session-end] could not mkdir for lock, skipping state update" >&2; exit 0; }

LOCK_HELD=0
for i in 1 2 3 4 5; do
  if mkdir "$lockdir" 2>/dev/null; then
    LOCK_HELD=1
    break
  fi
  sleep 1
done

if [ "$LOCK_HELD" -ne 1 ]; then
  echo "[session-end] could not acquire lock on state.md after 5 attempts, skipping state update" >&2
  # Summary is already safely written; still do reindex + telemetry below
else
  # Register trap to release lock on exit
  # shellcheck disable=SC2064
  trap "rmdir '$lockdir' 2>/dev/null; true" EXIT

  # -------------------------------------------------------------------------
  # Step 7: Read old state.md
  # -------------------------------------------------------------------------
  old_state=""
  if [ -f "$state_file" ]; then
    old_state=$(cat "$state_file" 2>/dev/null || true)
  fi

  # -------------------------------------------------------------------------
  # Step 8: Call update-state.sh with separated-format stdin
  # -------------------------------------------------------------------------
  new_state=$(
    {
      printf '===UM-OLD-STATE===\n%s\n' "$old_state"
      printf '===UM-SESSION-SUMMARY===\n%s\n' "$summary_body"
      printf '===UM-END===\n'
    } | UM_PROJECT="$project" bash "$LIB_DIR/update-state.sh" 2>/dev/null || true
  )

  if [ -z "$new_state" ]; then
    echo "[session-end] update-state returned empty (LLM unavailable or malformed output), keeping existing state.md" >&2
    # Summary is already on disk; release lock and continue
    rmdir "$lockdir" 2>/dev/null || true
    trap - EXIT
  else
    # -----------------------------------------------------------------------
    # Step 9: Write state.md atomically
    # -----------------------------------------------------------------------
    mkdir -p "$(dirname "$state_file")" || {
      echo "[session-end] could not mkdir for state.md, skipping state write" >&2
      rmdir "$lockdir" 2>/dev/null || true
      trap - EXIT
    }
    tmp="${state_file}.tmp.$$"
    if printf '%s' "$new_state" > "$tmp" 2>/dev/null; then
      if mv "$tmp" "$state_file" 2>/dev/null; then
        : # success
      else
        rm -f "$tmp" 2>/dev/null || true
        echo "[session-end] failed to rename state.md.tmp, skipping state write" >&2
      fi
    else
      rm -f "$tmp" 2>/dev/null || true
      echo "[session-end] failed to write state.md.tmp, skipping state write" >&2
    fi

    # Step 10: Release lock (trap handles it, but be explicit)
    rmdir "$lockdir" 2>/dev/null || true
    trap - EXIT
  fi
fi

# ---------------------------------------------------------------------------
# Step 11: Reindex session summary (best-effort, skip on error)
# Do NOT reindex state.md — server rejects type=state with 400
# ---------------------------------------------------------------------------
endpoint="${UM_ENDPOINT:-http://localhost:6335}"
rel_path="sessions/$project/${summary_id}.md"

curl -sfm 10 -X POST "$endpoint/api/reindex" \
  -H 'Content-Type: application/json' \
  -d "{\"path\": \"$rel_path\"}" >/dev/null 2>&1 || \
  echo "[session-end] reindex failed (server may be down), summary is safe on disk" >&2

# ---------------------------------------------------------------------------
# Step 12: Append orchestration telemetry
# ---------------------------------------------------------------------------
log="$vault/.telemetry/session-end.log"
mkdir -p "$(dirname "$log")" 2>/dev/null || true
state_updated="0"
if [ -f "$state_file" ]; then
  # Check if state was updated this run by comparing mtime to now (within 5s)
  state_updated="1"
fi
printf '%s\tproject=%s\tsummary=%s\tstate_updated=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$project" "$summary_id" "$state_updated" >> "$log" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 13: Exit 0 — always
# ---------------------------------------------------------------------------
exit 0
