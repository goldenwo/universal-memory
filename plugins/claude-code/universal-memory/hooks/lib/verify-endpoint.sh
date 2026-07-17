#!/bin/bash
# hooks/lib/verify-endpoint.sh — shared endpoint verification for the installer
# remote flow (install.sh --remote, #159 T7) and the plugin-bundled first-run
# setup (hooks/um-setup.sh, T8). Sourced, not executed. Deliberately
# STANDALONE (no um-api.sh dependency): both callers verify an endpoint/token
# pair BEFORE any config exists, so nothing here reads ~/.um/* or env tiers.
#
# um_verify_endpoint <endpoint> [token]
#   1. GET <endpoint>/health           — reachability + "is this a UM server"
#   2. POST <endpoint>/api/append-turn — authed WRITE probe with an empty JSON
#      body (spec §7). The server checks auth → writes gate → validation in
#      that order (same semantic as session-start.sh's G7 probe), so the empty
#      body is side-effect-free and the code is diagnostic:
#        400 / 2xx → HEALTHY (validation rejected the empty body AFTER the
#                    write gate passed; nothing written)
#        403       → writes disabled (UM_MCP_WRITE_ENABLED=false)   [A8]
#        401       → auth/token problem
#        404 / other 4xx → server predates the /api capture routes ("too old")
#        429       → transient remote rate limit
#        3xx       → redirecting endpoint (curl runs without -L everywhere in
#                    the plugin) — configure the final URL directly
#        5xx       → server-side error (flag-true + ro-mount misconfig lands
#                    here as EROFS — NOT 403; message says mount/logs)
#        000       → unreachable                                     [G7/A5]
#   Prints one actionable message per failure branch to stderr and returns:
#     0 healthy · 1 unreachable/unhealthy · 2 writes-disabled · 3 auth ·
#     4 server-too-old · 5 server-error · 6 rate-limited · 7 redirect
#
# Timeouts match um-api.sh's wire contract: connect 3s, total 10s.

# Same default as um-api.sh's UM_DOCS_LINK (env-overridable; kept literal here
# so this file stays sourceable with no siblings).
UM_VERIFY_DOCS_LINK="${UM_DOCS_LINK:-https://github.com/goldenwo/universal-memory/blob/main/docs/claude-code-plugin.md}"

# _um_verify_http_code <method> <url> <token> [body]
# Prints the HTTP status code ('000' on transport failure). Never fails.
_um_verify_http_code() {
  local method="$1" url="$2" token="$3" body="${4:-}"
  local -a args=(
    -s -o /dev/null -w '%{http_code}'
    --connect-timeout 3 --max-time 10
    -H 'Content-Type: application/json'
    -H 'X-UM-Source: claude-code-plugin'
  )
  if [ "$method" = "POST" ]; then
    args+=(-X POST -d "$body")
  fi
  if [ -n "$token" ]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  local code
  code=$(curl "${args[@]}" "$url" 2>/dev/null) || true
  printf '%s' "${code:-000}"
}

um_verify_endpoint() {
  local endpoint="${1%/}" token="${2:-}"
  local code

  # 1. Reachability: GET /health
  code=$(_um_verify_http_code GET "$endpoint/health" "$token")
  case "$code" in
    2[0-9][0-9]) : ;;
    000)
      printf '✗ UM server unreachable at %s — connection failed.\n  Check the URL, that the server is running, and any tunnel/firewall in between.\n  See %s\n' \
        "$endpoint" "$UM_VERIFY_DOCS_LINK" >&2
      return 1
      ;;
    *)
      printf '✗ %s answered HTTP %s on /health — that does not look like a healthy UM server.\n  Check the URL (port/path) and the server logs.\n' \
        "$endpoint" "$code" >&2
      return 1
      ;;
  esac

  # 2. Authed write probe: POST /api/append-turn with an empty JSON body.
  code=$(_um_verify_http_code POST "$endpoint/api/append-turn" "$token" '{}')
  case "$code" in
    400 | 2[0-9][0-9])
      # Healthy: reachable, authed, writes enabled — validation rejected the
      # empty probe body after the write gate passed; nothing was written.
      return 0
      ;;
    403)
      printf '✗ Server reachable, but writes are DISABLED (HTTP 403) — captures would be dead.\n  On the server, set UM_MCP_WRITE_ENABLED=true (and UM_MOUNT_MODE=rw) and restart, then re-run.\n  See %s\n' \
        "$UM_VERIFY_DOCS_LINK" >&2
      return 2
      ;;
    401)
      printf '✗ Server rejected the token (HTTP 401).\n  Check the auth token (server-side UM_AUTH_TOKEN) and re-run with the correct one.\n' >&2
      return 3
      ;;
    429)
      printf '✗ Server rate-limited the probe (HTTP 429) — transient.\n  Wait a minute and re-run.\n' >&2
      return 6
      ;;
    4[0-9][0-9])
      printf '✗ Server is too old — HTTP %s on /api/append-turn means it predates the /api capture routes.\n  Upgrade the server to the minimum version stated in the plugin README, then re-run.\n' \
        "$code" >&2
      return 4
      ;;
    000)
      printf '✗ UM server unreachable at %s — connection failed during the write probe.\n  Check the URL, that the server is running, and any tunnel/firewall in between.\n  See %s\n' \
        "$endpoint" "$UM_VERIFY_DOCS_LINK" >&2
      return 1
      ;;
    3[0-9][0-9])
      # The probes run curl without -L, and every capture hook does too — a
      # redirecting endpoint means every capture dies on the redirect.
      printf '✗ Endpoint redirects (HTTP %s) — configure the final URL (e.g. the https form) directly.\n' \
        "$code" >&2
      return 7
      ;;
    *)
      printf '✗ Server-side error on the write probe (HTTP %s).\n  Writes may be misconfigured: check the vault mount (UM_MOUNT_MODE=rw — a read-only mount fails with EROFS here, not 403) and the server logs.\n' \
        "$code" >&2
      return 5
      ;;
  esac
}
