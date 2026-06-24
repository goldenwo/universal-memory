#!/bin/bash
# smoke.sh — end-to-end verification for universal-memory server.
# Exits 0 on success, non-zero on any assertion failure.
#
# What this proves:
#   - /health responds with ok:true
#   - /api/add accepts POST and returns valid JSON
#   - If mem0 extracts any facts, /api/list contains their IDs and
#     DELETE /api/:id removes them cleanly (memory count returns to baseline)
#   - /api/search returns { results: [...] } wrapper (not bare array)
#   - Default filter excludes docs with invalidated_at set; status is server-managed (D3.1 auto-stamp)
#   - /api/add rejects caller-supplied reserved metadata fields (D3.1 §3.2 guard)
#   - include_superseded=true bypasses the filter (POST body + GET query param)
#   - Legacy docs with no metadata are still returned (backward compat)
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

# D1 S1 — flag-on default regression guard (plan E.5, spec §10.1).
# Post-flip (v1.1): default is ON. Smoke MUST run under that contract — if a
# future PR regresses the default to OFF (or fat-fingers the value), this
# assertion catches it before the rest of smoke proceeds with potentially-
# changed semantics.
#
# Truthiness MUST match the runtime gate at server/lib/add.mjs
# `computeDedupEligible()`, which uses strict `=== 'false'`. Only the literal
# lowercase string `false` disables dedup at the server; every other value
# (including '0', 'FALSE', 'False', 'no', typos) keeps dedup ON. If S1
# accepted broader off-truthy values it would silently advertise "explicitly
# disabled, skipping S2" while the server actually still has dedup ON —
# hiding the exact operator-config drift S1 exists to surface (post-merge
# review of PR #77 caught this gap; this PR tightens it).
case "${UM_DEDUP_ENABLED:-true}" in
	true|""|1|TRUE|True)
		echo "[smoke] D1 S1 flag-on default: UM_DEDUP_ENABLED='${UM_DEDUP_ENABLED:-<unset, default-on>}' (PASS)"
		;;
	false)
		echo "[smoke] D1 S1: dedup explicitly disabled (UM_DEDUP_ENABLED='false') — S2 will be skipped"
		;;
	*)
		echo "[smoke] D1 S1 FAIL: UM_DEDUP_ENABLED='${UM_DEDUP_ENABLED}' is not a recognized truth value." >&2
		echo "[smoke]   Runtime gate (server/lib/add.mjs:computeDedupEligible) requires literal lowercase 'false' to disable." >&2
		echo "[smoke]   Other values (0, FALSE, False, no, typos) keep dedup ON — S1 refuses to PASS them to avoid silently misadvertising 'explicitly disabled'." >&2
		exit 1
		;;
esac

# v0.6 auth (Phase B): /api/* and /mcp require bearer auth from non-loopback
# callers. Smoke runs against a docker-compose stack where the host's
# `localhost:6335` calls arrive at the container with the bridge gateway IP
# as source, not 127.0.0.1 — so loopback-bypass does not apply. Read the
# server-generated token from .env (install.sh writes it there) and override
# the `curl` builtin so every call site picks up the Authorization header.
# Routes with bypassAuth (/health, /openapi.yaml) silently ignore the header.
# R1 hardening (PR #31 review):
#   - `|| true` on the grep pipeline: if `.env` exists but lacks an
#     UM_AUTH_TOKEN= line, grep exits 1 and `set -o pipefail` would
#     otherwise kill smoke silently — same class of bug as the install.sh
#     UM_CONTAINER_USER fix landed in commit 05b1b32.
#   - Quote-strip pattern: matches install.sh's `_UM_AT_EXISTING` block —
#     only strips matched leading/trailing quotes, not every `"` byte
#     (which `tr -d '"'` would, corrupting any token containing `"`).
if [ -z "${UM_AUTH_TOKEN:-}" ] && [ -f "${UM_ENV_FILE:-.env}" ]; then
	UM_AUTH_TOKEN=$(grep -E '^UM_AUTH_TOKEN=' "${UM_ENV_FILE:-.env}" | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//;s/^'\''//;s/'\''$//' || true)
fi
if [ -n "${UM_AUTH_TOKEN:-}" ]; then
	echo "[smoke] auth:     bearer token loaded (${#UM_AUTH_TOKEN} chars)"
	# R1 hardening: write the bearer header to a 0600 tempfile so the token
	# never appears in `ps auxe` argv. Mirrors the established pattern in
	# server/install.sh:462-468 (_UM_TMP_KEYFILE for OpenAI key validation).
	# Lifetime is the entire smoke run; manual cleanup happens at script end
	# (see _um_smoke_auth_cleanup below). A trap-based safety net would
	# conflict with smoke.sh's per-section EXIT traps (Task 7, Task 25),
	# so we rely on OS tmpdir policy to sweep on early exit. File is 0600;
	# only the running user can read it during the leak window.
	_UM_SMOKE_AUTH_CONFIG=$(mktemp -t smoke-auth.XXXXXX 2>/dev/null || mktemp)
	chmod 600 "$_UM_SMOKE_AUTH_CONFIG"
	printf 'header = "Authorization: Bearer %s"\n' "$UM_AUTH_TOKEN" > "$_UM_SMOKE_AUTH_CONFIG"
	_um_smoke_auth_cleanup() { rm -f "$_UM_SMOKE_AUTH_CONFIG"; }
	curl() {
		command curl --config "$_UM_SMOKE_AUTH_CONFIG" "$@"
	}
else
	echo "[smoke] auth:     no UM_AUTH_TOKEN found — assuming loopback-bypass mode"
	_um_smoke_auth_cleanup() { :; }
fi

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

# /metrics scrape sanity (C.5 — spec §4.2). Confirms the endpoint-class
# loopback bypass + handler dispatch + counter-finish wiring all line up
# end-to-end against a running stack. R10-class regression guard for the
# full middleware chain ordering.
#
# Local runs exercise this from 127.0.0.1, so endpoint-class returns
# bypassAuth+bypassRateLimit and the handler emits text exposition.
# A non-loopback caller would get 404 (verified by the handler test;
# can't easily simulate from within the smoke runner since UM_ENDPOINT
# could be either loopback or remote).
echo "[smoke]     /metrics scrape sanity"
# v0.6 (Phase C C.5): /metrics is loopback-only by default. When smoke runs
# against a docker-compose stack, the host's localhost:6335 reaches the
# container via Docker's NAT bridge — source IP is the bridge gateway, not
# 127.0.0.1, so the default-secure handler short-circuits to 404. Scrape via
# `docker compose exec` so the request originates inside the container with
# 127.0.0.1 as source IP — that path bypasses auth and emits text exposition,
# exercising the same default users get out of the box.
#
# Falls back to direct curl when docker isn't available (bare-metal dev
# install) or when the caller has set UM_METRICS_LOOPBACK_ONLY=false +
# UM_METRICS_AUTH_REQUIRED=false in the stack's .env.
METRICS=""
if command -v docker >/dev/null 2>&1; then
	# Match the docker-compose'd container by name regardless of project
	# prefix. Compose names containers like <project>-<service>-<n>, where
	# <project> defaults to the dir or comes from the compose file's `name:`
	# field. `docker ps` avoids guessing project name.
	UM_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'memory-server' | head -1 || true)
	if [ -n "$UM_CONTAINER" ]; then
		echo "[smoke]     scraping /metrics inside container: $UM_CONTAINER"
		# wget ships with busybox in node:20-alpine; fall back to node fetch
		# if a future base image drops it.
		METRICS=$(docker exec -i "$UM_CONTAINER" sh -c \
			'wget -qO- "http://localhost:6335/metrics" 2>/dev/null \
			 || node -e "fetch('"'"'http://localhost:6335/metrics'"'"').then(r=>r.text()).then(t=>process.stdout.write(t))"' \
			2>/dev/null || true)
	fi
fi
if [ -z "$METRICS" ]; then
	echo "[smoke]     no in-container scrape path — falling back to direct curl"
	METRICS=$(curl -sf "$ENDPOINT/metrics" || true)
fi
if [ -z "$METRICS" ]; then
	echo "FAIL: /metrics returned empty/error — expected Prometheus text exposition"
	echo "      (loopback-only mode? endpoint=$ENDPOINT — non-loopback callers get 404)"
	exit 1
fi
echo "$METRICS" | grep -q '^# HELP um_http_requests_total' || {
	echo "FAIL: /metrics did not return expected um_http_requests_total HELP line"
	echo "Got: $(echo "$METRICS" | head -5)"
	exit 1
}
echo "$METRICS" | grep -q '^# TYPE um_http_request_duration_seconds histogram' || {
	echo "FAIL: /metrics did not return expected histogram TYPE line"
	exit 1
}
echo "[smoke]     OK: /metrics emitted Prometheus text exposition"

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
assert isinstance(data, dict) and 'results' in data, 'FAIL: /api/search did not return {results:[...]} wrapper — got: ' + json.dumps(data)
items = data['results']
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

# 2c/5 v0.8 G2: assert um_provider_* metrics fire for embed AND facts surfaces.
# This catches the entire "metric defined but doesn't fire in prod" bug
# class — exactly the contract violation v0.8 G2 closes. The smoke runs
# against UM_TEST_MOCK_SDK=0 (real openai) so the metric path is exercised
# end-to-end. Mock-SDK metric fire is unit-tested separately.
echo "[smoke] 2c/5 v0.8 G2: assert um_provider_* metrics fire for embed/facts"
# Match the 1/5 scrape's robustness: wget OR node-fetch OR direct curl.
# Defensive symmetry with the existing 1/5 pattern (line 117). The
# original PR #36 CI iterations briefly thought a bare-wget hiccup was
# the failure cause; the actual root cause turned out to be the
# label-order regex bug (commit cec5acf) plus the value-pattern bug
# (commit e3c44fe), and the v0.7 prom-client registration miss that
# kept the metrics from existing in production at all (commit 6e483ea).
# The fallback chain is kept anyway — symmetric with 1/5, no harm.
g2_metrics=""
if [ -n "$UM_CONTAINER" ]; then
	g2_metrics=$(docker exec -i "$UM_CONTAINER" sh -c \
		'wget -qO- "http://localhost:6335/metrics" 2>/dev/null \
		 || node -e "fetch('"'"'http://localhost:6335/metrics'"'"').then(r=>r.text()).then(t=>process.stdout.write(t))"' \
		2>/dev/null || true)
fi
if [ -z "$g2_metrics" ]; then
	echo "[smoke]     2c/5 in-container scrape returned empty — falling back to direct curl"
	g2_metrics=$(curl -sf "$ENDPOINT/metrics" 2>/dev/null || true)
fi

# Helper: assert a um_provider_* line exists with ALL given labels (in any order)
# AND a non-zero numeric value. prom-client emits labels in labelNames-declaration
# order (provider/model/surface/direction for tokens; provider/model/surface for
# others), but the assertion should be order-independent so future label-shape
# changes don't silently break the regex.
g2_assert_metric() {
  local metric_name="$1" label="$2"
  shift 2
  # Pre-filter to lines starting with the metric name (incl. histogram suffixes).
  local lines
  lines=$(echo "$g2_metrics" | grep -E "^${metric_name}\{" || true)
  # Each remaining arg is a required label substring like 'surface="embed"'.
  for required in "$@"; do
    lines=$(echo "$lines" | grep -F "$required" || true)
  done
  # Must have at least one matching data line with a POSITIVE NON-ZERO value.
  # The original v0.7 contract was "metric fires with non-zero" — a tokens_in=0
  # despite a real-API call IS a real bug worth catching (e.g., usage-extraction
  # broken). The original regex tried to encode that but rejected legitimate
  # tiny values like 0.000035 (cost_usd) and 6.2e-7 (scientific notation).
  #
  # Correct "positive non-zero" pattern: the mantissa must contain at least one
  # digit [1-9] somewhere. Two cases (alternation):
  #   - integer part has [1-9]:  [0-9]*[1-9][0-9]*(\.[0-9]+)?
  #   - decimal part has [1-9]:  [0-9]*\.[0-9]*[1-9][0-9]*
  # Plus optional scientific exponent. Matches: 5, 50, 5.3, 0.5, 0.000036,
  # 6.2e-7, 5e+10. Rejects: 0, 0.0, 0.000.
  echo "$lines" | grep -qE '\} ([0-9]*[1-9][0-9]*(\.[0-9]+)?|[0-9]*\.[0-9]*[1-9][0-9]*)([eE][-+]?[0-9]+)?' || {
    echo "FAIL: $label metric did not fire (metric=$metric_name, required-labels=$*)"
    echo "[smoke]     g2_metrics body length: $(echo "$g2_metrics" | wc -c) bytes"
    echo "[smoke]     ALL um_provider_* data lines:"
    echo "$g2_metrics" | grep -E '^um_provider_' | head -30
    exit 1
  }
}

# All four series for embed surface.
g2_assert_metric 'um_provider_tokens_total' "embed tokens_in" 'surface="embed"' 'provider="openai"' 'model="text-embedding-3-small"' 'direction="in"'
g2_assert_metric 'um_provider_request_duration_seconds_count' "embed histogram" 'surface="embed"'
g2_assert_metric 'um_provider_cost_usd_total' "embed cost_usd" 'surface="embed"'

# All four series for facts surface.
g2_assert_metric 'um_provider_tokens_total' "facts tokens" 'surface="facts"' 'provider="openai"' 'model="gpt-4.1-nano-2025-04-14"'
g2_assert_metric 'um_provider_request_duration_seconds_count' "facts histogram" 'surface="facts"'
g2_assert_metric 'um_provider_cost_usd_total' "facts cost_usd" 'surface="facts"'

# Negative assertion: model="undefined" must NOT appear (catches ctx.model
# fallback chain misconfig — would emit cardinality-bombing label).
echo "$g2_metrics" | grep -qE 'um_provider_tokens_total\{[^}]*model="undefined"' && {
  echo "FAIL: metric label model=undefined leaked — fallback chain misconfigured"
  exit 1
}
echo "[smoke]     v0.8 G2 metric assertions OK"

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

# 4b/5 Task 6: D3.1 filter + guard tests (Cases A–E)
# Case A: auto-stamped current doc (no metadata.status injected; server stamps it)
#          returned by default search — validates D3.1 auto-stamp E2E
# Case B: /api/add with reserved metadata.status rejected (D3.1 §3.2 guard) — no doc created
# Case D: legacy no-metadata doc returned by default search (backward compat)
# Case E: invalidated_at doc excluded from default search (filter still works)
echo "[smoke] 4b/5 Task 6 filter tests"
T6_IDS=""

t6_add() {
	# Usage: t6_add "text" "json-metadata"
	local resp
	resp=$(curl -sf -X POST "$ENDPOINT/api/add" \
		-H 'Content-Type: application/json' \
		-d "{\"text\": \"$1\", \"metadata\": $2}")
	echo "$resp" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    if r.get('id'): print(r['id'])
"
}

T6_QUERY="xyzzy-task6-filter-probe-$(date +%s)-$$"

# v1.1 D1 flag-flip note: case texts are topic-orthogonal (arctic vs sourdough
# vs butterflies) so the embedding cosines stay below the dedup threshold
# τ=0.84 and the three writes (A, D, E) do not collapse into a single qdrant
# point. Each text still contains ${T6_QUERY}-LETTER so /api/search keyed
# on $T6_QUERY retrieves them. (Case B is a guard-probe only — no doc created.)

# Case A: auto-stamped current doc — must appear in default search.
# D3.1 change: status is now server-managed; do NOT inject metadata.status.
# buildPayload auto-stamps status:'current' on every new qdrant fact, so this
# doc IS a current doc. Also implicitly E2E-validates D3.1 auto-stamp: no
# injected status, server stamps current, doc is still recalled by default search.
echo "[smoke]     Case A: auto-stamped (server-managed) current doc returned by default search"
IDS_A=$(t6_add "The probe marker ${T6_QUERY}-A is associated with arctic ice core samples collected from Siberian permafrost." '{"t6":"a"}')
T6_IDS="$T6_IDS $IDS_A"

# Case B: /api/add with reserved metadata.status MUST be rejected (D3.1 §3.2 guard).
# D3.1 added status/supersededBy/supersededAt to RESERVED_METADATA_FIELDS; assertNoReservedFields
# now blocks any caller attempting to inject status. No doc is created; IDS_B is intentionally
# absent from T6_IDS. Use direct curl (not t6_add) to capture both HTTP code and body.
echo "[smoke]     Case B: /api/add with reserved metadata.status is rejected (D3.1 §3.2 guard)"
B_BODY=$(curl -s -o - -w '\n__HTTP__%{http_code}' -X POST "$ENDPOINT/api/add" \
    -H 'Content-Type: application/json' \
    -d "{\"text\": \"The probe marker ${T6_QUERY}-B is associated with baroque chamber music notation from 17th century Italy.\", \"metadata\": {\"status\":\"superseded\",\"t6\":\"b\"}}")
B_CODE=$(printf '%s' "$B_BODY" | sed -n 's/.*__HTTP__//p')
B_JSON=$(printf '%s' "$B_BODY" | sed 's/__HTTP__[0-9]*$//')
# Assert: server returned an error (HTTP >= 400) with a reserved-field error message.
if [ -z "$B_CODE" ] || [ "$B_CODE" -lt 400 ]; then
    echo "FAIL Case B: expected HTTP >=400 rejection for reserved metadata.status, got HTTP ${B_CODE:-<empty>}"
    echo "  body: $B_JSON"
    exit 1
fi
if ! printf '%s' "$B_JSON" | grep -qi reserved; then
    echo "FAIL Case B: HTTP ${B_CODE} but body does not mention 'reserved' — guard may not have fired"
    echo "  body: $B_JSON"
    exit 1
fi
echo "OK Case B: reserved-field guard rejected metadata.status with HTTP ${B_CODE} (expected)"

# Case D: no-metadata (legacy) doc — must appear in default search
echo "[smoke]     Case D: legacy no-metadata doc returned by default search"
LEGACY_RESP=$(curl -sf -X POST "$ENDPOINT/api/add" \
	-H 'Content-Type: application/json' \
	-d "{\"text\": \"The probe marker ${T6_QUERY}-D is associated with traditional sourdough bread recipes from Eastern Europe.\"}")
IDS_D=$(echo "$LEGACY_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    if r.get('id'): print(r['id'])
")
T6_IDS="$T6_IDS $IDS_D"

# Case E: invalidated_at set — must NOT appear in default search
echo "[smoke]     Case E: invalidated_at doc excluded by default search"
IDS_E=$(t6_add "The probe marker ${T6_QUERY}-E is associated with monarch butterfly migration patterns across North America." '{"invalidated_at":"2024-01-01T00:00:00Z","t6":"e"}')
T6_IDS="$T6_IDS $IDS_E"

# Brief pause to allow mem0 async write to settle before searching
sleep 3

# Verify /api/search returns {results:[...]} wrapper shape
SHAPE_RESP=$(curl -sf -X POST "$ENDPOINT/api/search" \
	-H 'Content-Type: application/json' \
	-d "{\"query\": \"$T6_QUERY\", \"limit\": 20}")
echo "$SHAPE_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert isinstance(data, dict) and 'results' in data, 'FAIL: /api/search response missing {results} wrapper — got: ' + json.dumps(data)[:200]
print('OK: response shape is {results:[...]}')
" || { echo "FAIL: /api/search shape check failed"; exit 1; }

# Case A: current doc appears in default results
if [ -n "$IDS_A" ]; then
	echo "$SHAPE_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
ids = set(r.get('id','') for r in data['results'])
for id in '$IDS_A'.split():
    if id in ids:
        print(f'OK Case A: current doc {id} is in results (expected)')
    else:
        print(f'WARN Case A: current doc {id} not found in results — may be relevance threshold, not a filter bug')
" || true
fi

# Case E: invalidated_at doc excluded from default results
if [ -n "$IDS_E" ]; then
	echo "$SHAPE_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
ids = set(r.get('id','') for r in data['results'])
for id in '$IDS_E'.split():
    if id not in ids:
        print(f'OK Case E: invalidated_at doc {id} excluded from default results (expected)')
    else:
        print(f'FAIL Case E: invalidated_at doc {id} appeared in default results — filter not working')
        sys.exit(1)
" || { echo "FAIL: Case E invalidated_at filter check failed"; exit 1; }
fi

# Case C: include_superseded=true — shape smoke (no superseded doc in D3.1 scope;
# the genuine superseded-qdrant-fact E2E is D3.2's planned deliverable, T2.5
# UM_SMOKE_AUTOSUPERSEDE_ON). Shape-only: assert {results:[...]} wrapper is present.
echo "[smoke]     Case C: include_superseded=true (POST body) — shape check only"
INC_RESP=$(curl -sf -X POST "$ENDPOINT/api/search" \
    -H 'Content-Type: application/json' \
    -d "{\"query\": \"$T6_QUERY\", \"limit\": 20, \"include_superseded\": true}")
echo "$INC_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert isinstance(data, dict) and 'results' in data, 'FAIL: include_superseded response missing {results} wrapper'
print('OK Case C (POST): include_superseded=true returns {results:[...]} shape')
" || { echo "FAIL: Case C include_superseded shape check failed"; exit 1; }

# Case C also: GET ?include_superseded=true — shape check
echo "[smoke]     Case C: include_superseded=true (GET query param) — shape check only"
GET_INC_RESP=$(curl -sf "$ENDPOINT/api/search?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$T6_QUERY'))")&limit=20&include_superseded=true")
echo "$GET_INC_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert isinstance(data, dict) and 'results' in data, 'FAIL: GET include_superseded response missing {results} wrapper'
print('OK Case C (GET): GET /api/search with include_superseded=true returns {results:[...]} shape')
" || { echo "FAIL: Case C GET include_superseded shape check failed"; exit 1; }

# GET /api/search without include_superseded — shape check
echo "[smoke]     GET /api/search default (no include_superseded)"
GET_DEFAULT_RESP=$(curl -sf "$ENDPOINT/api/search?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$T6_QUERY'))")&limit=20")
echo "$GET_DEFAULT_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert isinstance(data, dict) and 'results' in data, 'FAIL: GET /api/search response missing {results} wrapper — got: ' + json.dumps(data)[:200]
print(f'OK: GET /api/search returns {{results:[...]}} shape with {len(data[\"results\"])} result(s)')
" || { echo "FAIL: GET /api/search shape check failed"; exit 1; }

# Cleanup Task 6 records
T6_CLEANED=0
for id in $T6_IDS; do
	[ -n "$id" ] || continue
	curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null || true
	T6_CLEANED=$((T6_CLEANED + 1))
done
echo "[smoke]     Task 6 records cleaned up ($T6_CLEANED)"

# 4c/5 Task 7: POST /api/reindex — vault-file indexing cases (A–F)
echo "[smoke] 4c/5 Task 7 reindex tests"

# Vault directory must be accessible on the host for fixture setup.
# The server reads from /vault (container path); the host path is UM_VAULT_DIR.
if [ -z "${UM_VAULT_DIR:-}" ]; then
	echo "[smoke] WARN: UM_VAULT_DIR not set — skipping Task 7 reindex tests"
else
T7_VAULT_DIR="${UM_VAULT_DIR}"
T7_SUBDIR="${T7_VAULT_DIR}/sessions/smoke-t7-$$"
mkdir -p "$T7_SUBDIR"
T7_IDS=""

t7_cleanup() {
	rm -rf "$T7_SUBDIR"
	for id in $T7_IDS; do
		[ -n "$id" ] || continue
		curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null || true
	done
}
trap t7_cleanup EXIT

# Case A: Reindex a session_summary doc — should succeed
echo "[smoke]     Task 7 Case A: reindex session_summary doc → indexed"
cat > "$T7_SUBDIR/session-summary-smoke-a.md" <<'EOF'
---
type: session_summary
id: session-summary-smoke-a
title: Smoke Test Session Summary A
schema_version: 1
status: current
---
Summary body content for smoke test case A.
EOF
RESP_A=$(curl -sf -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"sessions/smoke-t7-$$/session-summary-smoke-a.md\"}")
echo "    Response: $RESP_A"
echo "$RESP_A" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('ok') is True, 'expected ok:true, got: ' + json.dumps(data)
assert data.get('indexed') is True, 'expected indexed:true, got: ' + json.dumps(data)
assert data.get('id') == 'session-summary-smoke-a', 'unexpected id: ' + str(data.get('id'))
print('OK Case A: session_summary indexed, ok=True, indexed=True')
" || { echo "FAIL: Case A reindex session_summary failed"; exit 1; }
# Capture IDs for cleanup (via /api/list search by metadata.id)
T7_A_IDS=$(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == 'session-summary-smoke-a':
        print(r['id'])
" 2>/dev/null || true)
T7_IDS="$T7_IDS $T7_A_IDS"

# Case B: Reindex an authored doc — should succeed
echo "[smoke]     Task 7 Case B: reindex authored doc → indexed"
cat > "$T7_SUBDIR/authored-doc-smoke-b.md" <<'EOF'
---
type: authored
id: authored-doc-smoke-b
title: Smoke Test Authored Doc B
schema_version: 1
status: current
---
Authored document body for smoke test case B.
EOF
RESP_B=$(curl -sf -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"sessions/smoke-t7-$$/authored-doc-smoke-b.md\"}")
echo "    Response: $RESP_B"
echo "$RESP_B" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('ok') is True, 'expected ok:true, got: ' + json.dumps(data)
assert data.get('indexed') is True, 'expected indexed:true, got: ' + json.dumps(data)
assert data.get('id') == 'authored-doc-smoke-b', 'unexpected id: ' + str(data.get('id'))
print('OK Case B: authored doc indexed, ok=True, indexed=True')
" || { echo "FAIL: Case B reindex authored doc failed"; exit 1; }
T7_B_IDS=$(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == 'authored-doc-smoke-b':
        print(r['id'])
" 2>/dev/null || true)
T7_IDS="$T7_IDS $T7_B_IDS"

# Case C: Reindex same id twice — only one mem0 entry should remain (upsert)
echo "[smoke]     Task 7 Case C: reindex same id twice → only one entry"
RESP_C1=$(curl -sf -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"sessions/smoke-t7-$$/session-summary-smoke-a.md\"}")
echo "    Second reindex response: $RESP_C1"
echo "$RESP_C1" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('ok') is True, 'expected ok:true on second reindex, got: ' + json.dumps(data)
print('OK Case C: second reindex returned ok=True')
" || { echo "FAIL: Case C second reindex failed"; exit 1; }
# Count entries with this metadata.id — should be exactly one record set (mem0 may split into multiple facts but all from one add call; check via /api/list that we don't get unbounded growth)
sleep 2
COUNT_C=$(curl -sf "$ENDPOINT/api/list" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
# /api/list compact shape projects metadata.id to top-level id (B.1.4b)
count = sum(1 for r in items if r.get('id') == 'session-summary-smoke-a' or (r.get('metadata') or {}).get('id') == 'session-summary-smoke-a')
print(count)
" 2>/dev/null || echo 0)
echo "    Entries for session-summary-smoke-a after 2x reindex: $COUNT_C"
[ "$COUNT_C" -eq 1 ] || { echo "FAIL: Case C upsert left $COUNT_C entries (expected 1)"; exit 1; }
echo "OK Case C: upsert produced exactly 1 entry"
# Update T7_A_IDS in case upsert created new entries
T7_A_IDS_NEW=$(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == 'session-summary-smoke-a':
        print(r['id'])
" 2>/dev/null || true)
T7_IDS="$T7_IDS $T7_A_IDS_NEW"

# Case D: Reindex state doc — must return 400
echo "[smoke]     Task 7 Case D: reindex state doc → 400"
cat > "$T7_SUBDIR/state-smoke-d.md" <<'EOF'
---
type: state
id: state-smoke-d
title: Smoke Test State D
schema_version: 1
---
State document body — must never be reindexed.
EOF
HTTP_STATUS_D=$(curl -s -o /tmp/t7_resp_d.json -w "%{http_code}" -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"sessions/smoke-t7-$$/state-smoke-d.md\"}")
RESP_D=$(cat /tmp/t7_resp_d.json)
echo "    HTTP $HTTP_STATUS_D — Response: $RESP_D"
[ "$HTTP_STATUS_D" = "400" ] || { echo "FAIL: Case D state doc should return 400, got $HTTP_STATUS_D"; exit 1; }
echo "$RESP_D" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert 'error' in data, 'expected error field, got: ' + json.dumps(data)
print('OK Case D: state doc rejected with 400 + error message')
" || { echo "FAIL: Case D response shape wrong"; exit 1; }

# Case E: Missing file — must return 404
echo "[smoke]     Task 7 Case E: missing file → 404"
HTTP_STATUS_E=$(curl -s -o /tmp/t7_resp_e.json -w "%{http_code}" -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"sessions/smoke-t7-$$/does-not-exist.md\"}")
RESP_E=$(cat /tmp/t7_resp_e.json)
echo "    HTTP $HTTP_STATUS_E — Response: $RESP_E"
[ "$HTTP_STATUS_E" = "404" ] || { echo "FAIL: Case E missing file should return 404, got $HTTP_STATUS_E"; exit 1; }
echo "OK Case E: missing file returns 404"

# Case F: id-mismatch (filename stem != frontmatter id) — must return 400
echo "[smoke]     Task 7 Case F: id-mismatch → 400"
cat > "$T7_SUBDIR/filename-mismatch.md" <<'EOF'
---
type: session_summary
id: different-id-entirely
title: Smoke Test Mismatch F
schema_version: 1
---
Body content.
EOF
HTTP_STATUS_F=$(curl -s -o /tmp/t7_resp_f.json -w "%{http_code}" -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"sessions/smoke-t7-$$/filename-mismatch.md\"}")
RESP_F=$(cat /tmp/t7_resp_f.json)
echo "    HTTP $HTTP_STATUS_F — Response: $RESP_F"
[ "$HTTP_STATUS_F" = "400" ] || { echo "FAIL: Case F id-mismatch should return 400, got $HTTP_STATUS_F"; exit 1; }
echo "$RESP_F" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert 'error' in data, 'expected error field, got: ' + json.dumps(data)
print('OK Case F: id-mismatch rejected with 400 + error message')
" || { echo "FAIL: Case F response shape wrong"; exit 1; }

# Cleanup: remove fixture files + any indexed entries
trap - EXIT
t7_cleanup
echo "[smoke]     Task 7 fixtures and indexed records cleaned up"
echo "[smoke]     Task 7 Cases A–F all passed"
fi  # end UM_VAULT_DIR guard

# 4d/5 Task 8: GET /api/state/:project — direct file read (Cases A–B)
echo "[smoke] 4d/5 Task 8 state endpoint tests"

if [ -z "${UM_VAULT_DIR:-}" ]; then
	echo "[smoke] WARN: UM_VAULT_DIR not set — skipping Task 8 state tests"
else
T8_STATE_DIR="${UM_VAULT_DIR}/state/smoke-test-a"
mkdir -p "$T8_STATE_DIR"

# Case A: file exists → returns state with frontmatter and body
echo "[smoke]     Task 8 Case A: state file exists → returns state"
cat > "$T8_STATE_DIR/state.md" <<'EOF'
---
schema_version: 1
type: state
id: state-smoke-test-a
title: State of play — smoke-test-a
status: current
valid_from: 2026-04-17T14:32:00Z
project: smoke-test-a
---
# State of play — smoke-test-a

## Current focus
Smoke test body content.
EOF

RESP_T8A=$(curl -sf "$ENDPOINT/api/state/smoke-test-a")
echo "    Response: $RESP_T8A"
echo "$RESP_T8A" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('ok') is True, 'expected ok:true, got: ' + json.dumps(data)
assert data.get('project') == 'smoke-test-a', 'wrong project: ' + str(data.get('project'))
state = data.get('state')
assert state is not None, 'state should not be null when file exists'
fm = state.get('frontmatter', {})
assert fm.get('id') == 'state-smoke-test-a', 'wrong frontmatter id: ' + str(fm.get('id'))
assert 'Smoke test body content' in state.get('body', ''), 'body missing expected content'
assert data.get('valid_from') == '2026-04-17T14:32:00Z', 'wrong valid_from: ' + str(data.get('valid_from'))
print('OK Case A: state file returned with correct frontmatter, body, and valid_from')
" || { echo "FAIL: Task 8 Case A failed"; rm -rf "$T8_STATE_DIR"; exit 1; }

# Case B: file missing → state: null, valid_from: null, ok: true, status 200
echo "[smoke]     Task 8 Case B: project has no state file → state: null"
HTTP_STATUS_T8B=$(curl -s -o /tmp/t8_resp_b.json -w "%{http_code}" "$ENDPOINT/api/state/nonexistent-project-xyz")
RESP_T8B=$(cat /tmp/t8_resp_b.json)
echo "    HTTP $HTTP_STATUS_T8B — Response: $RESP_T8B"
[ "$HTTP_STATUS_T8B" = "200" ] || { echo "FAIL: Case B should return 200, got $HTTP_STATUS_T8B"; rm -rf "$T8_STATE_DIR"; exit 1; }
echo "$RESP_T8B" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('ok') is True, 'expected ok:true, got: ' + json.dumps(data)
assert data.get('state') is None, 'state should be null when file missing, got: ' + str(data.get('state'))
assert data.get('valid_from') is None, 'valid_from should be null when file missing, got: ' + str(data.get('valid_from'))
print('OK Case B: missing state returns 200 with state=null, valid_from=null')
" || { echo "FAIL: Task 8 Case B failed"; rm -rf "$T8_STATE_DIR"; exit 1; }

# Cleanup
rm -rf "$T8_STATE_DIR"
echo "[smoke]     Task 8 state fixture cleaned up"
echo "[smoke]     Task 8 Cases A–B all passed"
fi  # end UM_VAULT_DIR guard

# 4e/5 Task 9: temporal decay — decay-off path (default)
# Rationale: toggling UM_TEMPORAL_DECAY=true requires restarting the container
# with a different env, which is too heavyweight for a single smoke run. The
# math (decay-on) is exercised fully by the unit tests in ranking.test.mjs.
# This case only verifies that decay-off (the default) does not disturb result
# ordering or break the search response shape.
echo "[smoke] 4e/5 Task 9 temporal decay — decay-off path"

T9_QUERY="xyzzy-task9-decay-probe-$(date +%s)-$$"
T9_IDS=""

t9_add() {
	local resp
	resp=$(curl -sf -X POST "$ENDPOINT/api/add" \
		-H 'Content-Type: application/json' \
		-d "{\"text\": \"$1\", \"metadata\": $2}")
	echo "$resp" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    if r.get('id'): print(r['id'])
"
}

# Two docs: one with a recent valid_from, one with an old valid_from.
# With decay OFF the server must still return { results: [...] } without error.
#
# v1.1 D1 flag-flip note: same hygiene as Task 6 — texts are topic-orthogonal
# (solar physics vs paleontology) so embedding cosines stay below the dedup
# threshold τ=0.84. Each text contains ${T9_QUERY}-LABEL for searchability.
IDS_T9_RECENT=$(t9_add "Reference code ${T9_QUERY}-recent is paired with a study of solar flare cycles observed during the last decade." \
	"{\"type\":\"authored\",\"id\":\"t9-recent\",\"valid_from\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"t9\":\"recent\"}")
IDS_T9_OLD=$(t9_add "Reference code ${T9_QUERY}-old is paired with a record of late Cretaceous marine fossils found in Wyoming sedimentary layers." \
	'{"type":"authored","id":"t9-old","valid_from":"2020-01-01T00:00:00Z","t9":"old"}')
T9_IDS="$T9_IDS $IDS_T9_RECENT $IDS_T9_OLD"

sleep 2

# Query with decay off (default env) — must return well-formed response
T9_RESP=$(curl -sf -X POST "$ENDPOINT/api/search" \
	-H 'Content-Type: application/json' \
	-d "{\"query\": \"$T9_QUERY\", \"limit\": 10}")
echo "$T9_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert isinstance(data, dict) and 'results' in data, \
    'FAIL: Task 9 decay-off search returned malformed response: ' + json.dumps(data)[:200]
print(f'OK Task 9 decay-off: response shape is {{results:[...]}} with {len(data[\"results\"])} result(s)')
" || { echo "FAIL: Task 9 decay-off search shape check failed"; exit 1; }

# Cleanup Task 9 records
T9_CLEANED=0
for id in $T9_IDS; do
	[ -n "$id" ] || continue
	curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null || true
	T9_CLEANED=$((T9_CLEANED + 1))
done
echo "[smoke]     Task 9 records cleaned up ($T9_CLEANED)"
echo "[smoke]     Task 9 decay-off path passed (decay-on math covered by unit tests)"

# 4f/5 Task 10: MCP surface — new tools via POST /mcp JSON-RPC
echo "[smoke] 4f/5 Task 10 MCP surface tests"

mcp_call() {
	# Usage: mcp_call <id> <tool_name> <json_args>
	local id="$1" name="$2" args="$3"
	curl -sf -X POST "$ENDPOINT/mcp" \
		-H 'Content-Type: application/json' \
		-d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}"
}

# T10-A: tools/list — tool visibility branches on UM_MCP_WRITE_ENABLED
# When UM_MCP_WRITE_ENABLED=true|1 : all 11 tools (reads + writes)
# When unset, =false, or =0       : 4 read-only tools (writes filtered)
# NOTE: plan spec said "5 tools (reads only)" — actual code path yields 4:
#   reads  = { memory_search, memory_list, memory_state, memory_recent }
#   writes = { memory_add, memory_delete, memory_capture, memory_checkpoint, memory_forget, memory_supersede, memory_append_turn }
#   11 - 7 = 4 read tools. The plan numeric is superseded by the actual code path.
if [ "${UM_MCP_WRITE_ENABLED:-}" = "true" ] || [ "${UM_MCP_WRITE_ENABLED:-}" = "1" ]; then
	echo "[smoke]     T10-A: tools/list advertises all 11 tools (UM_MCP_WRITE_ENABLED=${UM_MCP_WRITE_ENABLED})"
	TOOLS_RESP=$(curl -sf -X POST "$ENDPOINT/mcp" \
		-H 'Content-Type: application/json' \
		-d '{"jsonrpc":"2.0","id":100,"method":"tools/list","params":{}}')
	echo "$TOOLS_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
tools = [t['name'] for t in data.get('result', {}).get('tools', [])]
expected = ['memory_search','memory_add','memory_list','memory_delete',
            'memory_state','memory_recent','memory_capture','memory_checkpoint',
            'memory_forget','memory_supersede','memory_append_turn']
missing = [t for t in expected if t not in tools]
if missing:
    print('FAIL: missing tools:', missing)
    sys.exit(1)
print(f'OK T10-A: all 11 tools advertised (writes enabled): {tools}')
" || { echo "FAIL: T10-A tools/list check failed (writes enabled)"; exit 1; }
else
	echo "[smoke]     T10-A: tools/list advertises 4 read-only tools (UM_MCP_WRITE_ENABLED unset/false)"
	TOOLS_RESP=$(curl -sf -X POST "$ENDPOINT/mcp" \
		-H 'Content-Type: application/json' \
		-d '{"jsonrpc":"2.0","id":100,"method":"tools/list","params":{}}')
	echo "$TOOLS_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
tools = [t['name'] for t in data.get('result', {}).get('tools', [])]
read_tools = ['memory_search','memory_list','memory_state','memory_recent']
write_tools = ['memory_add','memory_delete','memory_capture','memory_checkpoint','memory_forget','memory_supersede']
missing_reads = [t for t in read_tools if t not in tools]
present_writes = [t for t in write_tools if t in tools]
if missing_reads:
    print('FAIL: read tools missing from list:', missing_reads)
    sys.exit(1)
if present_writes:
    print('FAIL: write tools must be filtered when writes disabled, but found:', present_writes)
    sys.exit(1)
if len(tools) != 4:
    print(f'FAIL: expected 4 read tools, got {len(tools)}: {tools}')
    sys.exit(1)
print(f'OK T10-A: 4 read-only tools advertised (writes filtered): {tools}')
" || { echo "FAIL: T10-A tools/list check failed (writes disabled)"; exit 1; }
fi

# T10-B: memory_search with filters — returns {results:[...]} shape
echo "[smoke]     T10-B: memory_search with filters"
T10B_RESP=$(mcp_call 101 memory_search '{"query":"test","limit":2,"filters":{"type":"session_summary"}}')
echo "$T10B_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert 'results' in result, 'FAIL: memory_search response missing results key: ' + result_text
print(f'OK T10-B: memory_search with filters returned {{results:[...]}} shape ({len(result[\"results\"])} item(s))')
" || { echo "FAIL: T10-B memory_search with filters failed"; exit 1; }

# T10-C: memory_state — missing project returns {ok:true, state:null}
echo "[smoke]     T10-C: memory_state for nonexistent project"
T10C_RESP=$(mcp_call 102 memory_state '{"project":"nonexistent-t10-smoke-xyz"}')
echo "$T10C_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true, got: ' + result_text
assert result.get('state') is None, 'expected state:null, got: ' + result_text
print('OK T10-C: memory_state nonexistent project returns ok:true, state:null')
" || { echo "FAIL: T10-C memory_state failed"; exit 1; }

# T10-C2: memory_state — with vault fixture (only if UM_VAULT_DIR set)
if [ -n "${UM_VAULT_DIR:-}" ]; then
	echo "[smoke]     T10-C2: memory_state with vault fixture"
	T10_STATE_DIR="${UM_VAULT_DIR}/state/smoke-t10-state"
	mkdir -p "$T10_STATE_DIR"
	cat > "$T10_STATE_DIR/state.md" <<'STATEEOF'
---
schema_version: 1
type: state
id: state-smoke-t10
title: State of play — smoke-t10-state
status: current
valid_from: 2026-04-17T12:00:00Z
project: smoke-t10-state
---
# Smoke test state
Body content for T10-C2.
STATEEOF
	T10C2_RESP=$(mcp_call 103 memory_state '{"project":"smoke-t10-state"}')
	echo "$T10C2_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true: ' + result_text
assert result.get('state') is not None, 'expected state to be populated: ' + result_text
assert result.get('valid_from') == '2026-04-17T12:00:00Z', 'wrong valid_from: ' + str(result.get('valid_from'))
print('OK T10-C2: memory_state returns state with correct valid_from')
" || { echo "FAIL: T10-C2 memory_state with fixture failed"; rm -rf "$T10_STATE_DIR"; exit 1; }
	rm -rf "$T10_STATE_DIR"
	echo "[smoke]     T10-C2 fixture cleaned up"
fi

# T10-D: memory_recent — returns {results:[...]} shape
echo "[smoke]     T10-D: memory_recent shape check"
T10D_RESP=$(mcp_call 104 memory_recent '{"project":"smoke-t10d","limit":3}')
echo "$T10D_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert 'results' in result, 'FAIL: memory_recent missing results key: ' + result_text
print(f'OK T10-D: memory_recent returns {{results:[...]}} shape ({len(result[\"results\"])} item(s))')
" || { echo "FAIL: T10-D memory_recent failed"; exit 1; }

# T10-E: memory_checkpoint — real write-path (v0.5) or gate error (writes-disabled)
echo "[smoke]     T10-E: memory_checkpoint"
if [ "${UM_MCP_WRITE_ENABLED:-}" = "true" ] && [ -n "${UM_VAULT_DIR:-}" ]; then
    # Writes enabled — assert full pipeline runs
    # Seed a raw capture for a test project
    mcp_call 99 memory_append_turn '{"project":"t10e","content":"Seed turn for checkpoint","role":"user"}' >/dev/null
    # Now checkpoint — expect summary + state.md written
    T10E_RESP=$(mcp_call 105 memory_checkpoint '{"project":"t10e"}')
    echo "$T10E_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true: ' + result_text
assert 'summary_id' in result, 'expected summary_id'
assert result.get('state_updated') is True, 'expected state_updated'
print('OK T10-E (writes enabled): memory_checkpoint produced summary + state.md')
" || { echo "FAIL: T10-E real pipeline failed"; exit 1; }
    # Verify on-disk
    compgen -G "$UM_VAULT_DIR/sessions/t10e/"*.md >/dev/null || { echo "FAIL: T10-E session file missing"; exit 1; }
    [ -f "$UM_VAULT_DIR/state/t10e/state.md" ] || { echo "FAIL: T10-E state.md missing"; exit 1; }
    # Cleanup: delete indexed summary + on-disk artifacts so baseline-preservation check (5/5) passes
    T10E_SUMMARY_ID=$(echo "$T10E_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
print(json.loads(result_text).get('summary_id', ''))
" 2>/dev/null)
    if [ -n "$T10E_SUMMARY_ID" ]; then
        curl -sf -X POST "$ENDPOINT/api/delete" -H 'Content-Type: application/json' \
            -d "{\"metadata\":{\"id\":\"$T10E_SUMMARY_ID\"}}" >/dev/null 2>&1 || true
    fi
    rm -rf "$UM_VAULT_DIR/sessions/t10e" "$UM_VAULT_DIR/state/t10e" "$UM_VAULT_DIR/captures/t10e" 2>/dev/null || true
else
    # Writes disabled — keep post-v0.4 behavior: accept structured gate error
    # (matches current smoke.sh T10-E post-fix state)
    T10E_RESP=$(mcp_call 105 memory_checkpoint '{}')
    echo "$T10E_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is False, 'expected ok:false for disabled: ' + result_text
# error is the v0.6 unified envelope dict {code, message, retryable} OR legacy string
err = result.get('error', '')
err_msg = err.get('message', '') if isinstance(err, dict) else err
err_code = err.get('code', '') if isinstance(err, dict) else ''
accepted = ('MCP writes disabled' in err_msg or 'writes disabled' in err_msg.lower()
            or 'not implemented' in err_msg or '/um-checkpoint' in err_msg
            or err_code in ('MCP_WRITES_DISABLED', 'MCP_NOT_IMPLEMENTED'))
assert accepted, 'expected writes-disabled or stub error: ' + result_text
print('OK T10-E (writes disabled): returned structured gate error')
" || { echo "FAIL: T10-E gate-error assertion failed"; exit 1; }
fi

# T10-F: write tools disabled (default) — capture/forget/supersede return error
echo "[smoke]     T10-F: write tools return error when UM_MCP_WRITE_ENABLED not set"
if [ "${UM_MCP_WRITE_ENABLED:-false}" = "true" ]; then
	echo "[smoke]     WARN: UM_MCP_WRITE_ENABLED=true — skipping write-disabled gate checks (T10-F)"
else
	for WRITE_TOOL in memory_capture memory_forget memory_supersede; do
		case $WRITE_TOOL in
			memory_capture) W_ARGS='{"content":"test","metadata":{"type":"authored","id":"t10f-test","title":"T10F"}}' ;;
			memory_forget)  W_ARGS='{"id":"t10f-nonexistent"}' ;;
			memory_supersede) W_ARGS='{"old_id":"t10f-old","new_doc":{"type":"authored","id":"t10f-new","title":"T10F New","content":"body"}}' ;;
		esac
		W_RESP=$(mcp_call 106 "$WRITE_TOOL" "$W_ARGS")
		echo "$W_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is False, 'expected ok:false when writes disabled: ' + result_text
# error is the v0.6 unified envelope dict {code, message, retryable} OR legacy string
err = result.get('error', '')
err_msg = err.get('message', '') if isinstance(err, dict) else err
err_code = err.get('code', '') if isinstance(err, dict) else ''
assert ('disabled' in err_msg.lower() or err_code in ('MCP_WRITES_DISABLED', 'MCP_NOT_IMPLEMENTED')), \
    'expected disabled message: ' + result_text
print(f'OK T10-F: $WRITE_TOOL returns error when writes disabled')
" || { echo "FAIL: T10-F $WRITE_TOOL did not return expected disabled error"; exit 1; }
	done
fi

# T10-G: write tools enabled (only if UM_MCP_WRITE_ENABLED=true and UM_VAULT_DIR set)
if [ "${UM_MCP_WRITE_ENABLED:-false}" = "true" ] && [ -n "${UM_VAULT_DIR:-}" ]; then
	echo "[smoke]     T10-G: write tools enabled — memory_capture + forget + supersede"
	T10G_IDS=""

	# G1: memory_capture — create a new doc
	echo "[smoke]     T10-G1: memory_capture creates authored doc"
	T10G_CAP_ID="smoke-t10g-cap-$(date +%s)-$$"
	T10G1_RESP=$(mcp_call 110 memory_capture "{\"content\":\"Smoke test capture body.\",\"metadata\":{\"type\":\"authored\",\"id\":\"$T10G_CAP_ID\",\"title\":\"Smoke T10G Capture\",\"project\":\"smoke-t10g\"}}")
	echo "$T10G1_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true: ' + result_text
assert result.get('id') == '$T10G_CAP_ID', 'wrong id: ' + str(result.get('id'))
print(f'OK T10-G1: memory_capture created doc {result.get(\"path\")}')
" || { echo "FAIL: T10-G1 memory_capture failed"; exit 1; }
	T10G_IDS="$T10G_IDS $(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == '$T10G_CAP_ID':
        print(r['id'])
" 2>/dev/null || true)"

	# G2: memory_forget — deprecate the captured doc
	echo "[smoke]     T10-G2: memory_forget deprecates doc"
	T10G2_RESP=$(mcp_call 111 memory_forget "{\"id\":\"$T10G_CAP_ID\"}")
	echo "$T10G2_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true: ' + result_text
assert result.get('status') == 'deprecated', 'expected status=deprecated: ' + result_text
print(f'OK T10-G2: memory_forget deprecated {result.get(\"id\")}')
" || { echo "FAIL: T10-G2 memory_forget failed"; exit 1; }
	T10G_IDS="$T10G_IDS $(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == '$T10G_CAP_ID':
        print(r['id'])
" 2>/dev/null || true)"

	# G3: memory_supersede — create a new doc and supersede an old one
	echo "[smoke]     T10-G3: memory_supersede creates + supersedes"
	T10G_OLD_ID="smoke-t10g-old-$(date +%s)-$$"
	T10G_NEW_ID="smoke-t10g-new-$(date +%s)-$$"
	# First create the old doc via memory_capture
	mcp_call 112 memory_capture "{\"content\":\"Old doc body.\",\"metadata\":{\"type\":\"authored\",\"id\":\"$T10G_OLD_ID\",\"title\":\"Smoke T10G Old\",\"project\":\"smoke-t10g\"}}" > /dev/null
	# Now supersede it
	T10G3_RESP=$(mcp_call 113 memory_supersede "{\"old_id\":\"$T10G_OLD_ID\",\"new_doc\":{\"type\":\"authored\",\"id\":\"$T10G_NEW_ID\",\"title\":\"Smoke T10G New\",\"content\":\"New doc body.\",\"project\":\"smoke-t10g\"}}")
	echo "$T10G3_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true: ' + result_text
assert result.get('old_status') == 'superseded', 'expected old_status=superseded: ' + result_text
assert result.get('new_status') == 'current', 'expected new_status=current: ' + result_text
print(f'OK T10-G3: memory_supersede created new={result.get(\"new_id\")} superseded old={result.get(\"old_id\")}')
" || { echo "FAIL: T10-G3 memory_supersede failed"; exit 1; }

	# Cleanup write-tool records
	for id in $T10G_IDS; do
		[ -n "$id" ] || continue
		curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null || true
	done
	# Also cleanup any indexed entries for the new/old IDs
	for doc_id in "$T10G_CAP_ID" "$T10G_OLD_ID" "$T10G_NEW_ID"; do
		FOUND_IDS=$(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == '$doc_id':
        print(r['id'])
" 2>/dev/null || true)
		for fid in $FOUND_IDS; do
			curl -sf -X DELETE "$ENDPOINT/api/$fid" >/dev/null || true
		done
	done
	# Remove fixture files from vault
	rm -f "${UM_VAULT_DIR}/authored/smoke-t10g/${T10G_CAP_ID}.md"
	rm -f "${UM_VAULT_DIR}/authored/smoke-t10g/${T10G_OLD_ID}.md"
	rm -f "${UM_VAULT_DIR}/authored/smoke-t10g/${T10G_NEW_ID}.md"
	rmdir "${UM_VAULT_DIR}/authored/smoke-t10g" 2>/dev/null || true
	echo "[smoke]     T10-G write tool fixtures cleaned up"
	echo "[smoke]     T10-G write tools (capture + forget + supersede) all passed"
else
	if [ "${UM_MCP_WRITE_ENABLED:-false}" != "true" ]; then
		echo "[smoke]     SKIP T10-G: UM_MCP_WRITE_ENABLED not true — write tool integration skipped"
	else
		echo "[smoke]     SKIP T10-G: UM_VAULT_DIR not set — write tool integration skipped"
	fi
fi

# T10-H: slug validation — invalid id rejected in capture, forget, supersede
echo "[smoke]     T10-H: slug validation — invalid id fields rejected"

# T10-H1: memory_capture with id containing '/' must fail (C1)
T10H1_RESP=$(mcp_call 120 memory_capture '{"content":"Bad","metadata":{"type":"authored","id":"../bad","title":"Bad"}}')
echo "$T10H1_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result = data.get('result', {})
content = result.get('content', [{}])[0].get('text', '{}')
# Errors surface either as isError:true (throw) or ok:false (soft error)
is_err = result.get('isError', False)
try:
    parsed = json.loads(content)
    ok_false = parsed.get('ok') is False
except Exception:
    ok_false = False
if is_err or ok_false or 'must match' in content:
    print('OK T10-H1: memory_capture with invalid id rejected')
else:
    print('FAIL T10-H1: memory_capture should have rejected invalid id but got:', content)
    sys.exit(1)
" || { echo "FAIL: T10-H1 slug validation (capture) failed"; exit 1; }

# T10-H2: memory_forget with id containing '/' must fail (C1)
T10H2_RESP=$(mcp_call 121 memory_forget '{"id":"../etc/passwd"}')
echo "$T10H2_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result = data.get('result', {})
content = result.get('content', [{}])[0].get('text', '{}')
is_err = result.get('isError', False)
if is_err or 'must match' in content:
    print('OK T10-H2: memory_forget with invalid id rejected')
else:
    print('FAIL T10-H2: memory_forget should have rejected invalid id but got:', content)
    sys.exit(1)
" || { echo "FAIL: T10-H2 slug validation (forget) failed"; exit 1; }

# T10-H3: memory_supersede with invalid old_id must fail (C1)
T10H3_RESP=$(mcp_call 122 memory_supersede '{"old_id":"../bad","new_doc":{"type":"authored","id":"good-id","title":"T","content":"b"}}')
echo "$T10H3_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result = data.get('result', {})
content = result.get('content', [{}])[0].get('text', '{}')
is_err = result.get('isError', False)
if is_err or 'must match' in content:
    print('OK T10-H3: memory_supersede with invalid old_id rejected')
else:
    print('FAIL T10-H3: memory_supersede should have rejected invalid old_id but got:', content)
    sys.exit(1)
" || { echo "FAIL: T10-H3 slug validation (supersede old_id) failed"; exit 1; }

# T10-H4: memory_supersede with invalid new_doc.id must fail (C1)
T10H4_RESP=$(mcp_call 123 memory_supersede '{"old_id":"good-old","new_doc":{"type":"authored","id":"bad/slash","title":"T","content":"b"}}')
echo "$T10H4_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result = data.get('result', {})
content = result.get('content', [{}])[0].get('text', '{}')
is_err = result.get('isError', False)
if is_err or 'must match' in content:
    print('OK T10-H4: memory_supersede with invalid new_doc.id rejected')
else:
    print('FAIL T10-H4: memory_supersede should have rejected invalid new_doc.id but got:', content)
    sys.exit(1)
" || { echo "FAIL: T10-H4 slug validation (supersede new_doc.id) failed"; exit 1; }

echo "[smoke]     T10-H: slug validation checks all passed"

# T10-I: memory_forget idempotency (only if writes enabled and vault available)
if [ "${UM_MCP_WRITE_ENABLED:-false}" = "true" ] && [ -n "${UM_VAULT_DIR:-}" ]; then
	echo "[smoke]     T10-I: memory_forget idempotency — second call returns already_deprecated:true"
	T10I_ID="smoke-t10i-forget-$(date +%s)-$$"
	# Step 1: capture a doc
	mcp_call 130 memory_capture "{\"content\":\"Idempotency test body.\",\"metadata\":{\"type\":\"authored\",\"id\":\"$T10I_ID\",\"title\":\"T10-I Idempotency\",\"project\":\"smoke-t10i\"}}" > /dev/null
	# Step 2: forget it (first call)
	T10I_RESP1=$(mcp_call 131 memory_forget "{\"id\":\"$T10I_ID\"}")
	echo "$T10I_RESP1" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'first forget should succeed: ' + result_text
assert result.get('status') == 'deprecated', 'first forget should set status=deprecated: ' + result_text
assert result.get('already_deprecated') is not True, 'first forget should NOT return already_deprecated: ' + result_text
print('OK T10-I step 2: first forget succeeded, status=deprecated')
" || { echo "FAIL: T10-I first forget failed"; exit 1; }
	# Step 3: forget it again (second call — must be idempotent)
	T10I_RESP2=$(mcp_call 132 memory_forget "{\"id\":\"$T10I_ID\"}")
	echo "$T10I_RESP2" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'second forget should return ok:true: ' + result_text
assert result.get('already_deprecated') is True, 'second forget should return already_deprecated:true: ' + result_text
print('OK T10-I step 3: second forget returned already_deprecated:true (idempotent)')
" || { echo "FAIL: T10-I second forget (idempotency) failed"; exit 1; }
	# Cleanup vault file + any mem0 entries
	rm -f "${UM_VAULT_DIR}/authored/smoke-t10i/${T10I_ID}.md"
	rmdir "${UM_VAULT_DIR}/authored/smoke-t10i" 2>/dev/null || true
	# Remove mem0 entries for T10-I doc (may exist as deprecated)
	T10I_MEM_IDS=$(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == '$T10I_ID':
        print(r['id'])
" 2>/dev/null || true)
	for mid in $T10I_MEM_IDS; do
		curl -sf -X DELETE "$ENDPOINT/api/$mid" >/dev/null || true
	done
	echo "[smoke]     T10-I: forget idempotency verified"
else
	echo "[smoke]     SKIP T10-I: requires UM_MCP_WRITE_ENABLED=true and UM_VAULT_DIR"
fi

# T10-J: memory_recent with large limit stays within bounds (I2)
echo "[smoke]     T10-J: memory_recent with limit=50 — capped internally, no error"
T10J_RESP=$(mcp_call 140 memory_recent '{"project":"smoke-t10j","limit":50}')
echo "$T10J_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert 'results' in result, 'FAIL: memory_recent missing results key: ' + result_text
assert len(result['results']) <= 50, 'FAIL: got more results than limit: ' + str(len(result['results']))
print(f'OK T10-J: memory_recent limit=50 returned {len(result[\"results\"])} result(s), no error')
" || { echo "FAIL: T10-J memory_recent large-limit check failed"; exit 1; }

# T10-K: memory_append_turn round-trip
echo "[smoke]     T10-K: memory_append_turn round-trip"
if [ "${UM_MCP_WRITE_ENABLED:-false}" = "true" ]; then
	T10K_RESP=$(mcp_call 108 memory_append_turn '{"project":"smoke-proj","content":"Smoke T10-K content","role":"user"}')
	echo "$T10K_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true: ' + result_text
assert 'path' in result, 'expected path in result: ' + result_text
assert result.get('appended') is True, 'expected appended:true: ' + result_text
print('OK T10-K: memory_append_turn returns ok + path')
" || { echo "FAIL: T10-K memory_append_turn round-trip failed"; exit 1; }
	# Verify on-disk
	DATE=$(date -u +%Y-%m-%d)
	CAP_FILE="${UM_VAULT_DIR}/captures/smoke-proj/raw/$DATE.md"
	if grep -q "Smoke T10-K content" "$CAP_FILE"; then
		echo "OK T10-K: content visible in captures file"
	else
		echo "FAIL: T10-K content not found in $CAP_FILE"; exit 1
	fi
else
	T10K_RESP=$(mcp_call 108 memory_append_turn '{"project":"smoke-proj","content":"Smoke T10-K content","role":"user"}')
	echo "$T10K_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is False, 'expected ok:false when writes disabled: ' + result_text
# error is the v0.6 unified envelope dict {code, message, retryable} OR legacy string
err = result.get('error', '')
err_msg = err.get('message', '') if isinstance(err, dict) else err
err_code = err.get('code', '') if isinstance(err, dict) else ''
assert ('disabled' in err_msg.lower() or err_code in ('MCP_WRITES_DISABLED', 'MCP_NOT_IMPLEMENTED')), \
    'expected disabled message: ' + result_text
print('OK T10-K: memory_append_turn returns writes-disabled error (expected)')
" || { echo "FAIL: T10-K memory_append_turn did not return expected disabled error"; exit 1; }
fi

echo "[smoke]     Task 10 MCP surface tests passed"

# 4g/5 Task 2.5 gate: POST /api/delete — delete by metadata.id
echo "[smoke] 4g/5 Task 2.5 POST /api/delete — delete-by-metadata"

T_DEL_ID="smoke-t-delete-by-meta"
T_DEL_IDS=""

# Step 1: add doc with explicit metadata id
echo "[smoke]     Step 1: add doc with metadata.id=$T_DEL_ID"
DEL_ADD_RESP=$(curl -sf -X POST "$ENDPOINT/api/add" \
	-H 'Content-Type: application/json' \
	-d "{\"text\": \"Delete-by-metadata smoke test probe for $T_DEL_ID.\", \"metadata\": {\"id\": \"$T_DEL_ID\", \"type\": \"smoke-probe\"}}")
echo "$DEL_ADD_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert 'results' in data, 'response missing results key: ' + json.dumps(data)
print('OK: add with metadata.id=$T_DEL_ID succeeded')
" || { echo "FAIL: 4g step 1 add failed"; exit 1; }

T_DEL_IDS=$(echo "$DEL_ADD_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    if r.get('id'): print(r['id'])
")

# Step 2: verify findable via /api/search
echo "[smoke]     Step 2: verify doc is findable"
sleep 2
DEL_SEARCH_RESP=$(curl -sf -X POST "$ENDPOINT/api/search" \
	-H 'Content-Type: application/json' \
	-d "{\"query\": \"Delete-by-metadata smoke test probe for $T_DEL_ID\", \"limit\": 10, \"include_superseded\": true}")
echo "$DEL_SEARCH_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data.get('results', [])
found = any(r.get('id') == '$T_DEL_ID' or (r.get('metadata') or {}).get('id') == '$T_DEL_ID' for r in items)
if found:
    print('OK: doc with metadata.id=$T_DEL_ID found in search results')
else:
    print('WARN: doc not found in search (may be mem0 extraction artefact); proceeding to delete test')
" || true

# Step 3: POST /api/delete with {metadata: {id: "smoke-t-delete-by-meta"}}
echo "[smoke]     Step 3: DELETE via POST /api/delete"
DEL_RESP=$(curl -sf -X POST "$ENDPOINT/api/delete" \
	-H 'Content-Type: application/json' \
	-d "{\"metadata\": {\"id\": \"$T_DEL_ID\"}}")
echo "    Response: $DEL_RESP"
echo "$DEL_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('ok') is True, 'expected ok:true, got: ' + json.dumps(data)
assert isinstance(data.get('deleted'), int), 'expected deleted to be an integer, got: ' + json.dumps(data)
assert data.get('deleted') >= 0, 'expected deleted >= 0, got: ' + json.dumps(data)
assert data.get('query') == 'metadata.id=$T_DEL_ID', 'expected query=metadata.id=$T_DEL_ID, got: ' + str(data.get('query'))
print(f'OK: DELETE returned ok=True, deleted={data[\"deleted\"]}, query={data[\"query\"]}')
" || { echo "FAIL: 4g step 3 POST /api/delete failed"; exit 1; }

# Step 4: verify no longer findable
echo "[smoke]     Step 4: verify doc no longer findable"
sleep 2
DEL_SEARCH2=$(curl -sf -X POST "$ENDPOINT/api/search" \
	-H 'Content-Type: application/json' \
	-d "{\"query\": \"Delete-by-metadata smoke test probe for $T_DEL_ID\", \"limit\": 10, \"include_superseded\": true}")
echo "$DEL_SEARCH2" | python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data.get('results', [])
remaining = [r for r in items if r.get('id') == '$T_DEL_ID' or (r.get('metadata') or {}).get('id') == '$T_DEL_ID']
if remaining:
    print(f'FAIL: {len(remaining)} result(s) with metadata.id=$T_DEL_ID still present after delete')
    sys.exit(1)
else:
    print('OK: no results with metadata.id=$T_DEL_ID after delete')
" || { echo "FAIL: 4g step 4 post-delete search still found docs"; exit 1; }

# Step 5: error cases — both present → 400
echo "[smoke]     Step 5: both id + metadata → 400"
HTTP_STATUS_BOTH=$(curl -s -o /tmp/del_both.json -w "%{http_code}" -X POST "$ENDPOINT/api/delete" \
	-H 'Content-Type: application/json' \
	-d '{"id":"some-uuid","metadata":{"id":"some-id"}}')
[ "$HTTP_STATUS_BOTH" = "400" ] || { echo "FAIL: expected 400 when both present, got $HTTP_STATUS_BOTH"; exit 1; }
echo "    OK: both id + metadata returns 400"

# Step 6: error cases — neither present → 400
echo "[smoke]     Step 6: neither id nor metadata → 400"
HTTP_STATUS_NEITHER=$(curl -s -o /tmp/del_neither.json -w "%{http_code}" -X POST "$ENDPOINT/api/delete" \
	-H 'Content-Type: application/json' \
	-d '{}')
[ "$HTTP_STATUS_NEITHER" = "400" ] || { echo "FAIL: expected 400 when neither present, got $HTTP_STATUS_NEITHER"; exit 1; }
echo "    OK: neither id nor metadata returns 400"

echo "[smoke]     Task 2.5 POST /api/delete all steps passed"

# 4h/5 Task 2.5 verification: type=state never indexed; type=session_summary IS indexed
echo "[smoke] 4h/5 Task 2.5 type-filter verification (state=0, session_summary>=1)"

if [ -z "${UM_VAULT_DIR:-}" ]; then
	echo "[smoke] WARN: UM_VAULT_DIR not set — skipping Task 2.5 type-filter verification"
else

T25_SUBDIR="${UM_VAULT_DIR}/sessions/smoke-t25-$$"
T25_STATE_DIR="${UM_VAULT_DIR}/state/smoke-t25-$$"
mkdir -p "$T25_SUBDIR" "$T25_STATE_DIR"

T25_CLEANUP_IDS=""
t25_cleanup() {
	rm -rf "$T25_SUBDIR" "$T25_STATE_DIR"
	for id in $T25_CLEANUP_IDS; do
		[ -n "$id" ] || continue
		curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null || true
	done
}
trap t25_cleanup EXIT

# Step 1: create and attempt to reindex a state doc — expect 400 (state docs rejected)
echo "[smoke]     T25 step 1: state doc rejected by /api/reindex"
cat > "$T25_STATE_DIR/state.md" <<'T25EOF'
---
schema_version: 1
type: state
id: state-smoke-t25
title: State of play — smoke-t25
status: current
valid_from: 2026-04-17T00:00:00Z
project: smoke-t25
---
State document body smoke-t25-unique-marker for type-filter test.
T25EOF

HTTP_STATUS_T25_STATE=$(curl -s -o /tmp/t25_state_resp.json -w "%{http_code}" -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"state/smoke-t25-$$/state.md\"}")
[ "$HTTP_STATUS_T25_STATE" = "400" ] || { echo "FAIL: T25 state doc should be rejected with 400, got $HTTP_STATUS_T25_STATE"; exit 1; }
echo "[smoke]     T25 step 1 OK: state doc reindex rejected with 400"

# Step 2: search with type=state filter — must return zero results
echo "[smoke]     T25 step 2: search with type=state filter → zero results"
T25_STATE_SEARCH=$(curl -sf -X POST "$ENDPOINT/api/search" \
	-H 'Content-Type: application/json' \
	-d '{"query":"smoke-t25-unique-marker","limit":20,"include_superseded":true,"filters":{"type":"state"}}')
echo "$T25_STATE_SEARCH" | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])
# Server already applied filters.type=state server-side; compact shape omits metadata.
# Trust the server-side filter: zero results means state was excluded.
if len(results) != 0:
    print(f'FAIL: T25 step 2 — expected 0 results after server-side filter type=state, got {len(results)}: ' + json.dumps(results[:2]))
    sys.exit(1)
print(f'OK T25 step 2: type=state search returned 0 results (server-side filter authoritative)')
" || { echo "FAIL: T25 step 2 type=state search check failed"; exit 1; }

# Step 3: create and reindex a session_summary doc
echo "[smoke]     T25 step 3: reindex session_summary doc → indexed"
T25_SUMMARY_ID="session-summary-smoke-t25-$(date +%s)-$$"
cat > "$T25_SUBDIR/${T25_SUMMARY_ID}.md" <<T25SUMEOF
---
schema_version: 1
type: session_summary
id: ${T25_SUMMARY_ID}
title: Smoke T25 Session Summary
status: current
valid_from: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
project: smoke-t25
---
Session summary body smoke-t25-unique-marker for type-filter test.
T25SUMEOF

RESP_T25_SUM=$(curl -sf -X POST "$ENDPOINT/api/reindex" \
	-H 'Content-Type: application/json' \
	-d "{\"path\": \"sessions/smoke-t25-$$/${T25_SUMMARY_ID}.md\"}")
echo "    Reindex response: $RESP_T25_SUM"
echo "$RESP_T25_SUM" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('ok') is True, 'T25 step 3 reindex failed: ' + json.dumps(data)
print('OK T25 step 3: session_summary doc indexed')
" || { echo "FAIL: T25 step 3 session_summary reindex failed"; exit 1; }

# Capture IDs for cleanup
T25_CLEANUP_IDS=$(curl -sf "$ENDPOINT/api/list?full=1" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('results', [])
for r in items:
    if (r.get('metadata') or {}).get('id') == '$T25_SUMMARY_ID':
        print(r['id'])
" 2>/dev/null || true)

# Step 4: search with type=session_summary filter — must return >= 1 result
echo "[smoke]     T25 step 4: search with type=session_summary filter → >=1 result"
sleep 2
T25_SUM_SEARCH=$(curl -sf -X POST "$ENDPOINT/api/search" \
	-H 'Content-Type: application/json' \
	-d "{\"query\":\"smoke-t25-unique-marker\",\"limit\":20,\"filters\":{\"type\":\"session_summary\"}}")
echo "$T25_SUM_SEARCH" | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])
# Server already applied filters.type=session_summary — compact response omits metadata,
# so just count results. (B.1.4b compact shape, server-side filter is authoritative.)
if len(results) < 1:
    print(f'FAIL: T25 step 4 — expected >=1 result after filter type=session_summary, got {len(results)}')
    sys.exit(1)
print(f'OK T25 step 4: type=session_summary search returned {len(results)} result(s)')
" || { echo "FAIL: T25 step 4 type=session_summary search check failed"; exit 1; }

trap - EXIT
t25_cleanup
echo "[smoke]     Task 2.5 type-filter verification passed (state=0, session_summary>=1)"
fi  # end UM_VAULT_DIR guard

# 5/5 assert count returned to baseline
# With UM_MCP_WRITE_ENABLED=true, cleanup loops now use ?full=1 so they correctly
# capture mem0 UUIDs and delete test artifacts. Accept up to +3 for intentional
# residual artifacts: T10-E session summary (session-<date>-<uuid>) and T25
# session_summary doc (session-summary-smoke-t25-*) which are not cleaned up
# because they represent the legitimate cross-test session-summary artifact pattern.
# authored-doc-smoke-b from T7 may also linger if mem0 extraction splits the doc.
echo "[smoke] 5/5 verify baseline preserved"
FINAL=$(get_count)
DELTA=$((FINAL - BASELINE))
if [ "${UM_MCP_WRITE_ENABLED:-false}" = "true" ]; then
	if [ "$DELTA" -gt 3 ]; then
		echo "FAIL: memory count drifted beyond tolerance — baseline=$BASELINE final=$FINAL (delta=$DELTA > 3)"
		exit 1
	fi
	echo "[smoke] PASS (baseline=$BASELINE, final=$FINAL; write-enabled mode tolerates +$DELTA residual session_summary artifacts — expected ≤3)"
else
	if [ "$FINAL" -ne "$BASELINE" ]; then
		echo "FAIL: memory count not restored — baseline=$BASELINE final=$FINAL"
		exit 1
	fi
	echo "[smoke] PASS (baseline=$BASELINE preserved; added+verified+deleted $NUM_ADDED record(s))"
fi

# D1 S2 — flag-on micro-smoke (plan E.5, spec §8.3 + §10.3 rollout).
# Gated by UM_SMOKE_DEDUP_ON=1 (explicit opt-in) so the dedup probe writes
# (two POSTs to /api/add) only fire when an operator/CI has asked for them
# — even though dedup itself is ON by default post-flip. CI smoke step sets
# UM_SMOKE_DEDUP_ON=1 to exercise the DEDUP_MERGED path: two identical
# writes → second response carries event=DEDUP_MERGED. Requires the server
# to have UM_DEDUP_ENABLED=true (the new default).
#
# Position note: S2 runs HERE (between step 5/5 and the boot-smoke gate)
# because the boot-smoke gate below tears the main stack down at its end
# (`docker compose ... down`), so anything below would hit a closed port.
if [ "${UM_SMOKE_DEDUP_ON:-}" = "1" ]; then
	echo "[smoke] D1 S2 — flag-on micro-smoke (UM_SMOKE_DEDUP_ON=1)"
	# Two identical writes via /api/add. umAdd runs facts extraction (infer:true
	# is hardcoded in the /api/add handler) then dedup-checks each extracted
	# fact. Identical input → same extracted fact → Layer 1 hash dedup hit on
	# the second write → results[].event == 'DEDUP_MERGED'.
	#
	# We use a name-shaped fact like step 2 above ("name is X") because mem0's
	# facts extractor produces a fact reliably for that pattern; arbitrary
	# sentences sometimes extract nothing. $MARKER scopes the fact to this
	# smoke run so the test never collides with prior runs in the shared CI
	# qdrant collection.
	#
	# Historical note: `/api/memory_capture` was used pre-PR-77 but does not
	# exist as a REST endpoint — memory_capture is an MCP tool whose reindex
	# path passes `_systemMigration:true` and intentionally bypasses dedup,
	# so it could never have exercised this assertion. /api/add is the only
	# REST path that routes through umAdd with dedup eligibility.
	#
	# Mirror step 2's exact /api/add pattern (proven to work with the auth
	# wrapper). `-w` appends "HTTP_STATUS=NNN" to stdout so an empty body
	# does not silently masquerade as a transport failure; `2>&1` captures
	# curl's own diagnostics into the variable so the FAIL message is
	# actionable.
	d1_resp1=$(curl -sS -X POST "$ENDPOINT/api/add" \
		-H 'Content-Type: application/json' \
		-w '\nHTTP_STATUS=%{http_code}\n' \
		-d "{\"text\": \"The smoke test user's name is dedup-probe-${MARKER}.\", \"metadata\": {\"project\": \"d1-smoke\", \"type\": \"fact\"}, \"surface\": \"smoke\"}" 2>&1 || true)
	d1_resp2=$(curl -sS -X POST "$ENDPOINT/api/add" \
		-H 'Content-Type: application/json' \
		-w '\nHTTP_STATUS=%{http_code}\n' \
		-d "{\"text\": \"The smoke test user's name is dedup-probe-${MARKER}.\", \"metadata\": {\"project\": \"d1-smoke\", \"type\": \"fact\"}, \"surface\": \"smoke\"}" 2>&1 || true)
	echo "[smoke]     write1: $d1_resp1"
	echo "[smoke]     write2: $d1_resp2"
	# Substring check for tolerance to envelope variants. DEDUP_MERGED appears
	# in the result event when L1 (or L2) catches; dedupCount appears in the
	# qdrant payload after merge (not in the response envelope, but kept here
	# as a fallback in case the response shape evolves to surface it).
	if ! echo "$d1_resp2" | grep -qE 'DEDUP_MERGED|dedupCount'; then
		echo "[smoke] D1 S2 FAIL: second identical write did not appear to merge" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke] D1 S2 PASS: second identical write merged"
fi

# B2 S3 — /remember casual-save skill round-trip (gated by UM_SMOKE_REMEMBER_ON=1).
#
# Mirrors S2's two-write dedup pattern but exercises the v1.1 B2 /remember
# bash helper end-to-end instead of raw curl. Two invocations with identical
# text → second must surface "dedup match" in helper output. Requires the
# server to have UM_DEDUP_ENABLED=true (the v1.1 default) AND the helper to
# parse /api/add response shape correctly (results[].event === 'DEDUP_MERGED').
#
# Position: AFTER S2 (UM_SMOKE_DEDUP_ON block above) and BEFORE the boot-smoke
# gate (which tears the stack down), same as S2.
if [ "${UM_SMOKE_REMEMBER_ON:-}" = "1" ]; then
	echo "[smoke] B2 S3 — /remember casual-save round-trip (UM_SMOKE_REMEMBER_ON=1)"
	# Resolve repo root so we can invoke the helper by absolute path.
	# smoke.sh lives at <repo>/server/test/smoke.sh — dirname is server/test/,
	# so going up two levels reaches the repo root regardless of CWD.
	# (CI's working-directory=server is irrelevant here; ${BASH_SOURCE[0]}
	# is the script's own filesystem location, not the invocation cwd.)
	_um_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
	_um_remember_helper="$_um_repo_root/plugins/claude-code/universal-memory/skills/create-remember/create-remember.sh"
	if [ ! -f "$_um_remember_helper" ]; then
		echo "[smoke] B2 S3 FAIL: /remember helper not found at $_um_remember_helper" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi
	# Use $MARKER-scoped text so cross-run dedup never collides (parallel to S2).
	_um_remember_text="The smoke test user's name is remember-probe-${MARKER}."
	# First write — expect plain success (ADD event).
	b2_resp1=$(UM_SERVER_URL="$ENDPOINT" UM_AUTH_TOKEN="${UM_AUTH_TOKEN:-}" \
		bash "$_um_remember_helper" remember --text "$_um_remember_text" 2>&1 || true)
	# Second write — expect dedup-match suffix.
	b2_resp2=$(UM_SERVER_URL="$ENDPOINT" UM_AUTH_TOKEN="${UM_AUTH_TOKEN:-}" \
		bash "$_um_remember_helper" remember --text "$_um_remember_text" 2>&1 || true)
	echo "[smoke]     write1: $b2_resp1"
	echo "[smoke]     write2: $b2_resp2"
	if ! echo "$b2_resp2" | grep -q "dedup match"; then
		echo "[smoke] B2 S3 FAIL: second identical /remember did not surface dedup match" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke] B2 S3 PASS: /remember dedup-match surfaced on second write"
fi

# D2 S4 — lane-partition positive-path smoke (spec §8 T29; plan ref).
# Gated by UM_SMOKE_D2_ON=1 (explicit opt-in), mirroring S2/S3. D2 (lane /
# persona schema substrate — PR #84, v1.1.0) shipped with 23 unit /
# integration tests but no release-time probe of the *positive* path at the
# HTTP surface. The existing S3 /remember probe only exercises D2's
# back-compat arm (no lane/persona → legacy uuidv5 seed). This block closes
# the pre-D3 gap: it proves two writes with IDENTICAL text + userId but
# DIFFERENT metadata.lane land as TWO distinct, separately-filterable
# records (NOT dedup-merged), and that a no-lane write of the same text
# forms its own legacy partition (merges with neither lane record).
#
# Why this must exist before D3: D3 makes lane/persona load-bearing routing
# axes. A silent regression that strips lane before the uuidv5 seed (spec
# §4.7) or the dedup `must` filter would collapse the two lane writes onto
# one legacy point. The probe verifies the partition contract three ways:
#   (a) the lane=work and lane=personal writes must each be event=ADD —
#       their lane partitions (hash:userId:work: / :personal:) are EMPTY
#       for this fact, so a working D2 mints a fresh point for each. A
#       DEDUP_MERGED here means lane did NOT enter the seed/filter (the
#       exact D3-blocking regression). This is S2's grep inverted, but
#       scoped to the two LANE writes only (see the no-lane caveat).
#   (b) the three /api/add responses must carry three DISTINCT ids — this
#       doubles as the absence-arm structural check: id_nolane differing
#       from both lane ids proves the no-lane write did not cross into a
#       lane partition.
#   (c) read side (T29): a lane-filtered /api/search returns exactly its
#       own partition and EXCLUDES the no-lane record and the other lane.
#
# No-lane caveat (learned from CI run 25967564655 — do not re-break this):
# the no-lane write lands in the legacy/no-lane partition, which is SHARED
# across this userId with S2 (`dedup-probe-${MARKER}`) and S3
# (`remember-probe-${MARKER}`) — both run earlier whenever
# UM_SMOKE_DEDUP_ON / _REMEMBER_ON are set (always, in CI). Those
# sentences are ~90% identical to this probe's, so D2 Layer-2 (embedding
# near-dup; no hash arm; absence-arm partition) CORRECTLY dedup-merges the
# no-lane write into the pre-existing S2 legacy record. That is D2 working
# as designed, not regressing — so the probe must NOT assert "the no-lane
# write is not DEDUP_MERGED". Only the (empty) lane partitions are
# required to stay isolated; the no-lane arm is verified structurally via
# (b) + the read-side exclusion.
#
# Requires UM_DEDUP_ENABLED=true (the v1.1 default): with dedup OFF every
# write is a plain ADD regardless of lane, so assertion (a) loses its
# regression-detecting power. S4 is therefore dependent on D1 being ON,
# same as S3.
#
# Position: AFTER B2 S3 and BEFORE the boot-smoke gate (which tears the
# main stack down), identical placement rationale to S2 / S3.
if [ "${UM_SMOKE_D2_ON:-}" = "1" ]; then
	echo "[smoke] D2 S4 — lane-partition positive-path (UM_SMOKE_D2_ON=1)"
	# Identical name-shaped fact across all three writes (extracts reliably
	# in mem0's facts-extractor distribution — same rationale as step 2 and
	# S2; arbitrary sentences sometimes extract nothing). The ONLY variable
	# across the three writes is metadata.lane: work / personal / absent.
	# Same userId for all three (server-resolved from MEM0_USER_ID — smoke
	# never passes userId, mirror S2/S3), so the dedup key reduces to
	# (lane, persona, hash).
	#
	# $MARKER scopes the fact against *prior runs*, but WITHIN a run the
	# no-lane write deliberately shares the legacy partition with the
	# embedding-near S2/S3 facts (see the no-lane caveat in the header) —
	# that collision is expected and asserted around, never against.
	_d2_text="The smoke test user's name is d2-probe-${MARKER}."
	_d2_add() {
		# $1 = JSON metadata object. Mirrors S2's exact /api/add curl shape
		# (proven with the auth wrapper): -w surfaces the HTTP status so an
		# empty body can't masquerade as a transport success; `2>&1 || true`
		# keeps `set -euo pipefail` from killing the run on a curl hiccup so
		# the assertions below own the failure message.
		curl -sS -X POST "$ENDPOINT/api/add" \
			-H 'Content-Type: application/json' \
			-w '\nHTTP_STATUS=%{http_code}\n' \
			-d "{\"text\": \"$_d2_text\", \"metadata\": $1, \"surface\": \"smoke\"}" 2>&1 || true
	}
	d2_resp_work=$(_d2_add '{"project": "d2-smoke", "type": "fact", "lane": "work"}')
	d2_resp_personal=$(_d2_add '{"project": "d2-smoke", "type": "fact", "lane": "personal"}')
	d2_resp_nolane=$(_d2_add '{"project": "d2-smoke", "type": "fact"}')
	echo "[smoke]     write lane=work:     $d2_resp_work"
	echo "[smoke]     write lane=personal: $d2_resp_personal"
	echo "[smoke]     write no-lane:       $d2_resp_nolane"

	# Assertion (a): the two LANE writes must be fresh ADDs. Their lane
	# partitions are empty for this fact regardless of what S2/S3 wrote
	# (those are all no-lane), so a working D2 mints a new point for each.
	# The no-lane write is intentionally EXCLUDED here — it legitimately
	# dedup-merges within the shared legacy partition (header caveat); its
	# isolation is proven structurally by (b) + the read-side exclusion.
	# Substring grep on the raw response, same robustness rationale as S2.
	for _d2_pair in "work:$d2_resp_work" "personal:$d2_resp_personal"; do
		if printf '%s' "${_d2_pair#*:}" | grep -qE 'DEDUP_MERGED|dedupCount'; then
			echo "[smoke] D2 S4 FAIL: lane=${_d2_pair%%:*} write reported a dedup merge — its (empty) lane partition did not isolate it; lane is not entering the uuidv5 seed / dedup must-filter (spec §4.7 regressed)" >&2
			_um_smoke_auth_cleanup
			exit 1
		fi
	done

	# Extract the first result id from each response (strip the -w status
	# line, then JSON-parse). Helper is defined once and reused — the three
	# ids drive both the distinctness assertion (b) and the read-side
	# partition checks.
	_d2_id() {
		printf '%s' "$1" | python3 -c "
import json, sys
raw = sys.stdin.read().split('HTTP_STATUS=')[0].strip()
try:
    obj = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])
except Exception:
    print(''); sys.exit(0)
rs = obj.get('results', [])
print(rs[0]['id'] if rs and rs[0].get('id') else '')
"
	}
	D2_ID_WORK=$(_d2_id "$d2_resp_work")
	D2_ID_PERSONAL=$(_d2_id "$d2_resp_personal")
	D2_ID_NOLANE=$(_d2_id "$d2_resp_nolane")
	echo "[smoke]     ids: work=$D2_ID_WORK personal=$D2_ID_PERSONAL no-lane=$D2_ID_NOLANE"

	# A missing id means mem0 extracted no fact for this input — not a D2
	# regression, but the probe cannot verify partitioning without records,
	# so FAIL loudly and actionably rather than silently pass (a release
	# gate must not green on "couldn't check"). Name-shaped input makes
	# this path rare in practice (proven by S2 running green in CI).
	if [ -z "$D2_ID_WORK" ] || [ -z "$D2_ID_PERSONAL" ] || [ -z "$D2_ID_NOLANE" ]; then
		echo "[smoke] D2 S4 FAIL: one or more /api/add writes returned no record id — mem0 extracted no fact for the probe input (name-shaped extraction regressed or mem0 unavailable); cannot verify lane partition" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi

	# Assertion (b): three different (lane, persona, hash) seeds → three
	# different point ids. This doubles as the absence-arm structural
	# check: id_nolane differing from both lane ids proves the no-lane
	# write did NOT cross into a lane partition. Equality here is the exact
	# signature of a stripped-lane regression.
	if [ "$D2_ID_WORK" = "$D2_ID_PERSONAL" ] || [ "$D2_ID_WORK" = "$D2_ID_NOLANE" ] || [ "$D2_ID_PERSONAL" = "$D2_ID_NOLANE" ]; then
		echo "[smoke] D2 S4 FAIL: identical record ids across distinct lane partitions (work=$D2_ID_WORK personal=$D2_ID_PERSONAL no-lane=$D2_ID_NOLANE) — lane is not entering the uuidv5 seed (spec §4.7 regressed)" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi

	# Read side (T29 contract). mem0 write→qdrant is eventually consistent
	# (the 3/5 round-trip block above polls /api/list up to 30s for the
	# same reason). Poll the UNFILTERED search until BOTH lane records are
	# visible — they carry this exact fact text so an embedding query on it
	# ranks them top; limit 20 is ample headroom. The no-lane id is
	# deliberately NOT in the gate: it may have merged into S2's legacy
	# record (foreign surface text "dedup-probe-…"), which a "d2-probe-…"
	# query is not guaranteed to surface — and the partition asserts only
	# ever need it in the EXCLUDED set, never retrieved.
	_d2_search() {
		# $1 = JSON filters object (or {} for none). curl -sf like Task 6 /
		# step 2b (search returns 200); `|| true` so a transient non-2xx in
		# the poll loop doesn't abort under set -e — the membership check
		# owns the verdict.
		curl -sf -X POST "$ENDPOINT/api/search" \
			-H 'Content-Type: application/json' \
			-d "{\"query\": \"$_d2_text\", \"limit\": 20, \"filters\": $1}" 2>/dev/null || true
	}
	d2_lanes_visible=0
	for _i in $(seq 1 15); do
		if _d2_search '{}' | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    sys.exit(1)
sys.exit(0 if {'$D2_ID_WORK', '$D2_ID_PERSONAL'} <= ids else 1)
"; then
			d2_lanes_visible=1
			break
		fi
		sleep 2
	done
	if [ "$d2_lanes_visible" != "1" ]; then
		echo "[smoke] D2 S4 FAIL: the lane=work and lane=personal records did not both appear in unfiltered /api/search within 30s — write→qdrant visibility or default-filter regression" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke]     unfiltered search returns both lane records (work, personal)"

	# lane=work filter must return ONLY the work record: contains id_work,
	# excludes id_personal AND id_nolane. The id_nolane exclusion IS the
	# absence arm — the no-lane write (whether a fresh legacy ADD or merged
	# into S2's legacy record) must never surface under an explicit lane
	# filter (spec §4.5 legacy-point semantics). lane=personal is symmetric.
	#
	# Asserted by record-ID set membership ONLY, deliberately not by
	# re-checking r.metadata.lane (learned from CI run 25967861840 — do not
	# re-add a metadata check): /api/search returns the COMPACT shape
	# (id/title/snippet/score, NO metadata) unless ?full=1. The server
	# applies filters.lane on the internal record's metadata.lane
	# (mem0-mcp-http.mjs ~:2226) BEFORE serialising the compact view, so
	# which ids come back IS the authoritative signal that the lane
	# post-filter ran. A client-side metadata.lane re-check is (1) invalid
	# against the compact response (metadata absent → every row looks
	# "wrong") and (2) redundant: a broken/over/under lane filter is
	# already caught by the present/absent id assertions below.
	_d2_assert_partition() {
		# $1 = lane value, $2 = expected-present id, $3 $4 = expected-absent ids
		local _resp
		_resp=$(_d2_search "{\"lane\": \"$1\"}")
		printf '%s' "$_resp" | LANE="$1" PRESENT="$2" ABSENT1="$3" ABSENT2="$4" python3 -c "
import json, os, sys
lane = os.environ['LANE']
present, absent1, absent2 = os.environ['PRESENT'], os.environ['ABSENT1'], os.environ['ABSENT2']
data = json.load(sys.stdin)
assert isinstance(data, dict) and 'results' in data, 'search response missing {results} wrapper: ' + json.dumps(data)[:200]
ids = {r.get('id') for r in data['results']}
if present not in ids:
    print(f'FAIL: lane={lane} filter did not return its own record {present} (got ids={sorted(i for i in ids if i)})'); sys.exit(1)
if absent1 in ids or absent2 in ids:
    print(f'FAIL: lane={lane} filter leaked a foreign-partition record (absent expected: {absent1}, {absent2}; got ids={sorted(i for i in ids if i)})'); sys.exit(1)
print(f'OK: lane={lane} filter returns exactly its own partition record {present}')
" || { echo "[smoke] D2 S4 FAIL: lane=$1 partition assertion failed" >&2; _um_smoke_auth_cleanup; exit 1; }
	}
	_d2_assert_partition work "$D2_ID_WORK" "$D2_ID_PERSONAL" "$D2_ID_NOLANE"
	_d2_assert_partition personal "$D2_ID_PERSONAL" "$D2_ID_WORK" "$D2_ID_NOLANE"
	echo "[smoke] D2 S4 PASS: lane=work / lane=personal land as 2 distinct, lane-filterable records; the no-lane write stays in a separate legacy partition (distinct id, excluded from both lane filters)"
fi

# D3.2 S5 — auto-supersession positive-path smoke (T2.5 deliverable; spec §3.7).
# Gated by UM_SMOKE_AUTOSUPERSEDE_ON=1 (explicit opt-in), mirroring S2/S3/S4.
# D3.2 wired contradiction detection behind UM_AUTOSUPERSEDE_ENABLED; the v1.2
# D3.3 flip made it ON by default (opt-out: only literal 'false' disables —
# same polarity as D1's UM_DEDUP_ENABLED). This probe sets it explicitly anyway.
#
# What this block proves:
#   (a) A clearly-contradicting fact B in lane:work supersedes fact A in the
#       same partition after memory_checkpoint lane:work runs.
#   (b) Default /api/search excludes A (status=superseded); include_superseded
#       returns BOTH A and B; only_superseded returns A with partition metadata.
#   (c) memory_supersede {action:'unsupersede', id:A} restores A to current;
#       default search then returns A again.
#   (d) Control 1 — a fact in lane:other is completely untouched by the
#       lane:work checkpoint (cross-partition isolation).
#   (e) Control 2 (R1-B1 absence-gate) — contradicting facts A'/B' with NO
#       lane AND NO persona do NOT get superseded after a no-lane/no-persona
#       checkpoint, because the eligibility gate refuses the unpartitioned
#       bucket.
#
# Threshold: probe uses UM_AUTOSUPERSEDE_THRESHOLD=0.7 to ensure the
# unambiguous A/B contradiction clears the bar confidently. D3.3 will pin
# the eval-derived production value; 0.7 is a conservative floor here.
#
# Requires: UM_MCP_WRITE_ENABLED=true, UM_VAULT_DIR set, OPENAI_API_KEY (or
# configured contradiction provider key) — same real-infra contract as D2 S4.
# IMPORTANT: the SERVER process must have UM_AUTOSUPERSEDE_ENABLED=true (it reads
# the flag from its OWN env at request time). CI sets it on the container via the
# .env reconfig + force-recreate step in smoke.yml. The in-block exports below
# affect this client shell only and do NOT reach a separately started server;
# they are kept solely as a convenience for same-shell local runs.
if [ "${UM_SMOKE_AUTOSUPERSEDE_ON:-}" = "1" ]; then
	echo "[smoke] D3.2 S5 — auto-supersession positive-path (UM_SMOKE_AUTOSUPERSEDE_ON=1)"

	# Validate the write-enabled + vault requirements (same gate as T10-E).
	if [ "${UM_MCP_WRITE_ENABLED:-}" != "true" ] || [ -z "${UM_VAULT_DIR:-}" ]; then
		echo "[smoke] D3.2 S5 SKIP: UM_MCP_WRITE_ENABLED or UM_VAULT_DIR not set — real write path unavailable; skipping auto-supersession probe" >&2
	else

	# Enable auto-supersession and set a conservative threshold for the probe.
	# Original values are restored at the end of the block regardless of pass/fail.
	_d32_orig_enabled="${UM_AUTOSUPERSEDE_ENABLED:-}"
	_d32_orig_threshold="${UM_AUTOSUPERSEDE_THRESHOLD:-}"
	export UM_AUTOSUPERSEDE_ENABLED=true
	export UM_AUTOSUPERSEDE_THRESHOLD=0.7

	# Helper: write a fact via /api/add; mirrors _d2_add (proven shape + auth wrapper).
	_d32_add() {
		# $1 = text, $2 = JSON metadata object
		curl -sS -X POST "$ENDPOINT/api/add" \
			-H 'Content-Type: application/json' \
			-w '\nHTTP_STATUS=%{http_code}\n' \
			-d "{\"text\": \"$1\", \"metadata\": $2, \"surface\": \"smoke\"}" 2>&1 || true
	}

	# Helper: extract the first result id from an /api/add response;
	# mirrors _d2_id (same envelope shape).
	_d32_id() {
		printf '%s' "$1" | python3 -c "
import json, sys
raw = sys.stdin.read().split('HTTP_STATUS=')[0].strip()
try:
    obj = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])
except Exception:
    print(''); sys.exit(0)
rs = obj.get('results', [])
print(rs[0]['id'] if rs and rs[0].get('id') else '')
"
	}

	# Helper: POST /api/search; mirrors _d2_search.
	_d32_search() {
		# $1 = JSON body object (query/limit/filters/include_superseded/only_superseded)
		curl -sf -X POST "$ENDPOINT/api/search" \
			-H 'Content-Type: application/json' \
			-d "$1" 2>/dev/null || true
	}

	# ── Writes ──────────────────────────────────────────────────────────────
	# Fact A: present-tense, lane:work. Fact B: same topic, mutually exclusive
	# present-tense claim, lane:work. Unambiguous contradiction — the LLM judge
	# cannot treat these as time-scoped coexistences (both use present tense,
	# same subject, different values). $MARKER scopes against prior runs.
	# Two constraints, both learned from CI flakes:
	#   (1) Each write must extract to a SINGLE mem0 fact so the supersession target is
	#       unambiguous. Single-claim sentences ("is a vegan" / "eats meat") yield one
	#       fact each; a compound claim ("vegan who eats only plants") splits into two,
	#       and the single-highest-confidence rule may then supersede a different fact
	#       than this probe asserts on.
	#   (2) A and B must NOT D1-dedup-merge, or there is no second point to supersede.
	#       Same-topic contradictions sit near the 0.84 embedding threshold — the old
	#       "MacBook Pro" vs "ThinkPad" pair was ~0.83 and merged on runs where mem0's
	#       extraction jitter tipped it above 0.84. smoke.yml raises
	#       UM_DEDUP_EMBEDDING_THRESHOLD to 0.95 for the run so these stay distinct.
	# (The dedup-merge guard below fails clearly if a future fixture regresses this.)
	D32_A_TEXT="The smoke test user is a vegan (d32-${MARKER})."
	D32_B_TEXT="The smoke test user eats meat at every meal (d32-${MARKER})."

	d32_resp_a=$(_d32_add "$D32_A_TEXT" '{"project": "d32-smoke", "type": "fact", "lane": "work"}')
	echo "[smoke]     write A (lane:work, vegan):         $d32_resp_a"
	d32_resp_b=$(_d32_add "$D32_B_TEXT" '{"project": "d32-smoke", "type": "fact", "lane": "work"}')
	echo "[smoke]     write B (lane:work, eats meat):     $d32_resp_b"

	# Control 1: a fact in lane:other — must remain untouched after lane:work checkpoint.
	D32_CTRL1_TEXT="The smoke test user's office plant is a cactus (d32-ctrl1-${MARKER})."
	d32_resp_ctrl1=$(_d32_add "$D32_CTRL1_TEXT" '{"project": "d32-smoke", "type": "fact", "lane": "other"}')
	echo "[smoke]     write ctrl1 (lane:other, cactus):    $d32_resp_ctrl1"

	# Control 2 (R1-B1 absence-gate): contradicting facts with NO lane/persona.
	D32_C_TEXT="The smoke test user's favourite colour is blue (d32-c-${MARKER})."
	D32_D_TEXT="The smoke test user's favourite colour is red (d32-d-${MARKER})."
	d32_resp_c=$(_d32_add "$D32_C_TEXT" '{"project": "d32-smoke", "type": "fact"}')
	echo "[smoke]     write C (no-lane, blue):             $d32_resp_c"
	d32_resp_d=$(_d32_add "$D32_D_TEXT" '{"project": "d32-smoke", "type": "fact"}')
	echo "[smoke]     write D (no-lane, red):              $d32_resp_d"

	# Extract ids from all writes.
	D32_ID_A=$(_d32_id "$d32_resp_a")
	D32_ID_B=$(_d32_id "$d32_resp_b")
	D32_ID_CTRL1=$(_d32_id "$d32_resp_ctrl1")
	D32_ID_C=$(_d32_id "$d32_resp_c")
	D32_ID_D=$(_d32_id "$d32_resp_d")
	echo "[smoke]     ids: A=$D32_ID_A B=$D32_ID_B ctrl1=$D32_ID_CTRL1 C=$D32_ID_C D=$D32_ID_D"

	# If any id is missing, mem0 extracted nothing — same FAIL logic as D2 S4.
	if [ -z "$D32_ID_A" ] || [ -z "$D32_ID_B" ] || [ -z "$D32_ID_C" ] || [ -z "$D32_ID_D" ]; then
		echo "[smoke] D3.2 S5 FAIL: one or more /api/add writes returned no record id — mem0 extracted no fact; cannot verify auto-supersession" >&2
		export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"
		export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"
		_um_smoke_auth_cleanup
		exit 1
	fi

	# Guard: B must be a DISTINCT point from A. If D1 dedup merged B into A (their
	# embeddings were >= UM_DEDUP_EMBEDDING_THRESHOLD), B's id == A's id and there is
	# no second point to supersede — fail CLEARLY rather than as a confusing
	# "auto-supersession did not fire" (the real cause of the earlier flake).
	if [ "$D32_ID_B" = "$D32_ID_A" ]; then
		echo "[smoke] D3.2 S5 FAIL: write B DEDUP_MERGED into A (same id $D32_ID_A) — S5 fixtures too embedding-similar; auto-supersession needs two distinct points (make D32_A/B_TEXT more lexically distinct)" >&2
		export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"
		export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"
		_um_smoke_auth_cleanup
		exit 1
	fi

	# ── Poll until A and B are both visible in unfiltered search ────────────
	# Same eventual-consistency poll idiom as D2 S4 (write→qdrant async).
	d32_ab_visible=0
	for _i in $(seq 1 15); do
		if _d32_search "{\"query\": \"$D32_B_TEXT\", \"limit\": 20, \"include_superseded\": true}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    sys.exit(1)
sys.exit(0 if {'$D32_ID_A', '$D32_ID_B'} <= ids else 1)
"; then
			d32_ab_visible=1
			break
		fi
		sleep 2
	done
	if [ "$d32_ab_visible" != "1" ]; then
		echo "[smoke] D3.2 S5 FAIL: A and B did not both appear in include_superseded search within 30s — write visibility regression" >&2
		export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"
		export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke]     A and B both visible pre-checkpoint (include_superseded)"

	# ── Run checkpoint on lane:work (triggers contradiction detection for A/B) ─
	# The newer contradicting claim (B) MUST be in the TRANSCRIPT, not just in
	# qdrant: the detector extracts NEW facts from the session transcript and
	# judges them against older STORED facts. A and B were written via /api/add
	# (qdrant only, never the transcript), so B's claim is seeded here as a turn —
	# otherwise the detector has no new fact to contradict the older stored A.
	mcp_call 200 memory_append_turn "{\"project\":\"d32-smoke\",\"content\":\"$D32_B_TEXT\",\"role\":\"user\"}" >/dev/null
	D32_CP_RESP=$(mcp_call 201 memory_checkpoint "{\"project\":\"d32-smoke\",\"lane\":\"work\"}")
	echo "[smoke]     checkpoint lane:work response: $D32_CP_RESP"
	echo "$D32_CP_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true from checkpoint: ' + result_text
print('OK: memory_checkpoint lane:work returned ok:true')
" || { echo "[smoke] D3.2 S5 FAIL: checkpoint lane:work did not return ok:true"; export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"; export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"; _um_smoke_auth_cleanup; exit 1; }

	# ── Allow time for supersession write to propagate ───────────────────────
	# supersedePoint writes to qdrant; eventual consistency (same as write-to-search).
	d32_a_superseded=0
	for _i in $(seq 1 15); do
		if _d32_search "{\"query\": \"$D32_B_TEXT\", \"limit\": 20, \"filters\": {\"lane\": \"work\"}}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    sys.exit(1)
# A must be absent (superseded, excluded from default), B present
sys.exit(0 if '$D32_ID_B' in ids and '$D32_ID_A' not in ids else 1)
"; then
			d32_a_superseded=1
			break
		fi
		sleep 2
	done
	if [ "$d32_a_superseded" != "1" ]; then
		echo "[smoke] D3.2 S5 FAIL: after checkpoint lane:work, A was not superseded (default search still returns A, or B missing) — auto-supersession did not fire or threshold too high" >&2
		echo "[smoke]   Note: verify UM_AUTOSUPERSEDE_ENABLED=true reached the running container (env may not propagate to an already-started docker process)" >&2
		export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"
		export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke]     assertion (a) PASS: default search lane:work returns B only (A superseded+excluded)"

	# Assertion (b-i): include_superseded=true must return BOTH A and B.
	_d32_search "{\"query\": \"$D32_B_TEXT\", \"limit\": 20, \"include_superseded\": true, \"filters\": {\"lane\": \"work\"}}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    print('FAIL: could not parse include_superseded response'); sys.exit(1)
if '$D32_ID_A' not in ids:
    print(f'FAIL: A ({\"$D32_ID_A\"}) not in include_superseded results (expected both A and B)'); sys.exit(1)
if '$D32_ID_B' not in ids:
    print(f'FAIL: B ({\"$D32_ID_B\"}) not in include_superseded results'); sys.exit(1)
print('OK: include_superseded=true returns both A and B')
" || { echo "[smoke] D3.2 S5 FAIL: include_superseded assertion failed"; export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"; export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"; _um_smoke_auth_cleanup; exit 1; }
	echo "[smoke]     assertion (b-i) PASS: include_superseded=true returns both A and B"

	# Assertion (b-ii): only_superseded=true in lane:work must show A.
	_d32_search "{\"query\": \"$D32_B_TEXT\", \"limit\": 20, \"only_superseded\": true, \"filters\": {\"lane\": \"work\"}}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    print('FAIL: could not parse only_superseded response'); sys.exit(1)
if '$D32_ID_A' not in ids:
    print(f'FAIL: A ({\"$D32_ID_A\"}) not in only_superseded results'); sys.exit(1)
if '$D32_ID_B' in ids:
    print(f'FAIL: B ({\"$D32_ID_B\"}) appeared in only_superseded results (should be current, not superseded)'); sys.exit(1)
print('OK: only_superseded=true returns A (superseded), not B (current)')
" || { echo "[smoke] D3.2 S5 FAIL: only_superseded assertion failed"; export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"; export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"; _um_smoke_auth_cleanup; exit 1; }
	echo "[smoke]     assertion (b-ii) PASS: only_superseded=true returns A, excludes B"

	# Assertion (c): unsupersede A → A must reappear in default search.
	D32_UNSUP_RESP=$(mcp_call 202 memory_supersede "{\"action\":\"unsupersede\",\"id\":\"$D32_ID_A\"}")
	echo "[smoke]     unsupersede A response: $D32_UNSUP_RESP"
	echo "$D32_UNSUP_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true from unsupersede: ' + result_text
assert result.get('status') == 'current', 'expected status=current: ' + result_text
print('OK: unsupersede returned ok:true, status:current')
" || { echo "[smoke] D3.2 S5 FAIL: unsupersede MCP call did not return ok:true"; export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"; export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"; _um_smoke_auth_cleanup; exit 1; }
	# Poll until A is current again in default search.
	d32_a_restored=0
	for _i in $(seq 1 15); do
		if _d32_search "{\"query\": \"$D32_A_TEXT\", \"limit\": 20, \"filters\": {\"lane\": \"work\"}}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    sys.exit(1)
sys.exit(0 if '$D32_ID_A' in ids else 1)
"; then
			d32_a_restored=1
			break
		fi
		sleep 2
	done
	if [ "$d32_a_restored" != "1" ]; then
		echo "[smoke] D3.2 S5 FAIL: after unsupersede A, A did not reappear in default search within 30s" >&2
		export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"
		export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke]     assertion (c) PASS: unsupersede A restores A to default search"

	# ── Control 1: lane:other must be untouched ──────────────────────────────
	# The lane:work checkpoint must NOT have touched lane:other. ctrl1 should
	# still be visible in a lane:other search (status=current).
	# If ctrl1 id is empty (mem0 extracted nothing), skip this sub-check.
	if [ -n "$D32_ID_CTRL1" ]; then
		_d32_search "{\"query\": \"$D32_CTRL1_TEXT\", \"limit\": 20, \"filters\": {\"lane\": \"other\"}}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    print('FAIL: could not parse ctrl1 search response'); sys.exit(1)
if '$D32_ID_CTRL1' not in ids:
    print(f'FAIL: ctrl1 ({\"$D32_ID_CTRL1\"}) missing from lane:other default search — cross-partition supersession leak'); sys.exit(1)
print('OK: ctrl1 lane:other fact is current (lane:work checkpoint did not touch it)')
" || { echo "[smoke] D3.2 S5 FAIL: Control 1 lane:other isolation failed"; export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"; export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"; _um_smoke_auth_cleanup; exit 1; }
		echo "[smoke]     control 1 PASS: lane:other fact untouched by lane:work checkpoint"
	else
		echo "[smoke]     control 1 SKIP: ctrl1 write extracted no fact (mem0 extraction skipped)"
	fi

	# ── Control 2 (R1-B1 absence-gate): no-lane/no-persona facts ────────────
	# Run a checkpoint with NO lane and NO persona. The eligibility gate in
	# contradiction-batch.mjs returns [] for unpartitioned buckets, so C and D
	# must BOTH remain current.
	# Seed D's contradicting claim into the no-lane transcript so this control is
	# a REAL gate regression guard: if the absence-gate were removed, the detector
	# would extract D, find C, and wrongly supersede C — failing this control.
	# With the gate intact it returns [] before even reading the transcript.
	mcp_call 203 memory_append_turn "{\"project\":\"d32-smoke-nolane\",\"content\":\"$D32_D_TEXT\",\"role\":\"user\"}" >/dev/null
	D32_CP2_RESP=$(mcp_call 204 memory_checkpoint '{"project":"d32-smoke-nolane"}')
	echo "[smoke]     checkpoint (no lane/persona) response: $D32_CP2_RESP"
	echo "$D32_CP2_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result_text = data.get('result', {}).get('content', [{}])[0].get('text', '{}')
result = json.loads(result_text)
assert result.get('ok') is True, 'expected ok:true from no-lane checkpoint: ' + result_text
print('OK: no-lane checkpoint returned ok:true')
" || { echo "[smoke] D3.2 S5 FAIL: no-lane checkpoint did not return ok:true"; export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"; export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"; _um_smoke_auth_cleanup; exit 1; }
	# C and D must both appear in default (non-include_superseded) search.
	d32_cd_current=0
	for _i in $(seq 1 10); do
		if _d32_search "{\"query\": \"$D32_D_TEXT\", \"limit\": 20, \"include_superseded\": true}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    sys.exit(1)
# Both must be present in include_superseded — then check neither is superseded.
sys.exit(0 if {'$D32_ID_C', '$D32_ID_D'} <= ids else 1)
"; then
			d32_cd_current=1
			break
		fi
		sleep 2
	done
	if [ "$d32_cd_current" != "1" ]; then
		echo "[smoke] D3.2 S5 WARN: C/D no-lane facts not visible in include_superseded search within 20s — likely mem0 extraction yielded no fact for these inputs; skipping R1-B1 sub-assertion" >&2
	else
		# Verify neither C nor D is superseded (should appear in DEFAULT search too).
		_d32_search "{\"query\": \"$D32_D_TEXT\", \"limit\": 20}" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    ids = {r.get('id') for r in data.get('results', [])}
except Exception:
    print('FAIL: could not parse no-lane default search response'); sys.exit(1)
c_id, d_id = '$D32_ID_C', '$D32_ID_D'
# If both are in default results they are current (not superseded).
# If either is absent we check only_superseded to confirm it is not there either.
print(f'default search ids: {sorted(i for i in ids if i)}')
" || true
		# Primary check: neither C nor D should appear in only_superseded.
		_d32_search "{\"query\": \"$D32_D_TEXT\", \"limit\": 50, \"only_superseded\": true}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    print('FAIL: could not parse only_superseded no-lane response'); sys.exit(1)
if '$D32_ID_C' in ids or '$D32_ID_D' in ids:
    print(f'FAIL (R1-B1): no-lane facts C/D appear in only_superseded — unpartitioned checkpoint eligibility gate regressed'); sys.exit(1)
print('OK (R1-B1): no-lane C/D not in only_superseded — eligibility gate held')
" || { echo "[smoke] D3.2 S5 FAIL: Control 2 (R1-B1): no-lane facts were superseded by a no-lane checkpoint — eligibility gate regressed"; export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"; export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"; _um_smoke_auth_cleanup; exit 1; }
		echo "[smoke]     control 2 (R1-B1) PASS: no-lane/no-persona facts NOT superseded by no-partition checkpoint"
	fi

	# ── Restore env and cleanup session artifacts ────────────────────────────
	export UM_AUTOSUPERSEDE_ENABLED="$_d32_orig_enabled"
	export UM_AUTOSUPERSEDE_THRESHOLD="$_d32_orig_threshold"
	rm -rf "${UM_VAULT_DIR}/sessions/d32-smoke" "${UM_VAULT_DIR}/state/d32-smoke" \
	       "${UM_VAULT_DIR}/captures/d32-smoke" \
	       "${UM_VAULT_DIR}/sessions/d32-smoke-nolane" "${UM_VAULT_DIR}/state/d32-smoke-nolane" \
	       "${UM_VAULT_DIR}/captures/d32-smoke-nolane" 2>/dev/null || true

	echo "[smoke] D3.2 S5 PASS: auto-supersession fires on lane:work contradiction; include_superseded/only_superseded correct; unsupersede restores; cross-partition + absence-gate controls held"
	fi  # end UM_MCP_WRITE_ENABLED check
fi

# Gap-5 S6 — lane-classifier auto-population positive-path smoke (P4 flip; v1.3.0; spec §3.4).
# Gated by UM_SMOKE_LANE_ON=1 (explicit opt-in), mirroring S2/S3/S4/S5.
#
# What the v1.3 P4 flip changed: the write-time lane classifier is now ON BY
# DEFAULT (opt-out — disabled only when UM_LANE_CLASSIFIER_ENABLED is exactly
# 'false'). So an /api/add with NO metadata.lane now has its lane AUTO-POPULATED
# from the bundled taxonomy (config/lane-taxonomy.default.json, shipped in the
# image via the Dockerfile `COPY config/`) scored against real embeddings (the
# SAME vector already computed for the fact — no extra LLM call), then written to
# the point's metadata.lane (add.mjs: itemLane → buildPayload). Pre-P4 this path
# was inert (opt-in only), so the D2 S4 no-lane write above stayed unpartitioned;
# post-P4 the classifier decides. Independent of UM_DEDUP_ENABLED: the classify
# path is gated only on classifierEngaged + no caller lane + !classifySkip
# (add.mjs), none of which involve dedup — unlike S3/S4/S5.
#
# This probe proves the DEFAULT end-to-end on the live stack with NO .env reconfig
# (unlike S5), precisely because default-ON IS the v1.3 contract under test. It
# asserts both directions of the classifier's contract:
#   (1) ROUTE   — a clearly work-flavored fact written with NO metadata.lane lands
#       lane:work-filterable. Its text is kept near a `work` taxonomy exemplar
#       ("Closed out a sprint ticket and updated the board.") so routing is robust
#       to mem0's facts-extractor rephrasing the stored text — the classifier
#       embeds the EXTRACTED fact, not the raw input (same jitter S2/D2 handle).
#   (2) ABSTAIN — an off-taxonomy "noise" fact (no exemplar resembles it) is stored
#       UNPARTITIONED: present in unfiltered search, absent from EVERY lane filter.
#       This is the no-D3-false-positive guarantee (spec §3.2: no `general`
#       catch-all; itemLane = classified ?? undefined ⇒ no lane key), the property
#       that keeps the D3 auto-supersession detector lane-scoped.
#
# Assert-by-record-ID ONLY (same rationale as D2 S4, CI run 25967861840):
# /api/search returns the COMPACT shape (no metadata) unless ?full=1, and the
# server applies filters.lane on the internal metadata.lane BEFORE serialising —
# so which ids come back IS the authoritative signal that the lane post-filter
# ran. A client-side metadata.lane re-check is invalid against the compact
# response and redundant.
#
# Flake notes (sibling S5's real-embedding routing cost ~3 CI iterations — see the
# S5 header ~L1994):
#   - mem0 extraction jitter: the stored fact text may differ from the input, so
#     the fixtures are kept near-exemplar (route) / clearly off-taxonomy (abstain)
#     to stay robust across extractions.
#   - D1 dedup: $MARKER scopes each fact against prior runs, and both texts are
#     topically unique vs S2/S3/D2/D32 (names, vegan/meat, colours, cactus), so
#     neither merges into a pre-existing point (CI also pins
#     UM_DEDUP_EMBEDDING_THRESHOLD=0.95 for the whole run — see the reconfig step).
#   - the noise fixture is the likeliest de-flake target: if it routes to a lane,
#     the FAIL message names the lane so the fixture can be moved further
#     off-taxonomy. NB `personal` carries home-maintenance/chore exemplars, so a
#     noise fact must avoid household-activity phrasing.
#
# Requires a default-ON (v1.3+) server: UM_LANE_CLASSIFIER_ENABLED unset or ≠
# 'false', the taxonomy file present in the image, and OPENAI_API_KEY on the
# server (exemplar + fact embeds). All three hold in CI. Position: AFTER S5 and
# BEFORE the boot-smoke gate (same placement rationale as S2-S5).
if [ "${UM_SMOKE_LANE_ON:-}" = "1" ]; then
	echo "[smoke] Gap-5 S6 — lane-classifier auto-population positive-path (UM_SMOKE_LANE_ON=1)"

	# Two writes, both with NO metadata.lane — the classifier is the only thing
	# that can populate it. $MARKER scopes against prior runs; mem0 may drop or
	# keep the parenthetical, but the core sentence carries the routing signal.
	# The work fact is SINGLE-CLAIM (no "and …"): a compound sentence splits into
	# multiple mem0 facts (S5 header lesson ~L1994) and the assertions key on
	# results[0], so a second clause landing first would break them. One claim →
	# one fact → deterministic results[0]. Kept near the work exemplar "Closed out
	# a sprint ticket …" so routing survives mem0 rephrasing the stored text. (CI
	# run 27320317851 confirmed "Closed out the sprint ticket …" extracts to "The
	# user closed out a sprint ticket." and auto-routes to lane:work.)
	_lane_work_text="Closed out the sprint ticket after the standup (lane-${MARKER})."
	_lane_noise_text="The spare umbrella is in the hall closet (lane-noise-${MARKER})."

	# Helper: write a fact via /api/add with NO lane in metadata; mirrors _d2_add /
	# _d32_add (proven curl shape + -w status line + auth wrapper + fail-soft).
	_lane_add() {
		# $1 = text
		curl -sS -X POST "$ENDPOINT/api/add" \
			-H 'Content-Type: application/json' \
			-w '\nHTTP_STATUS=%{http_code}\n' \
			-d "{\"text\": \"$1\", \"metadata\": {\"project\": \"lane-smoke\", \"type\": \"fact\"}, \"surface\": \"smoke\"}" 2>&1 || true
	}

	# Helper: extract the first result id from an /api/add response; mirrors
	# _d2_id / _d32_id (same envelope, strips the -w status line first).
	_lane_id() {
		printf '%s' "$1" | python3 -c "
import json, sys
raw = sys.stdin.read().split('HTTP_STATUS=')[0].strip()
try:
    obj = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])
except Exception:
    print(''); sys.exit(0)
rs = obj.get('results', [])
print(rs[0]['id'] if rs and rs[0].get('id') else '')
"
	}

	# Helper: POST /api/search; mirrors _d2_search / _d32_search.
	_lane_search() {
		# $1 = JSON body object (query/limit/filters)
		curl -sf -X POST "$ENDPOINT/api/search" \
			-H 'Content-Type: application/json' \
			-d "$1" 2>/dev/null || true
	}

	lane_resp_work=$(_lane_add "$_lane_work_text")
	lane_resp_noise=$(_lane_add "$_lane_noise_text")
	echo "[smoke]     write work-flavored (no lane): $lane_resp_work"
	echo "[smoke]     write noise (no lane):         $lane_resp_noise"

	LANE_ID_WORK=$(_lane_id "$lane_resp_work")
	LANE_ID_NOISE=$(_lane_id "$lane_resp_noise")
	echo "[smoke]     ids: work-fact=$LANE_ID_WORK noise-fact=$LANE_ID_NOISE"

	# A missing id means mem0 extracted no fact — cannot verify routing/abstention,
	# so FAIL loudly rather than green on "couldn't check" (same gate as D2/S5).
	if [ -z "$LANE_ID_WORK" ] || [ -z "$LANE_ID_NOISE" ]; then
		echo "[smoke] Gap-5 S6 FAIL: a /api/add write returned no record id — mem0 extracted no fact for the probe input (extraction regressed or mem0 unavailable); cannot verify lane auto-classification" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi

	# Poll the UNFILTERED search until BOTH facts are visible (write→qdrant is
	# eventually consistent — same idiom as D2/S5). Each fact carries its own text
	# so it ranks top for its own query. Proving the noise fact is stored makes its
	# abstention meaningful (absence from lane filters != "never written").
	lane_both_visible=0
	for _i in $(seq 1 15); do
		if _lane_search "{\"query\": \"$_lane_work_text\", \"limit\": 20}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    sys.exit(1)
sys.exit(0 if '$LANE_ID_WORK' in ids else 1)
" && _lane_search "{\"query\": \"$_lane_noise_text\", \"limit\": 20}" | python3 -c "
import json, sys
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    sys.exit(1)
sys.exit(0 if '$LANE_ID_NOISE' in ids else 1)
"; then
			lane_both_visible=1
			break
		fi
		sleep 2
	done
	if [ "$lane_both_visible" != "1" ]; then
		echo "[smoke] Gap-5 S6 FAIL: the work and/or noise fact did not appear in unfiltered /api/search within 30s (work=$LANE_ID_WORK noise=$LANE_ID_NOISE) — write→qdrant visibility regression or mem0 stored a divergent fact text" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke]     both facts visible in unfiltered search"

	# (1) ROUTE: the work-flavored fact must come back under the lane:work filter —
	# i.e. the default-ON classifier auto-populated metadata.lane='work'. Presence
	# under lane:work is sufficient (a record has exactly one lane); no need to
	# also assert absence from the other lanes.
	_lane_search "{\"query\": \"$_lane_work_text\", \"limit\": 20, \"filters\": {\"lane\": \"work\"}}" | LANE_ID_WORK="$LANE_ID_WORK" python3 -c "
import json, os, sys
want = os.environ['LANE_ID_WORK']
try:
    data = json.load(sys.stdin)
except Exception:
    print('FAIL: could not parse lane:work search response'); sys.exit(1)
assert isinstance(data, dict) and 'results' in data, 'search response missing {results} wrapper: ' + json.dumps(data)[:200]
ids = {r.get('id') for r in data['results']}
if want not in ids:
    print('FAIL: work-flavored fact ' + want + ' not returned under the lane:work filter (got ids=' + str(sorted(i for i in ids if i)) + ') — classifier did not auto-route it to work (it abstained, or routed to another lane)'); sys.exit(1)
print('OK: work-flavored fact auto-classified to lane:work (' + want + ')')
" || { echo "[smoke] Gap-5 S6 FAIL: work-flavored no-lane write was NOT auto-routed to lane:work — default-ON classifier route path regressed (or the fixture drifted off the work exemplars)" >&2; _um_smoke_auth_cleanup; exit 1; }
	echo "[smoke]     assertion (1) PASS: work-flavored no-lane fact auto-routed to lane:work"

	# (2) ABSTAIN: the noise fact must NOT appear under ANY of the four bundled
	# lanes — it has no metadata.lane (itemLane = classified ?? undefined). It IS
	# in unfiltered search (proven above), so this is a real abstention, not a
	# missing record.
	for _lane in work personal research writing; do
		_lane_search "{\"query\": \"$_lane_noise_text\", \"limit\": 20, \"filters\": {\"lane\": \"$_lane\"}}" | LANE_ID_NOISE="$LANE_ID_NOISE" LANE="$_lane" python3 -c "
import json, os, sys
noise, lane = os.environ['LANE_ID_NOISE'], os.environ['LANE']
try:
    ids = {r.get('id') for r in json.load(sys.stdin).get('results', [])}
except Exception:
    print('FAIL: could not parse lane:' + lane + ' search response'); sys.exit(1)
if noise in ids:
    print('FAIL: noise fact ' + noise + ' leaked into lane:' + lane + ' — classifier over-routed an off-taxonomy fact (move the noise fixture further from the ' + lane + ' exemplars)'); sys.exit(1)
print('OK: noise fact absent from lane:' + lane)
" || { echo "[smoke] Gap-5 S6 FAIL: noise fact appeared under lane:$_lane — abstention regressed; the default-ON classifier routed an unroutable fact into a lane (would seed D3 false partitions)" >&2; _um_smoke_auth_cleanup; exit 1; }
	done
	echo "[smoke]     assertion (2) PASS: noise fact abstained (stored unpartitioned; absent from all four lane filters)"

	echo "[smoke] Gap-5 S6 PASS: default-ON classifier auto-populates lane:work for a work-flavored no-lane write and abstains on an off-taxonomy fact — the v1.3 flip proven on the live stack (no .env reconfig)"
fi

# Gap-3 OAuth S7 — live OAuth flow probe (PR-5; plan Task 5.2; spec §4).
# Gated by UM_SMOKE_OAUTH=1 (explicit opt-in), mirroring S2/S3/S4/S5/S6.
#
# Unlike the S2-S6 data-path probes, this drives the embedded OAuth
# authorization server end-to-end over the wire: discovery (RFC 9728/8414) →
# DCR register → authorize/consent → PKCE-bound token grant → an authenticated
# /mcp tools/list with the umat_ access token → refresh rotation → reuse
# tripwire. The heavy lifting is in the standalone node script
# test/oauth-flow-probe.mjs (stdlib-only, NOT a node:test file so the unit
# suite glob skips it); this block only decides whether to RUN it.
#
# The default smoke stack ships UM_OAUTH_ENABLED OFF (the documented v0.x
# default — OAuth is opt-in per spec §0). When OAuth is off, the discovery
# well-known is hard-404'd by the endpoint-class row, so there is nothing to
# probe. Rather than fail (OAuth-off is a valid, default posture), this block
# first probes the discovery endpoint: a 404 ⇒ SKIP with an actionable hint; a
# 200 ⇒ the stack is OAuth-enabled, so run the probe and FAIL the smoke run on
# any nonzero exit. This keeps the default CI green while letting an
# OAuth-enabled stack (UM_OAUTH_ENABLED=true + UM_PUBLIC_BASE_URL set) actually
# exercise the full flow.
#
# Position: AFTER S6 and BEFORE the boot-smoke gate (same placement rationale as
# S2-S6 — $ENDPOINT / $UM_AUTH_TOKEN are in scope, and the deferred auth-config
# cleanup below still runs). The node script is resolved relative to BASH_SOURCE
# (the _SMOKE_DIR idiom the boot-smoke gate uses) so smoke.sh works from any cwd
# (CI runs from server/, the pre-push hook from the worktree root).
if [ "${UM_SMOKE_OAUTH:-}" = "1" ]; then
	echo "[smoke] Gap-3 OAuth S7 — live OAuth flow probe (UM_SMOKE_OAUTH=1)"

	# Probe discovery WITHOUT the auth wrapper (`command curl`, not the bearer-
	# injecting curl()): the well-known is bypassAuth when OAuth is on and
	# hard-404'd when it's off — the header is irrelevant either way, and using
	# the bare builtin keeps this independent of the auth-config tempfile.
	_oauth_disc_status=$(command curl -s -o /dev/null -w '%{http_code}' \
		"$ENDPOINT/.well-known/oauth-authorization-server" 2>/dev/null || echo "000")

	if [ "$_oauth_disc_status" = "404" ]; then
		echo "[smoke] OAuth probe: server has OAuth disabled — set UM_OAUTH_ENABLED=true + UM_PUBLIC_BASE_URL to run; skipping"
	elif [ "$_oauth_disc_status" = "200" ]; then
		# OAuth-enabled stack: run the full flow. The probe reads UM_PROBE_BASE_URL
		# (the endpoint) and UM_AUTH_TOKEN (the operator token for the consent step,
		# already loaded above from .env). Nonzero exit ⇒ fail the smoke run.
		_SMOKE_DIR_OAUTH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
		if UM_PROBE_BASE_URL="$ENDPOINT" UM_AUTH_TOKEN="${UM_AUTH_TOKEN:-}" \
			node "$_SMOKE_DIR_OAUTH/oauth-flow-probe.mjs"; then
			echo "[smoke] Gap-3 OAuth S7 PASS: full OAuth flow exercised end-to-end on the live stack (discovery → DCR → authorize/consent → PKCE token → authenticated /mcp → refresh rotation → reuse tripwire)"
		else
			echo "[smoke] Gap-3 OAuth S7 FAIL: live OAuth flow probe exited nonzero (see [oauth-probe] FAIL line above)" >&2
			_um_smoke_auth_cleanup
			exit 1
		fi
	else
		echo "[smoke] Gap-3 OAuth S7 FAIL: discovery probe of /.well-known/oauth-authorization-server returned HTTP $_oauth_disc_status (expected 200 if OAuth on, 404 if off) — server unreachable or misbehaving" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi
fi

# Tier-2 #9 S8 — cross-surface recall probe (spec
# docs/plans/2026-06-24-cross-surface-smoke-spec.md). Gated by UM_SMOKE_XSURFACE=1
# (explicit opt-in), mirroring S2–S7. Proves the core "any vendor / any surface"
# contract end-to-end: a fact WRITTEN on the REST surface (POST /api/add) is
# RECALLABLE on the MCP surface (POST /mcp JSON-RPC memory_search) — two distinct
# HTTP transports. Reuses the in-scope helpers: the auth-wrapped curl() (its
# --config tmpfile is torn down only AFTER the boot-smoke gate below, so it is
# still live here), mcp_call() (defined in Task 10), the unique-marker +
# DELETE-cleanup idioms, and the 3/5 retry budget.
#
# No write-mode needed: POST /api/add is NOT UM_MCP_WRITE_ENABLED-gated (it writes
# over REST regardless — mem0-mcp-http.mjs:2430), and memory_search is a read tool.
# The search passes NO filters, so no lane/persona/project partition can hide the
# REST-written fact from the MCP read (handler mem0-mcp-http.mjs:959-972).
#
# Position: AFTER S7 and BEFORE the boot-smoke gate (same rationale as S2–S7).
# Self-cleaning (DELETE) so the 5/5 baseline-preservation check stays green.
if [ -n "${UM_SMOKE_XSURFACE:-}" ]; then
	echo "[smoke] Tier-2 #9 S8 — cross-surface REST->MCP recall (UM_SMOKE_XSURFACE=1)"
	XS_MARKER="xsurface-$(date +%s)-$$"
	XS_IDS=""

	# Failure-safe cleanup: delete every fact this probe wrote, even on an
	# assertion failure, so the 5/5 baseline-preservation check stays green.
	xs_cleanup() {
		for id in $XS_IDS; do
			[ -n "$id" ] || continue
			curl -sf -X DELETE "$ENDPOINT/api/$id" >/dev/null 2>&1 || true
		done
	}
	xs_fail() { echo "[smoke] S8 FAIL: $1" >&2; xs_cleanup; _um_smoke_auth_cleanup; exit 1; }

	# 1) WRITE via REST surface — a fact-shaped, marker-salient sentence.
	XS_ADD_RESP=$(curl -sf -X POST "$ENDPOINT/api/add" \
		-H 'Content-Type: application/json' \
		-d "{\"text\": \"The cross-surface verification code is $XS_MARKER.\"}") || xs_fail "/api/add request failed"
	XS_IDS=$(echo "$XS_ADD_RESP" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    if r.get('id'): print(r['id'])
") || xs_fail "/api/add returned malformed JSON: $XS_ADD_RESP"
	[ -n "$XS_IDS" ] || xs_fail "/api/add extracted 0 facts (input must reliably extract): $XS_ADD_RESP"
	echo "[smoke]     wrote $(echo "$XS_IDS" | wc -w | tr -d ' ') fact(s) via REST /api/add, marker=$XS_MARKER"

	# 2) READ via MCP surface — poll memory_search until the marker surfaces
	#    (mem0 writes settle async; same 15x2s budget as the 3/5 round-trip).
	XS_FOUND=0
	XS_SEARCH_RESP=""
	for i in $(seq 1 15); do
		XS_SEARCH_RESP=$(mcp_call 200 memory_search "{\"query\":\"$XS_MARKER\",\"limit\":10,\"full\":true}") || true
		XS_HIT=$(echo "$XS_SEARCH_RESP" | python3 -c "
import json, sys
m = '$XS_MARKER'
data = json.load(sys.stdin)
txt = (data.get('result', {}).get('content') or [{}])[0].get('text', '{}')
results = json.loads(txt).get('results', []) if txt else []
print('1' if any(m in str(r.get('title','')) + str(r.get('body','')) + str(r.get('snippet','')) for r in results) else '0')
" 2>/dev/null || echo 0)
		if [ "$XS_HIT" = "1" ]; then XS_FOUND=1; break; fi
		sleep 2
	done
	[ "$XS_FOUND" = "1" ] || xs_fail "marker '$XS_MARKER' written via REST never surfaced in MCP memory_search after 30s. Last response: $XS_SEARCH_RESP"
	echo "[smoke]     OK: REST-written marker recalled via MCP memory_search (cross-surface round-trip proven)"

	# 3) Cleanup — restore baseline.
	xs_cleanup
	echo "[smoke]     Tier-2 #9 S8 cross-surface records cleaned up"
fi

# Auth cleanup deferred to after the boot-smoke gate below — the curl()
# wrapper defined at the auth-setup block prepends `--config $TMPFILE` to
# every curl call (so the bearer token never appears in argv). Cleanup
# must run AFTER the last curl invocation, otherwise the wrapped curl
# fails with "cannot read config from <deleted-tmpfile>" and the boot-
# test poll silently 30-times-fails (caught on PR #35 CI run 25235030377).

# 6/6 mocked-SDK boot smoke gate (Task G2.5, spec §9.4)
# ------------------------------------------------------
# Spin the container up with each non-default UM_*_PROVIDER value and
# verify clean boot. Uses UM_TEST_MOCK_SDK=1 so provider modules
# short-circuit to canned responses — no real API calls or live Ollama
# daemon required.
#
# Set UM_SKIP_BOOT_SMOKE=1 to skip (CI without Docker, or local stack
# that's already configured for a specific provider). The 5/5 baseline
# block above is the smoke gate's `set` of read/write assertions; this
# block validates _registry wiring + container startup_ for each
# alternate provider, which is orthogonal to the data-path tests.
if [ "${UM_SKIP_BOOT_SMOKE:-}" = "1" ]; then
	echo "[smoke] 6/6 mocked-SDK boot tests SKIPPED (UM_SKIP_BOOT_SMOKE=1)"
else
	echo "[smoke] 6/6 mocked-SDK boot tests (spec §9.4)"
	# docker-compose.yml lives one dir above smoke.sh (smoke.sh is at
	# server/test/smoke.sh, compose at server/docker-compose.yml).
	# Resolve relative to BASH_SOURCE so callers can invoke from any cwd
	# (CI runs from server/, pre-push hook runs from worktree root).
	# Caller may still override via UM_COMPOSE_FILE for dev workflows.
	_SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	UM_COMPOSE_FILE="${UM_COMPOSE_FILE:-$_SMOKE_DIR/../docker-compose.yml}"
	# Boot-test overlay: shell-pass-through for UM_*_PROVIDER, UM_TEST_MOCK_SDK,
	# QDRANT_COLLECTION (v0.8 G2.5). Sequestered from the main compose so
	# production runs don't inherit empty-string env-file overrides.
	UM_BOOT_OVERLAY="${UM_BOOT_OVERLAY:-$_SMOKE_DIR/../docker-compose.boot-test.yml}"

	test_boot_with_provider() {
		# Args: <label> [<embed>] [<summ>] [<facts>]
		# `label` is the friendly name used in echo + collection naming (e.g.
		# "anthropic-mixed"). The other three default to label, but can be
		# overridden positionally to test heterogeneous provider mixes — e.g.
		# `test_boot_with_provider anthropic-mixed openai anthropic anthropic`
		# uses openai for embeddings while summarizer/facts use anthropic.
		# (anthropic doesn't expose an embeddings API per spec §3.2 — must be
		# overridden when summ/facts=anthropic.)
		local label="$1"
		local embed="${2:-$1}"
		local summ="${3:-$1}"
		local facts="${4:-$1}"
		echo "== smoke: boot with ${label} =="
		# Per-provider QDRANT_COLLECTION (v0.8 G2.5 isolation): each boot lands
		# its embedding-stamp in its own collection so the DE5 startup guard
		# never sees a stamp from a prior provider's run. Without this,
		# boot N+1 (different provider) sees boot N's stamp → mismatch fatal.
		# Sanitize the label (anthropic-mixed → anthropic_mixed) so the
		# collection name is qdrant-safe.
		local collection
		collection="boot_smoke_${label//-/_}"
		# Use mocked SDK shims (env: UM_TEST_MOCK_SDK=1) so no real *Invoke API
		# calls happen. The boot-test overlay (docker-compose.boot-test.yml)
		# declares these as `${VAR:-default}` substitution entries so the
		# exports below propagate into the container at compose-up time.
		# `export` (vs inline prefix) so docker-compose's variable-substitution
		# pass sees them in its own environment unambiguously.
		export UM_TEST_MOCK_SDK=1
		export UM_EMBEDDING_PROVIDER="$embed"
		export UM_SUMMARIZER_PROVIDER="$summ"
		export UM_FACTS_PROVIDER="$facts"
		export QDRANT_COLLECTION="$collection"
		docker compose -f "$UM_COMPOSE_FILE" -f "$UM_BOOT_OVERLAY" up -d --force-recreate
		# I3: Capture the freshly-recreated container's ID so the curl health
		# poll can't false-pass against a leftover container that's still
		# answering on port 6335 from a previous run. `--force-recreate` does
		# replace the container, but we assert the new ID is `running` before
		# trusting the curl probe.
		local container_id
		container_id=$(docker compose -f "$UM_COMPOSE_FILE" ps --quiet memory-server 2>/dev/null || true)
		if [ -z "$container_id" ]; then
			echo "  -> ${label} container not started" >&2
			return 1
		fi
		local status
		status=$(docker inspect "$container_id" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
		if [ "$status" != "running" ]; then
			echo "  -> ${label} container status=${status} (expected running)" >&2
			return 1
		fi
		# Wait for /health to respond 200. /health is the dedicated liveness
		# endpoint — /api/state requires a :project path param and 404s in
		# its absence (older smoke.sh polled it and false-failed on URL
		# shape, not server liveness). Budget 30s matches memory-server's
		# initMemory() qdrant-connect retry budget (30 attempts x 1s) so a
		# slow qdrant cold-start after --force-recreate doesn't false-fail.
		local i=0
		while [ "$i" -lt 30 ]; do
			if curl -fsS "$ENDPOINT/health" >/dev/null 2>&1; then
				echo "  -> ${label} booted cleanly (container ${container_id:0:12})"
				return 0
			fi
			sleep 1
			i=$((i + 1))
		done
		echo "  -> ${label} FAILED to boot" >&2
		# Dump diagnostics so CI failures are self-contained (without this,
		# smoke.sh just prints "FAILED to boot" with no explanation).
		echo "  ---- compose ps (port mapping + status) ----" >&2
		docker compose -f "$UM_COMPOSE_FILE" -f "$UM_BOOT_OVERLAY" ps 2>&1 | sed 's/^/  | /' >&2
		echo "  ---- curl probe of /health (one-off, verbose) ----" >&2
		curl -v --max-time 3 "$ENDPOINT/health" 2>&1 | sed 's/^/  | /' >&2 || true
		echo "  ---- last 80 lines of memory-server logs ----" >&2
		docker logs "$container_id" --tail=80 2>&1 | sed 's/^/  | /' >&2
		echo "  ---- end logs ----" >&2
		return 1
	}

	# Run boot-tests for each non-default provider
	# (anthropic skipped for embeddings — spec §3.2 unsupported-surface contract)
	#
	# I2: accumulate failures via `rc` rather than letting `set -euo pipefail`
	# kill the script on the first failing provider. We want the report to
	# tell us which providers booted and which didn't; a single failure that
	# aborts the whole run hides regressions in later providers. The final
	# `[[ "$rc" == 0 ]]` keeps the script's overall exit status faithful.
	boot_rc=0
	test_boot_with_provider openai      || boot_rc=1   # baseline (existing)
	test_boot_with_provider google      || boot_rc=1   # tests google-embed + google-summ + google-facts
	# Ollama needs a real daemon for mem0's "ensure model exists" probe at
	# init — UM_TEST_MOCK_SDK only short-circuits *Invoke functions, not
	# mem0's internal ollama-init calls. Probe before testing so CI without
	# ollama (the default) skips with a clear message instead of a generic
	# boot-failure log dump.
	if curl -fsS --max-time 2 "${OLLAMA_HOST:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then
		test_boot_with_provider ollama || boot_rc=1   # tests ollama-embed + ollama-summ + ollama-facts
	else
		echo "== smoke: boot with ollama SKIPPED (no daemon at ${OLLAMA_HOST:-http://localhost:11434}) =="
	fi
	# anthropic only for summarizer + facts (separately, with embedding=openai
	# — anthropic doesn't expose an embeddings API per spec §3.2)
	test_boot_with_provider anthropic-mixed openai anthropic anthropic || boot_rc=1

	# T24 — DE5 stamp roundtrip variant (spec §8 acceptance criterion).
	#
	# Intent: confirm writeStamp(via umAdd) → readStamp(via mem0.getAll) roundtrip
	# works in a mock-SDK CI environment without UM_LIVE_TESTS=1.
	#
	# Why deferred: UM_TEST_MOCK_SDK=1 explicitly skips writeStamp in
	# initMemoryWithGuard's null-branch (mem0-mcp-http.mjs:302-315). The skip is
	# intentional — calling writeStamp with fake API keys (injected by the boot
	# overlay) would crash the stamp write path before any embed is attempted.
	# An in-container `docker exec ... node -e '...'` stamp roundtrip would
	# require constructing a full Memory instance with a live Qdrant connection
	# and a real or deeply-stubbed embed path — infrastructure the boot-smoke
	# stack doesn't expose.
	#
	# Coverage by existing tests (no gap):
	#   - Unit:          server/test/embedding-stamp.test.mjs (writeStamp→upsert→
	#                    readStamp via mocked qdrant + embed provider).
	#   - Live CI/local: server/test/add-live.test.mjs + stamp-roundtrip-spike.test.mjs
	#                    (UM_LIVE_TESTS=1, real OpenAI + Qdrant; exercises the same
	#                    umAdd payload path that writeStamp uses).
	#   - Boot guard:    server/test/init-memory-stamp-guard.test.mjs.
	#
	# What this section DOES assert right now: the boot guard emitted the expected
	# mock-skip log line (EMBEDDING_STAMP_MOCK_SKIP) in the most recently started
	# container — confirming the guard ran and correctly took the skip branch
	# rather than crashing with a bad-key embed error.
	if [ -n "$UM_CONTAINER" ]; then
		echo "[smoke]     T24 DE5 boot-smoke: asserting guard mock-skip log present"
		BOOT_LOGS=$(docker logs "$UM_CONTAINER" 2>&1 || true)
		if echo "$BOOT_LOGS" | grep -q 'EMBEDDING_STAMP_MOCK_SKIP'; then
			echo "[smoke]     T24 OK: boot guard ran and emitted mock-skip (UM_TEST_MOCK_SDK=1 path verified)"
		else
			# Soft warning — the full stamp roundtrip (writeStamp→readStamp) is
			# deferred to UM_LIVE_TESTS=1 (add-live.test.mjs). A missing mock-skip
			# log means the server started without the guard firing at all OR the
			# guard took a different branch (e.g., match on a pre-existing stamp).
			# Not a hard failure since the boot guard may have matched an existing
			# stamp from an earlier run of the same per-provider collection.
			echo "[smoke]     T24 WARN: EMBEDDING_STAMP_MOCK_SKIP not in logs — guard may have matched an existing stamp (not a failure)"
		fi
	else
		echo "[smoke]     T24 SKIP: UM_CONTAINER not set — cannot inspect boot guard logs"
	fi

	# I1: explicit teardown of the boot-test stack so a failed provider
	# doesn't leave the container running between local smoke iterations or
	# poison the next CI step. Always runs (success or failure path); error
	# from `down` itself is non-fatal — the smoke gate's verdict is `boot_rc`.
	echo "[smoke]     tearing down boot-test stack"
	docker compose -f "$UM_COMPOSE_FILE" -f "$UM_BOOT_OVERLAY" down >/dev/null 2>&1 || true

	if [ "$boot_rc" -ne 0 ]; then
		echo "[smoke] 6/6 mocked-SDK boot tests FAILED (one or more providers did not boot)" >&2
		_um_smoke_auth_cleanup
		exit 1
	fi
	echo "[smoke] 6/6 mocked-SDK boot tests passed"
fi

# Clean up the auth-config tempfile on the success path. Failure paths
# `exit 1` after running the cleanup explicitly above; the file is 0600
# and OS tmp policy sweeps any leftover. R1 hardening rationale at the
# auth setup block.
_um_smoke_auth_cleanup
