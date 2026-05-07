#!/usr/bin/env bash
# V1 fixture-prep — run AFTER you've used Claude Code with claude-mem for ≥1 session.
#
# What this does:
#   1. Locates the real ~/.claude-mem/claude-mem.db (NOTE: spec called it sessions.db,
#      but claude-mem 12.3.9 actually names it claude-mem.db — see V1-claude-mem-schema.md §3)
#   2. Dumps .schema to docs/research/2026-04-24-v0.6-verifications/claude-mem-schema.sql
#   3. Copies DB to server/test/fixtures/claude-mem-sessions-v<version>.db
#   4. PII-scrubs free-text columns on the copy so fixtures are safe to commit
#
# On this Windows dev box sqlite3 CLI is NOT installed, so the script prefers sqlite3
# if available and falls back to Python 3's sqlite3 stdlib module otherwise.
# (Node + better-sqlite3 is a further fallback if you want it — see §4 of the doc.)

set -euo pipefail

DB="$HOME/.claude-mem/claude-mem.db"
# Derive REPO_ROOT from git so the script works on any clone, not just the
# original author's box. Falls back to a relative-path resolution if git is
# unavailable (e.g. archived tarball without .git).
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../../.." && pwd))"
FIXTURES_DIR="$REPO_ROOT/server/test/fixtures"
RESEARCH_DIR="$REPO_ROOT/docs/research/2026-04-24-v0.6-verifications"
SCHEMA_OUT="$RESEARCH_DIR/claude-mem-schema.sql"

VERSION="$(claude-mem --version 2>/dev/null || echo unknown)"
OUT_DB="$FIXTURES_DIR/claude-mem-sessions-v${VERSION}.db"

if [ ! -f "$DB" ]; then
  echo "FAIL: $DB not found."
  echo "      Open Claude Code with claude-mem installed, have a short conversation,"
  echo "      then re-run this script. See V1-claude-mem-schema.md §4 Step A."
  exit 1
fi

mkdir -p "$FIXTURES_DIR"

# ---- Pick a SQLite driver --------------------------------------------------
SQLITE_MODE=""
if command -v sqlite3 >/dev/null 2>&1; then
  SQLITE_MODE="cli"
elif command -v python >/dev/null 2>&1 && python -c "import sqlite3" 2>/dev/null; then
  SQLITE_MODE="python"
elif command -v python3 >/dev/null 2>&1 && python3 -c "import sqlite3" 2>/dev/null; then
  SQLITE_MODE="python3"
else
  echo "FAIL: neither sqlite3 CLI nor a Python with sqlite3 is available."
  echo "      Options:"
  echo "        - winget install SQLite.SQLite           (adds sqlite3 to PATH)"
  echo "        - or: npm install -g better-sqlite3-cli  (Node-based alternative)"
  exit 2
fi
echo "Using SQLite driver: $SQLITE_MODE"

# ---- 1. Dump schema --------------------------------------------------------
echo "Dumping schema → $SCHEMA_OUT"
case "$SQLITE_MODE" in
  cli)
    sqlite3 "$DB" ".schema" > "$SCHEMA_OUT"
    ;;
  python|python3)
    PY="$SQLITE_MODE"
    "$PY" - "$DB" "$SCHEMA_OUT" <<'PYEOF'
import sqlite3, sys
db_path, out_path = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db_path)
cur = con.cursor()
rows = cur.execute(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"
).fetchall()
with open(out_path, "w", encoding="utf-8") as f:
    for (sql,) in rows:
        f.write(sql.rstrip() + ";\n")
con.close()
PYEOF
    ;;
esac

# ---- 2. Copy DB for fixture ------------------------------------------------
echo "Copying DB → $OUT_DB"
cp "$DB" "$OUT_DB"

# ---- 3. PII scrub on the copy ---------------------------------------------
# Real claude-mem 12.3.9 column names (see V1-claude-mem-schema.md §5):
#   sessions.metadata_json
#   overviews.content              ← the "summary"
#   memories.text, .title, .subtitle, .concepts, .files_touched
#   streaming_sessions.title, .subtitle, .user_prompt
# We leave ids, project names, and timestamps intact (structural fixture data),
# and redact every free-text field. "warn:" on any one table means that table
# didn't exist in the observed DB (likely migration skew) — surface it but keep going.

scrub() {
  local table="$1"; shift
  local cols=("$@")
  local setlist=""
  for c in "${cols[@]}"; do
    [ -n "$setlist" ] && setlist="$setlist, "
    setlist="$setlist$c = '[redacted for fixture]'"
  done
  local sql="UPDATE $table SET $setlist WHERE 1=1;"

  case "$SQLITE_MODE" in
    cli)
      sqlite3 "$OUT_DB" "$sql" || echo "warn: scrub on $table failed (table absent?)"
      ;;
    python|python3)
      PY="$SQLITE_MODE"
      "$PY" - "$OUT_DB" "$sql" <<'PYEOF' || echo "warn: scrub failed"
import sqlite3, sys
db_path, sql = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db_path)
try:
    con.execute(sql)
    con.commit()
except sqlite3.OperationalError as e:
    print(f"warn: {e}", file=sys.stderr)
    sys.exit(3)
finally:
    con.close()
PYEOF
      ;;
  esac
}

echo "Scrubbing PII on fixture copy…"
scrub sessions            metadata_json
scrub overviews           content
scrub memories            text title subtitle concepts files_touched
scrub streaming_sessions  title subtitle user_prompt

echo
echo "DONE:"
echo "  fixture    $OUT_DB"
echo "  schema     $SCHEMA_OUT"
echo
echo "Next:"
echo "  1. Review both files."
echo "  2. Update V1-claude-mem-schema.md §3 (real schema) and §5 (confirmed columns)."
echo "  3. Commit per §4 Step D of V1-claude-mem-schema.md."
