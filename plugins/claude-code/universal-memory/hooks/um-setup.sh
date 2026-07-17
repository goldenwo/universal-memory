#!/usr/bin/env bash
# hooks/um-setup.sh — plugin-bundled first-run setup (#159 T8, spec §7).
#
# A marketplace install ships hooks but no config: install.sh --remote lives
# outside the plugin subtree and needs a repo checkout, which a marketplace
# user doesn't have. This script is the plugin's own self-contained setup —
# THE documented first-run step (`/um-setup` or a direct bash invocation):
#
#   1. Resolve endpoint + token (flags > env > TTY prompt > defaults).
#   2. Verify via the SHARED helper lib/verify-endpoint.sh (GET /health,
#      then an authed WRITE probe of POST /api/append-turn — the 6-branch
#      taxonomy distinguishes 403 writes-disabled / 401 auth / 404
#      server-too-old / 429 / 5xx mount-or-server / 000 unreachable).
#   3. On success ONLY, write the spec §4 file tier — ~/.um/endpoint +
#      ~/.um/auth-token (mode 600, umask 077, endpoint single line, token
#      file written only when a token was given) — the same conventions as
#      install.sh --remote. On failure: the helper's actionable message,
#      non-zero exit (the helper's taxonomy rc), NOTHING written.
#
# Non-interactive use (tests / scripted installs — minimal surface):
#   --endpoint URL   or  UM_SETUP_ENDPOINT   (default http://localhost:6335)
#   --token TOK      or  UM_SETUP_TOKEN      (empty is valid: loopback no-auth)
#
# NOT duplicated from install.sh --remote (inherently installer-specific):
# shell-profile marker-block editing and the local-vault repoint warning need
# a repo checkout / wizard context. This script instead WARNS when a
# UM_SERVER_URL / UM_ENDPOINT env export would shadow the just-written file
# tier (§4 precedence: env tiers 1–2 beat the file tier 3).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/verify-endpoint.sh
source "$SCRIPT_DIR/lib/verify-endpoint.sh"

usage() {
  cat <<'HELP'
universal-memory plugin setup (first run)

Usage: bash um-setup.sh [--endpoint URL] [--token TOKEN]

Verifies your UM server (health + an authed write probe) and, on success,
writes ~/.um/endpoint and ~/.um/auth-token (mode 600) so every plugin hook
resolves it. Prompts interactively when run on a TTY; otherwise uses
--endpoint/--token, UM_SETUP_ENDPOINT/UM_SETUP_TOKEN, or the loopback
default http://localhost:6335 with no token.
HELP
}

ENDPOINT="${UM_SETUP_ENDPOINT:-}"
TOKEN="${UM_SETUP_TOKEN-}"
TOKEN_GIVEN=0
[ -n "${UM_SETUP_TOKEN+x}" ] && TOKEN_GIVEN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint)
      [[ $# -gt 1 ]] || { echo "ERROR: --endpoint requires a URL." >&2; exit 1; }
      ENDPOINT="$2"; shift
      ;;
    --token)
      [[ $# -gt 1 ]] || { echo "ERROR: --token requires a value (may be '')." >&2; exit 1; }
      TOKEN="$2"; TOKEN_GIVEN=1; shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$1' (see --help)." >&2; exit 1 ;;
  esac
  shift
done

# Endpoint: flag/env > TTY prompt (default shown) > loopback default.
if [[ -z "$ENDPOINT" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "UM server URL [http://localhost:6335]: " ENDPOINT || true
  fi
  ENDPOINT="${ENDPOINT:-http://localhost:6335}"
fi
ENDPOINT="${ENDPOINT%/}"

# Token: flag/env (even empty) > TTY hidden prompt (empty OK for loopback
# no-auth) > empty.
if [[ $TOKEN_GIVEN -eq 0 && -t 0 ]]; then
  read -rs -p "Auth token (leave empty for loopback/no-auth): " TOKEN || true
  echo
fi
TOKEN="${TOKEN:-}"

echo "[um-setup] verifying UM server at $ENDPOINT ..."
verify_rc=0
um_verify_endpoint "$ENDPOINT" "$TOKEN" || verify_rc=$?
if [[ $verify_rc -ne 0 ]]; then
  echo "[um-setup] verification FAILED — no config written." >&2
  exit "$verify_rc"
fi
echo "[um-setup] server verified: reachable, authed, writes enabled."

# Config write (spec §4 file tier; same conventions as install.sh --remote).
# umask 077 closes the create-then-chmod window.
mkdir -p "$HOME/.um"
( umask 077; printf '%s\n' "$ENDPOINT" > "$HOME/.um/endpoint" )
chmod 600 "$HOME/.um/endpoint" 2>/dev/null || true
echo "[um-setup] wrote $HOME/.um/endpoint"
if [[ -n "$TOKEN" ]]; then
  ( umask 077; printf '%s\n' "$TOKEN" > "$HOME/.um/auth-token" )
  chmod 600 "$HOME/.um/auth-token" 2>/dev/null || true
  echo "[um-setup] wrote $HOME/.um/auth-token (600)"
elif [[ -f "$HOME/.um/auth-token" ]]; then
  echo "[um-setup] note: existing $HOME/.um/auth-token kept (no token given)."
fi

# §4 precedence: an env export SHADOWS the file tier just written.
for var in UM_SERVER_URL UM_ENDPOINT; do
  val="${!var:-}"
  if [[ -n "$val" && "${val%/}" != "$ENDPOINT" ]]; then
    echo "WARNING: \$$var is exported as '$val' in this environment — that env export SHADOWS the just-written ~/.um/endpoint. Update or remove it if you meant to use $ENDPOINT." >&2
  fi
done

cat <<DONE
[um-setup] done. Plugin hooks now resolve $ENDPOINT.
Next steps:
  - Start a new Claude Code session — the SessionStart hook injects your
    project's state; Stop/SessionEnd capture to the server automatically.
  - Watch ~/.um/hook.log for per-fire capture results.
  - If captures show as OFF, see the operator section (server flags
    UM_MCP_WRITE_ENABLED=true + UM_MOUNT_MODE=rw) in the plugin docs:
    ${UM_VERIFY_DOCS_LINK}
DONE
