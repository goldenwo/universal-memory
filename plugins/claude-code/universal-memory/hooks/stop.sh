#!/bin/bash
# stop.sh — append-only raw capture. No LLM, no state update. <50ms.
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
