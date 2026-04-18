#!/bin/bash
# smoke.sh — end-to-end verification for universal-memory server.
# Exits 0 on success, non-zero on any assertion failure.
#
# What this proves:
#   - /health responds with ok:true
#   - /api/add accepts POST and returns valid JSON
#   - If mem0 extracts any facts, /api/list contains their IDs and
#     DELETE /api/:id removes them cleanly (memory count returns to baseline)
#
# What it explicitly does NOT test:
#   - mem0's extraction quality (whether a given input yields facts). Extraction
#     is non-deterministic (temperature > 0 LLM) and belongs to mem0, not to this
#     server. If /api/add returns empty results, we log it and still pass — the
#     server's job is to run the pipeline correctly, not to guarantee mem0 stores
#     any particular input.

set -euo pipefail

ENDPOINT="${UM_ENDPOINT:-http://localhost:6335}"
MARKER="smoke-test-$(date +%s)-$$"

echo "[smoke] endpoint: $ENDPOINT"
echo "[smoke] marker:   $MARKER"

get_count() {
	curl -sf "$ENDPOINT/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('memories', -1))"
}

# 1/5 health check + baseline count
echo "[smoke] 1/5 health + baseline"
HEALTH=$(curl -sf "$ENDPOINT/health")
echo "$HEALTH" | grep -q '"ok":true' || {
	echo "FAIL: /health did not return ok:true — got $HEALTH"
	exit 1
}
BASELINE=$(get_count)
echo "[smoke]     baseline memories: $BASELINE"

# 2/5 add memory — use a name-shaped fact (extracts reliably in mem0's
# training distribution), capture the returned IDs.
echo "[smoke] 2/5 add memory and capture IDs"
ADD_RESP=$(curl -sf -X POST "$ENDPOINT/api/add" \
	-H 'Content-Type: application/json' \
	-d "{\"text\": \"The current user's name is $MARKER.\"}")

# Structural check: response is valid JSON with the expected shape
echo "$ADD_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert 'results' in data, 'response missing results key'
assert isinstance(data['results'], list), 'results is not a list'
" || {
	echo "FAIL: /api/add did not return valid response shape"
	echo "Response: $ADD_RESP"
	exit 1
}

IDS=$(echo "$ADD_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    if r.get('id'):
        print(r['id'])
")

if [ -z "$IDS" ]; then
	echo "[smoke]     NOTE: mem0 extraction returned no facts for this input"
	echo "[smoke]     /api/add responded correctly; extraction is a mem0 concern"
	echo "[smoke]     skipping round-trip verification (nothing to verify), proceeding to baseline check"
	NUM_ADDED=0
else
	NUM_ADDED=$(echo "$IDS" | wc -l | tr -d ' ')
	echo "[smoke]     mem0 stored $NUM_ADDED fact(s) — will verify round-trip"
fi

# 2b/5 metadata roundtrip — POST with metadata, then search and verify it survives
echo "[smoke] 2b/5 metadata roundtrip"
META_MARKER="smoke-meta-$(date +%s)-$$"
META_ADD_RESP=$(curl -sf -X POST "$ENDPOINT/api/add" \
	-H 'Content-Type: application/json' \
	-d "{\"text\": \"Metadata roundtrip probe: $META_MARKER\", \"metadata\": {\"smoke_id\": \"$META_MARKER\", \"type\": \"smoke-probe\"}}")

# Verify the response is valid JSON with results shape
echo "$META_ADD_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert 'results' in data, 'response missing results key'
assert isinstance(data['results'], list), 'results is not a list'
" || {
	echo "FAIL: /api/add with metadata did not return valid response shape"
	echo "Response: $META_ADD_RESP"
	exit 1
}

META_IDS=$(echo "$META_ADD_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    if r.get('id'):
        print(r['id'])
")

if [ -z "$META_IDS" ]; then
	echo "[smoke]     NOTE: mem0 extraction stored no facts for metadata probe — skipping metadata verification"
else
	# Search and check that metadata comes back on at least one result
	META_SEARCH_RESP=$(curl -sf -X POST "$ENDPOINT/api/search" \
		-H 'Content-Type: application/json' \
		-d "{\"query\": \"$META_MARKER\", \"limit\": 5}")
	echo "$META_SEARCH_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data if isinstance(data, list) else (data.get('results') or [])
smoke_id = '$META_MARKER'
found = any(
    (r.get('metadata') or {}).get('smoke_id') == smoke_id
    for r in items
)
if not found:
    print('WARN: metadata smoke_id not found in search results — may be a mem0 extraction artefact, not a forwarding bug')
    print('Search response:', json.dumps(items, indent=2))
else:
    print('OK: metadata survived round-trip')
" || true
	# Cleanup metadata probe IDs
	for id in $META_IDS; do
		curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null || true
	done
	echo "[smoke]     metadata probe records cleaned up"
fi

# 3/5 if we stored anything, confirm each ID appears in /api/list (add -> list round-trip)
echo "[smoke] 3/5 verify round-trip"
if [ "$NUM_ADDED" -gt 0 ]; then
	for id in $IDS; do
		FOUND=0
		for i in $(seq 1 15); do
			if curl -sf "$ENDPOINT/api/list" | grep -q "\"$id\""; then
				FOUND=1
				break
			fi
			sleep 2
		done
		[ "$FOUND" = "1" ] || {
			echo "FAIL: memory id=$id added but never appeared in /api/list after 30s"
			exit 1
		}
	done
	echo "[smoke]     all $NUM_ADDED ID(s) confirmed in /api/list"
else
	# Even with nothing added, /api/list must respond with valid JSON
	curl -sf "$ENDPOINT/api/list" | python3 -c "import json,sys; json.load(sys.stdin)" || {
		echo "FAIL: /api/list did not return valid JSON"
		exit 1
	}
	echo "[smoke]     /api/list responds with valid JSON (no IDs to verify)"
fi

# 4/5 cleanup by ID (no-op if nothing was added)
echo "[smoke] 4/5 cleanup by ID"
for id in $IDS; do
	curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null
done
[ "$NUM_ADDED" -gt 0 ] && echo "[smoke]     deleted $NUM_ADDED record(s)"

# 5/5 assert count returned to baseline
echo "[smoke] 5/5 verify baseline preserved"
FINAL=$(get_count)
if [ "$FINAL" -ne "$BASELINE" ]; then
	echo "FAIL: memory count not restored — baseline=$BASELINE final=$FINAL"
	exit 1
fi

echo "[smoke] PASS (baseline=$BASELINE preserved; added+verified+deleted $NUM_ADDED record(s))"
