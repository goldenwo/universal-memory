#!/usr/bin/env bash
# installer/lib/endpoint.sh — shared `UM_SERVER_URL` / `UM_ENDPOINT` resolver.
#
# Single source of truth for endpoint resolution across hooks, CLI, marker
# block, and the v1.1 `create-adr` skill. Sourced (NOT executed); defines:
#
#   um_resolve_endpoint   — prints the canonical endpoint URL on stdout;
#                           emits a deprecation warn on stderr if the legacy
#                           `UM_ENDPOINT` is the only one set, OR if both
#                           are set with different values.
#
# Background: through v1.0, hooks read `UM_ENDPOINT` while CLI + marker
# block used `UM_SERVER_URL`. v1.1 consolidates to `UM_SERVER_URL` (the
# marker block's canonical name per W6.4 review).
# `UM_ENDPOINT` stays respected with a deprecation warn for one minor
# version; v1.2 removes the fallback.
#
# Per spec `docs/plans/2026-05-08-v1.1-plan.md` §W1.5 (paired-Opus
# converged after 11 review rounds). MIGRATION.md `## v1.0 → v1.1` has
# the operator-facing rename instructions.

# um_endpoint_configured
# Returns 0 if EITHER UM_SERVER_URL or UM_ENDPOINT is set to a non-empty
# value (plugin is configured), or 1 otherwise (plugin not configured —
# hooks should exit 0 silently per existing v0.1+ behavior).
# Distinct from um_resolve_endpoint, which returns a default fallback
# even when nothing is set; hooks need to distinguish "configured to
# loopback default" from "not configured at all."
um_endpoint_configured() {
  [ -n "${UM_SERVER_URL:-}" ] || [ -n "${UM_ENDPOINT:-}" ]
}

# um_resolve_endpoint
# Prints the canonical endpoint URL to stdout. Warns on stderr for any
# deprecation-relevant config. Default fallback: http://localhost:6335
# (matches v0.1 default; preserved across v1.x).
um_resolve_endpoint() {
  local default_url="http://localhost:6335"
  local server_url="${UM_SERVER_URL:-}"
  local endpoint="${UM_ENDPOINT:-}"

  if [ -n "$server_url" ]; then
    if [ -n "$endpoint" ] && [ "$endpoint" != "$server_url" ]; then
      printf 'warning: UM_ENDPOINT and UM_SERVER_URL both set with different values; using UM_SERVER_URL=%s. UM_ENDPOINT is deprecated, remove it (will be removed in v1.2).\n' \
        "$server_url" >&2
    fi
    printf '%s\n' "$server_url"
    return 0
  fi

  if [ -n "$endpoint" ]; then
    printf 'warning: UM_ENDPOINT is deprecated; rename to UM_SERVER_URL. Will be removed in v1.2 (see MIGRATION.md).\n' >&2
    printf '%s\n' "$endpoint"
    return 0
  fi

  printf '%s\n' "$default_url"
}
