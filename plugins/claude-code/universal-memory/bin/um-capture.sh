#!/usr/bin/env bash
# um-capture.sh — thin dispatcher wrapper around bin/um-capture (fs-direct binary, A.1).
# Called via `um capture ...` → dispatcher → this file → exec um-capture "$@".
#
# This wrapper does NO parsing — args, stdin, stdout, and exit code all pass
# through unchanged via exec.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BINARY="$SCRIPT_DIR/um-capture"

if [ ! -x "$BINARY" ]; then
  echo "um-capture.sh: wrapped binary missing or not executable: $BINARY" >&2
  exit 1
fi

exec "$BINARY" "$@"
