#!/bin/bash
# auto-start.sh — universal-memory auto-start probe for Claude Code.
#
# Behavior:
#   - If neither UM_SERVER_URL nor UM_ENDPOINT is set: exit 0 silently.
#     Plugin not configured.
#   - Probe /health with a short timeout against the resolved endpoint.
#   - If reachable: exit 0 silently. Nothing to do.
#   - If unreachable AND UM_COMPOSE_DIR is set + valid:
#       run `docker compose up -d` there, poll /health (up to 60s), log progress.
#   - If unreachable AND UM_COMPOSE_DIR is unset: exit 0 with a one-line
#     note. Only users running the server locally via Docker will want to
#     set UM_COMPOSE_DIR; remote self-host users leave it unset.
#
# Fail-soft: never exit non-zero. We do not want to block session start.
#
# Required env (one of):
#   UM_SERVER_URL       Memory server URL (canonical, v1.1+)
#   UM_ENDPOINT         Same role; deprecated in v1.1, removed in a future release.
#
# Optional env:
#   UM_COMPOSE_DIR      Directory containing docker-compose.yml for the server.
#                       If set, auto-start runs compose there when endpoint is down.
#   UM_LIB_DIR          Override for the lib dir (default: ~/.local/share/um/lib).

set -uo pipefail

: "${UM_SERVER_URL:=}"
: "${UM_ENDPOINT:=}"
: "${UM_COMPOSE_DIR:=}"

log() { printf '[um-autostart] %s\n' "$*" >&2; }

# v1.1: source the shared endpoint resolver. Falls back to inline resolution
# if the lib file is absent (pre-v1.1 install). Resolver emits a deprecation
# warn on stderr if UM_ENDPOINT is the only one set.
_UM_ENDPOINT_SH="${UM_LIB_DIR:-$HOME/.local/share/um/lib}/endpoint.sh"
if [ -r "$_UM_ENDPOINT_SH" ]; then
  # shellcheck source=lib/endpoint.sh
  source "$_UM_ENDPOINT_SH"
  um_endpoint_configured || exit 0
  endpoint=$(um_resolve_endpoint)
else
  # Fail-soft fallback for pre-v1.1 installs where endpoint.sh isn't deployed.
  [ -z "$UM_SERVER_URL$UM_ENDPOINT" ] && exit 0
  endpoint="${UM_SERVER_URL:-$UM_ENDPOINT}"
fi

if curl -sf --max-time 2 "$endpoint/health" >/dev/null 2>&1; then
    exit 0
fi

if [ -z "$UM_COMPOSE_DIR" ]; then
    log "server at $endpoint not reachable — session will continue without memory."
    log "(local Docker users: set UM_COMPOSE_DIR to enable auto-start. remote users: start the server on its host.)"
    exit 0
fi

if [ ! -f "$UM_COMPOSE_DIR/docker-compose.yml" ]; then
    log "UM_COMPOSE_DIR=$UM_COMPOSE_DIR has no docker-compose.yml; skipping auto-start"
    exit 0
fi

log "server unreachable at $endpoint — running docker compose up -d in $UM_COMPOSE_DIR"
if ! ( cd "$UM_COMPOSE_DIR" && docker compose up -d >/dev/null 2>&1 ); then
    log "docker compose up failed; check 'docker compose logs' in $UM_COMPOSE_DIR"
    exit 0
fi

for i in $(seq 1 30); do
    if curl -sf --max-time 2 "$endpoint/health" >/dev/null 2>&1; then
        log "server started in ~$(( i * 2 ))s"
        exit 0
    fi
    sleep 2
done

log "compose up succeeded but /health didn't respond within 60s; session continuing anyway"
exit 0
