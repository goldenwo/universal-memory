#!/bin/bash
# stop.sh — universal-memory Stop hook for Claude Code
#
# Reads the session transcript on stdin, writes a markdown capture file as
# the authoritative source, then POSTs to the memory server for indexing.
#
# Markdown-first: the markdown write is the source of truth. The POST is a
# best-effort index update. If the server is unreachable, the capture still
# persists and can be ingested later.
#
# Required env:
#   UM_ENDPOINT        Memory server base URL (optional — if unset, only the
#                      markdown capture is written; useful offline or for
#                      deferred ingestion setups)
#
# Optional env:
#   UM_CAPTURE_DIR     Where raw captures are stored
#                      Default: $HOME/.um/captures/<project>/raw

set -euo pipefail

TRANSCRIPT=$(cat)
[ -z "$TRANSCRIPT" ] && exit 0

# Extract last 6 user/assistant turns from JSONL transcript
SUMMARY=$(echo "$TRANSCRIPT" | python3 -c "
import sys, json

transcript = sys.stdin.read()
lines = []
for line in transcript.strip().split('\n'):
    line = line.strip()
    if not line:
        continue
    try:
        entry = json.loads(line)
        role = entry.get('role', entry.get('type', ''))
        content = entry.get('content', entry.get('message', ''))
        if isinstance(content, list):
            content = ' '.join(c.get('text', '') for c in content if isinstance(c, dict))
        if content and role in ('user', 'assistant', 'human'):
            lines.append(f'{role}: {content[:200]}')
    except json.JSONDecodeError:
        continue

recent = lines[-6:] if len(lines) > 6 else lines
print('\n'.join(recent))
" 2>/dev/null)

[ -z "$SUMMARY" ] && exit 0
[ ${#SUMMARY} -lt 20 ] && exit 0

# ─── Markdown-first: write authoritative source ──────────────────────────
PROJECT=$(basename "${CLAUDE_CWD:-$(pwd)}")
CAPTURE_DIR="${UM_CAPTURE_DIR:-$HOME/.um/captures/$PROJECT/raw}"
mkdir -p "$CAPTURE_DIR"

DATE=$(date -u +%Y-%m-%d)
TIME=$(date -u +%H:%M:%SZ)
CAPTURE_FILE="$CAPTURE_DIR/$DATE.md"
{
	echo "## $TIME"
	echo ""
	echo "$SUMMARY"
	echo ""
} >>"$CAPTURE_FILE"

# ─── Index update: fire-and-forget POST to memory server ─────────────────
if [ -n "${UM_ENDPOINT:-}" ]; then
	PAYLOAD=$(python3 -c "import json, sys; print(json.dumps({'text': sys.stdin.read()[:2000]}))" <<<"$SUMMARY")
	(curl -sf --max-time 10 -X POST "$UM_ENDPOINT/api/add" \
		-H 'Content-Type: application/json' \
		-d "$PAYLOAD" \
		>/dev/null 2>&1) &
fi

exit 0
