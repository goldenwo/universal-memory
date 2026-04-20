#!/bin/bash
# stop.sh — append-only raw capture. No LLM, no state update. <50ms.

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

{
    echo "## $TIME"
    echo ""
    echo "$TRANSCRIPT" | head -c 10000
    echo ""
} >> "$RAW_DIR/$DATE.md"

exit 0
