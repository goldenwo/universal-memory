#!/bin/bash
# auto-start.sh — universal-memory auto-start probe for Claude Code.
# (#159 T6b, spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §4–§5)
#
# Behavior:
#   - Config gate uses the COMPOSED resolution (um-api.sh §4 tiers): env
#     (UM_SERVER_URL / deprecated UM_ENDPOINT) → ~/.um/endpoint file. If
#     neither is present: exit 0 silently — plugin not configured. (A
#     file-tier-only install must not look "unconfigured", spec §5.)
#   - Probe /health with a short timeout against the resolved endpoint.
#   - If reachable: exit 0 silently. Nothing to do.
#   - If unreachable AND the resolved endpoint is REMOTE (host is not
#     localhost/127.0.0.1/[::1]): never auto-start a local server — log a
#     one-line diagnostic and exit 0. Remote servers start on their host.
#   - If unreachable AND UM_COMPOSE_DIR is set + valid:
#       single-flight guard (lock dir + already-listening re-probe, spec §5 —
#       under API-always this hook fires on more sessions, and two
#       near-simultaneous session-starts must spawn at most one server),
#       then `docker compose up -d` there, poll /health (up to 60s).
#   - If unreachable AND UM_COMPOSE_DIR is unset: exit 0 with a one-line
#     note. Only users running the server locally via Docker will want to
#     set UM_COMPOSE_DIR.
#
# Fail-soft: never exit non-zero. We do not want to block session start.
#
# Optional env:
#   UM_COMPOSE_DIR      Directory containing docker-compose.yml for the server.
#                       If set, auto-start runs compose there when endpoint is down.
#   UM_LIB_DIR          Override for the lib dir (default: plugin-local hooks/lib,
#                       else the standalone-install ~/.local/share/um/lib).

set -uo pipefail

: "${UM_COMPOSE_DIR:=}"

log() { printf '[um-autostart] %s\n' "$*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate um-api.sh: explicit UM_LIB_DIR wins, then the plugin-local lib next
# to this script, then the standalone-install default. Fail-soft env-only
# fallback below covers partial installs where um-api.sh is absent.
_UM_API_SH=""
for _cand in \
  "${UM_LIB_DIR:+$UM_LIB_DIR/um-api.sh}" \
  "$SCRIPT_DIR/lib/um-api.sh" \
  "$HOME/.local/share/um/lib/um-api.sh"; do
  [ -n "$_cand" ] && [ -r "$_cand" ] && { _UM_API_SH="$_cand"; break; }
done

if [ -n "$_UM_API_SH" ]; then
  # shellcheck source=lib/um-api.sh
  source "$_UM_API_SH"
  um_api_configured || exit 0
  endpoint=$(um_api_endpoint)
else
  # Fail-soft fallback (um-api.sh not deployed): env tiers only.
  [ -z "${UM_SERVER_URL:-}${UM_ENDPOINT:-}" ] && exit 0
  endpoint="${UM_SERVER_URL:-${UM_ENDPOINT:-}}"
fi

if curl -sf --max-time 2 "$endpoint/health" >/dev/null 2>&1; then
    exit 0
fi

# ---------------------------------------------------------------------------
# Remote gate (spec §5): never docker-compose a LOCAL server to satisfy a
# REMOTE endpoint. Host extraction handles ports and bracketed IPv6.
# ---------------------------------------------------------------------------
_host="${endpoint#*://}"
_host="${_host%%/*}"
case "$_host" in
  \[*) _host="${_host%%]*}]" ;;   # [::1]:6335 → [::1]
  *)   _host="${_host%%:*}"  ;;   # localhost:6335 → localhost
esac
case "$_host" in
  localhost|127.0.0.1|\[::1\]|::1) ;;
  *)
    log "endpoint $endpoint is remote ($_host) and not reachable — not auto-starting a local server."
    log "(start the server on its host, or fix the endpoint config.)"
    exit 0
    ;;
esac

if [ -z "$UM_COMPOSE_DIR" ]; then
    log "server at $endpoint not reachable — session will continue without memory."
    log "(local Docker users: set UM_COMPOSE_DIR to enable auto-start.)"
    exit 0
fi

if [ ! -f "$UM_COMPOSE_DIR/docker-compose.yml" ]; then
    log "UM_COMPOSE_DIR=$UM_COMPOSE_DIR has no docker-compose.yml; skipping auto-start"
    exit 0
fi

# ---------------------------------------------------------------------------
# Single-flight guard (spec §5): atomic mkdir lock so two near-simultaneous
# session-starts spawn at most one server. A lock older than 5 minutes is
# stale (a healthy start completes well within the 60s poll) and is stolen.
# ---------------------------------------------------------------------------
LOCK_DIR="$HOME/.um/state/auto-start.lock"
mkdir -p "$HOME/.um/state" 2>/dev/null || true
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
        if ! mkdir "$LOCK_DIR" 2>/dev/null; then
            log "another auto-start is already starting the server; skipping"
            exit 0
        fi
    else
        log "another auto-start is already starting the server; skipping"
        exit 0
    fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Already-listening re-probe: the flight we raced with may have just
# finished bringing the server up.
if curl -sf --max-time 2 "$endpoint/health" >/dev/null 2>&1; then
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
