#!/bin/bash
# auto-start.sh — universal-memory auto-start probe for Claude Code.
#
# Behavior:
#   - If UM_ENDPOINT unset: exit 0 silently. Plugin not configured.
#   - Probe /health with a short timeout.
#   - If reachable: exit 0 silently. Nothing to do.
#   - If unreachable AND UM_COMPOSE_DIR is set + valid:
#       run `docker compose up -d` there, poll /health (up to 60s), log progress.
#   - If unreachable AND UM_COMPOSE_DIR is unset: exit 0 silently with a
#     one-line note that auto-start is available but unconfigured.
#
# Fail-soft: never exit non-zero. We do not want to block session start.
#
# Required env:
#   UM_ENDPOINT         Memory server URL (e.g., http://localhost:6335)
#
# Optional env:
#   UM_COMPOSE_DIR      Directory containing docker-compose.yml for the server.
#                       If set, auto-start runs compose there when endpoint is down.

set -uo pipefail

: "${UM_ENDPOINT:=}"
: "${UM_COMPOSE_DIR:=}"

log() { printf '[um-autostart] %s\n' "$*" >&2; }

[ -z "$UM_ENDPOINT" ] && exit 0

if curl -sf --max-time 2 "$UM_ENDPOINT/health" >/dev/null 2>&1; then
    exit 0
fi

if [ -z "$UM_COMPOSE_DIR" ]; then
    log "server at $UM_ENDPOINT not reachable; set UM_COMPOSE_DIR to enable auto-start"
    exit 0
fi

if [ ! -f "$UM_COMPOSE_DIR/docker-compose.yml" ]; then
    log "UM_COMPOSE_DIR=$UM_COMPOSE_DIR has no docker-compose.yml; skipping auto-start"
    exit 0
fi

log "server unreachable at $UM_ENDPOINT — running docker compose up -d in $UM_COMPOSE_DIR"
if ! ( cd "$UM_COMPOSE_DIR" && docker compose up -d >/dev/null 2>&1 ); then
    log "docker compose up failed; check 'docker compose logs' in $UM_COMPOSE_DIR"
    exit 0
fi

for i in $(seq 1 30); do
    if curl -sf --max-time 2 "$UM_ENDPOINT/health" >/dev/null 2>&1; then
        log "server started in ~$(( i * 2 ))s"
        exit 0
    fi
    sleep 2
done

log "compose up succeeded but /health didn't respond within 60s; session continuing anyway"
exit 0
