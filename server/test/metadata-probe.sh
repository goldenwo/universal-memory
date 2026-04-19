#!/bin/bash
# metadata-probe.sh — Task 2.5 gate probe.
# Verifies: mem0 preserves metadata round-trip AND POST /api/delete works.
#
# Uses /api/reindex (infer:false) for reliable metadata storage, which is
# the correct approach for structured vault docs with explicit frontmatter.
# /api/add with infer:true goes through LLM extraction which may rewrite or
# drop metadata — that is a mem0 concern, not this server's.
#
# Requires: curl, jq, and either:
#   - UM_VAULT_DIR set (host run), OR
#   - /vault writable (container run)
# Run via:
#   docker run --rm --network universal-memory_default \
#     -v "$(pwd)/server/test:/test" \
#     -e UM_ENDPOINT=http://memory-server:6335 \
#     -e UM_VAULT_DIR=/vault \
#     -v "$HOME/.um/vault:/vault" \
#     alpine:latest sh -c "apk add --no-cache curl jq bash >/dev/null && bash /test/metadata-probe.sh"
set -euo pipefail
UM_ENDPOINT="${UM_ENDPOINT:-http://localhost:6335}"
VAULT_DIR="${UM_VAULT_DIR:-/vault}"
PROBE_SUBDIR="$VAULT_DIR/sessions/metadata-probe-$$"

cleanup() {
  rm -rf "$PROBE_SUBDIR"
  # Best-effort delete from mem0 in case probe exits mid-run
  curl -sf -X POST "$UM_ENDPOINT/api/delete" \
    -H 'Content-Type: application/json' \
    -d '{"metadata": {"id": "adr-0042"}}' >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Step 1: create vault fixture + reindex (infer:false — metadata preserved exactly)
mkdir -p "$PROBE_SUBDIR"
cat > "$PROBE_SUBDIR/adr-0042.md" <<'DOCEOF'
---
schema_version: 1
type: adr
id: adr-0042
title: ADR-0042 switched to PostgreSQL
status: current
valid_from: 2026-03-01
supersedes:
  - adr-0039
---
ADR-0042: switched to PostgreSQL for scale reasons.
DOCEOF

REINDEX_RESP=$(curl -sf -X POST "$UM_ENDPOINT/api/reindex" \
  -H 'Content-Type: application/json' \
  -d "{\"path\": \"sessions/metadata-probe-$$/adr-0042.md\"}")
echo "$REINDEX_RESP" | jq -e '.ok == true and .indexed == true' >/dev/null

sleep 2

# Step 2: search and verify metadata is preserved
SEARCH=$(curl -sf "$UM_ENDPOINT/api/search?q=PostgreSQL&limit=5")
echo "$SEARCH" | jq -e '.results[] | select(.metadata.id == "adr-0042" and .metadata.status == "current")' >/dev/null

# Step 3: delete-by-metadata
DEL_RESP=$(curl -sf -X POST "$UM_ENDPOINT/api/delete" \
  -H 'Content-Type: application/json' \
  -d '{"metadata": {"id": "adr-0042"}}')
echo "$DEL_RESP" | jq -e '.ok == true and .deleted >= 1' >/dev/null

sleep 2

# Step 4: verify gone
SEARCH2=$(curl -sf "$UM_ENDPOINT/api/search?q=PostgreSQL&limit=5")
echo "$SEARCH2" | jq -e '.results | map(select(.metadata.id == "adr-0042")) | length == 0' >/dev/null

echo "OK: mem0 preserves metadata round-trip + supports delete-by-metadata"
