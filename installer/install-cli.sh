#!/usr/bin/env bash
# install-cli.sh — back-compat shim. Real logic lives in install.sh with --cli.
# CRIT-2 safety (set -u with unset SHELL): fixed in install.sh via _sh="${SHELL:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/install.sh" --cli "$@"
