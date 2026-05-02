#!/bin/bash
# scripts/check-no-mem0-add.sh — fail CI if mem0's .add() reappears.
# v0.8 G2 replaced all such calls with umAdd. Reintroducing one bypasses
# orchestrator metric emission — exactly the contract gap v0.8 G2 closed.
set -euo pipefail

# Patterns matching the §11 grep snapshot. Each is a forbidden form.
PATTERNS=(
  'memory\.add\b'
  'memoryClient\.add\b'
  'resolvedMemory\(\)\.add\b'
  'newMemory\.add\b'
)

# Files to scan: server/ and cli/. Exclude:
#   - server/lib/add.mjs (defines the replacement)
#   - server/lib/embedding-stamp.mjs (uses umAdd internally)
#   - test files (mocks may reference the symbol name)
SCAN_DIRS=(server cli)
EXCLUDES=(
  ':!server/lib/add.mjs'
  ':!**/test/**'
  ':!**/*.test.mjs'
)

found=0
for pattern in "${PATTERNS[@]}"; do
  hits=$(git grep -nE "$pattern" -- "${SCAN_DIRS[@]}" "${EXCLUDES[@]}" || true)
  if [ -n "$hits" ]; then
    echo "FAIL: forbidden pattern '$pattern' reappeared in production code:"
    echo "$hits"
    found=1
  fi
done

if [ $found -ne 0 ]; then
  echo ""
  echo "v0.8 G2 replaced all mem0.add() call sites with umAdd from server/lib/add.mjs."
  echo "If you need to add a new write path, use umAdd. Discussion: spec §5."
  exit 1
fi
echo "OK: no mem0.add() / memoryClient.add() / resolvedMemory().add() / newMemory.add() in server/ or cli/"
