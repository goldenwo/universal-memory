#!/bin/bash
# smoke.sh — end-to-end verification for universal-memory server.
# Exits 0 on success, non-zero on any assertion failure.
#
# Flow: capture pre-test memory count -> add marker memory -> poll search
# until found (bounded) -> cleanup -> assert count returned to baseline.

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

# 2/5 add memory with unique marker
# Note: mem0's extraction LLM filters out meta-text ("this is a test") — we phrase
# the marker as a user-preference fact so extraction preserves it verbatim.
echo "[smoke] 2/5 add memory"
curl -sf -X POST "$ENDPOINT/api/add" \
	-H 'Content-Type: application/json' \
	-d "{\"text\": \"User's unique identifier for the current session is $MARKER.\"}" \
	>/dev/null

# 3/5 poll search until marker appears (bounded — extraction LLM latency varies)
echo "[smoke] 3/5 poll for marker (up to 30s)"
FOUND=0
for i in $(seq 1 15); do
	RESULT=$(curl -sf -X POST "$ENDPOINT/api/search" \
		-H 'Content-Type: application/json' \
		-d "{\"query\": \"smoke test marker $MARKER\", \"limit\": 5}" || echo "[]")
	if echo "$RESULT" | grep -q "$MARKER"; then
		FOUND=1
		echo "[smoke]     found on attempt $i"
		break
	fi
	sleep 2
done
[ "$FOUND" = "1" ] || {
	echo "FAIL: marker never appeared in search after 30s — last result: $RESULT"
	exit 1
}

# 4/5 cleanup — delete every memory containing the marker
echo "[smoke] 4/5 cleanup"
IDS=$(curl -sf "$ENDPOINT/api/list" | python3 -c "
import json, sys
marker = '$MARKER'
items = json.load(sys.stdin)
for r in items:
    if marker in r.get('memory', ''):
        print(r.get('id', ''))
")
for id in $IDS; do
	[ -n "$id" ] && curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null
done

# 5/5 assert count returned to baseline (proves cleanup worked, no leftover test data)
echo "[smoke] 5/5 verify cleanup"
FINAL=$(get_count)
if [ "$FINAL" -ne "$BASELINE" ]; then
	echo "FAIL: memory count not restored — baseline=$BASELINE final=$FINAL"
	exit 1
fi

echo "[smoke] PASS (baseline=$BASELINE preserved)"
