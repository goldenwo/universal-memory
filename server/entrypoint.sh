#!/bin/sh
# server/entrypoint.sh — defense-in-depth startup guard (#28).
#
# Refuses to start the server when ALL THREE conditions hold:
#   1. UM_MCP_WRITE_ENABLED=true   (server will accept write tools)
#   2. UM_MOUNT_MODE=rw            (vault is mounted read-write)
#   3. effective UID == 0          (container running as root)
#
# Together those mean an MCP write call could chown/chmod into a host-owned
# vault directory. The Dockerfile pins USER node, so the guard only fires when
# someone overrides with `docker run --user 0` or builds a derived image that
# strips USER. The fix is to set UM_CONTAINER_USER to a non-root UID:GID before
# `docker compose up`, e.g. UM_CONTAINER_USER="$(id -u):$(id -g)".
#
# Set UM_ENTRYPOINT_GUARD_DISABLE=1 to opt out (e.g. tests that intentionally
# exercise root). Document this only in server/README's Advanced section
# (E.11) so casual users don't see an easy bypass.

set -e

if [ "${UM_ENTRYPOINT_GUARD_DISABLE:-0}" != "1" ]; then
  uid="$(id -u 2>/dev/null || echo unknown)"
  if [ "${UM_MCP_WRITE_ENABLED:-false}" = "true" ] \
     && [ "${UM_MOUNT_MODE:-ro}" = "rw" ] \
     && [ "$uid" = "0" ]; then
    echo "[entrypoint] REFUSING TO START: container is running as root (uid=0)" >&2
    echo "[entrypoint]   with UM_MCP_WRITE_ENABLED=true AND UM_MOUNT_MODE=rw." >&2
    echo "[entrypoint]   MCP write tools could chown/chmod into the host vault." >&2
    echo "[entrypoint] Fix: set UM_CONTAINER_USER='\$(id -u):\$(id -g)' before" >&2
    echo "[entrypoint]   docker compose up. See server/README Advanced section." >&2
    exit 1
  fi
fi

exec "$@"
