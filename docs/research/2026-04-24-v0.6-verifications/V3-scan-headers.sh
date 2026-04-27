#!/usr/bin/env bash
# V3 — scan captured CC headers for forbidden forwarded/proxy headers
LOG="${1:-/tmp/cc-headers.log}"
[ -f "$LOG" ] || { echo "FAIL: $LOG not found. Run echo-headers-server.mjs + a CC session first."; exit 1; }

FORBIDDEN='x-forwarded-for|x-forwarded-host|x-forwarded-proto|x-real-ip|forwarded|via|cf-connecting-ip|true-client-ip|tailscale-user-login|tailscale-user-name'

echo "=== Requests logged ==="
wc -l "$LOG"

echo ""
echo "=== All unique header keys across all requests ==="
jq -r '.headers | keys[]' "$LOG" | sort -u

echo ""
echo "=== Grep for FORBIDDEN headers (case-insensitive) ==="
if grep -Ei "$FORBIDDEN" "$LOG"; then
  echo ""
  echo "VERDICT: FORBIDDEN headers detected — loopback bypass rule may break CC plugin calls. Escalate."
  exit 2
else
  echo "(none found)"
  echo ""
  echo "VERDICT: CC emits no forwarded headers. Loopback bypass is safe for CC plugin."
fi
