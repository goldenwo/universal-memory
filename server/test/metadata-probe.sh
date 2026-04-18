#!/bin/bash
set -euo pipefail
UM_ENDPOINT="${UM_ENDPOINT:-http://localhost:6335}"

curl -sf -X POST "$UM_ENDPOINT/api/add" -H 'Content-Type: application/json' -d '{
  "text": "ADR-0042: switched to PostgreSQL for scale reasons.",
  "metadata": {
    "schema_version": 1,
    "type": "adr",
    "id": "adr-0042",
    "status": "current",
    "supersedes": ["adr-0039"],
    "valid_from": "2026-03-01"
  }
}'

SEARCH=$(curl -sf "$UM_ENDPOINT/api/search?q=PostgreSQL&limit=5")
echo "$SEARCH" | jq -e '.results[] | select(.metadata.id == "adr-0042" and .metadata.status == "current")' >/dev/null

# Also test delete-by-metadata
curl -sf -X POST "$UM_ENDPOINT/api/delete" -H 'Content-Type: application/json' -d '{"metadata": {"id": "adr-0042"}}'
SEARCH2=$(curl -sf "$UM_ENDPOINT/api/search?q=PostgreSQL&limit=5")
echo "$SEARCH2" | jq -e '.results | map(select(.metadata.id == "adr-0042")) | length == 0' >/dev/null

echo "OK: mem0 preserves metadata round-trip + supports delete-by-metadata"
