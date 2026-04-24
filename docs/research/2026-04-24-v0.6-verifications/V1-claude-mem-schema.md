# V1 — claude-mem Schema & Fixture Prep

**Date:** 2026-04-24
**Cycle:** v0.6 Pre-1
**Spec ref:** §9.1 (Phase D bridge blocker; pulled forward to Week 1 per I4)
**Status:** WAITING FOR USER ACTION — non-interactive steps complete (package installed, plugin registered, schema inspected from source); real `claude-mem.db` only materializes after a real Claude Code session with claude-mem enabled, which is the user's manual step.

---

## 1. Package Identification

| Field | Value |
|-------|-------|
| **npm package name** | `claude-mem` (bare, unscoped — **not** `@anthropic/claude-mem` as guessed in the spec) |
| **Version installed** | `12.3.9` (latest as of 2026-04-22, published by `thedotmack`) |
| **License** | AGPL-3.0 |
| **Binary name** | `claude-mem` (exposes both installer CLI and runtime delegator) |
| **Install source** | npm registry → https://registry.npmjs.org/claude-mem |
| **Homepage / docs** | https://github.com/thedotmack/claude-mem#readme |
| **Repository** | https://github.com/thedotmack/claude-mem |
| **Author** | thedotmack <thedotmack@gmail.com> (third-party, not Anthropic) |

### Install command

```bash
npm install -g claude-mem
```

### Plugin registration (separate, non-interactive-safe)

After the npm install, claude-mem registers as a **Claude Code plugin** via a second command. This step clones `github.com/thedotmack/claude-mem` into `~/.claude/plugins/marketplaces/thedotmack/` and writes a marketplace entry to the user's Claude Code settings:

```bash
npx claude-mem install --ide claude-code
```

Supported IDE identifiers include: `claude-code`, `cursor`, `gemini-cli`, `opencode`, `openclaw`, `windsurf`, `codex-cli`, `copilot-cli`, `antigravity`, `goose`, `crush`, `roo-code`, `warp`.

### Runtime prerequisite

Per `claude-mem --help`: runtime commands (`start`, `stop`, `search`, `transcript watch`) delegate to the installed plugin and **require Bun**. The npm wrapper itself (install/update/version) works on Node alone. The bridge path will not use `claude-mem`'s runtime — it reads the SQLite DB directly — so Bun is not a hard dependency for UM's consumption.

## 2. Install Result

```
$ npm install -g claude-mem
added 153 packages in 4s

$ claude-mem --version
12.3.9

$ which claude-mem
/c/nvm4w/nodejs/claude-mem  (global npm bin via nvm4w on Windows 11)

$ npx claude-mem install --ide claude-code
claude-mem install
  Version: 12.3.9
  Platform: win32 (x64)
Adding marketplace...
SSH not configured, cloning via HTTPS: https://github.com/thedotmack/claude-mem.git
Refreshing marketplace cache (timeout: 120s)…
Cloning repository (timeout: 120s): https://github.com/thedotmack/claude-mem.git
Clone complete, validating marketplace…
✔ Successfully added marketplace: thedotmack (declared in user settings)
Installing plugin "claude-mem"...
✔ Successfully installed plugin: claude-mem@thedotmack (scope: user)
  Claude Code: plugin installed via CLI.

  Installation Complete
  Version:     12.3.9
  Plugin dir:  C:\Users\wogol\.claude\plugins\marketplaces\thedotmack
  IDEs:        claude-code

  Next Steps
  Open Claude Code and start a conversation -- memory is automatic!
```

Install **succeeded** on both steps, fully non-interactively. No prompts were triggered.

## 3. Initial Schema at Install Time

**`~/.claude-mem/` does not exist after install.** The data directory and `claude-mem.db` are created lazily on the first Claude Code session where claude-mem hooks fire. This is by design: `src/shared/paths.ts` defines `ensureAllDataDirs()` but it's called by the runtime (worker/hooks), not by the installer.

Since no DB exists to dump, the schema documented in §5 below was extracted directly from the source migration files in the installed plugin tree:

- `C:\Users\wogol\.claude\plugins\marketplaces\thedotmack\src\services\sqlite\migrations.ts` (migrations 001–003 in the snippet read)
- `C:\Users\wogol\.claude\plugins\marketplaces\thedotmack\src\types\database.ts` (record-type interfaces)

The user's post-session `sqlite3 ~/.claude-mem/claude-mem.db ".schema"` dump (via the script in §4) will confirm which migration version the installed build has actually applied (12.3.9 is likely well past v3).

### Key correction to the spec's assumption

The spec §4.3 translation block guessed the DB was named **`sessions.db`** with a `sessions` table exposing `id`, `title`, `summary`, `created_at`, `updated_at`, and `project_name`/`cwd`. The real layout (confirmed from source) is:

| Spec assumption | Actual claude-mem 12.3.9 |
|-----------------|--------------------------|
| DB path `~/.claude-mem/sessions.db` | `~/.claude-mem/claude-mem.db` |
| table `sessions` | table `sessions` exists ✅ |
| `sessions.id` (primary key we'd expose) | `sessions.id` is INTEGER AUTOINCREMENT; the **stable identifier** the bridge should key on is `sessions.session_id TEXT UNIQUE NOT NULL` |
| `sessions.title` | **not on `sessions`** — `title`/`subtitle` live on `memories` (migration 002) and `streaming_sessions` (migration 003) |
| `sessions.summary` | **not on `sessions`** — summary text lives in the `overviews.content` column (one-per-project latest overview, linked by `session_id`) |
| `sessions.created_at` / `updated_at` | `sessions.created_at TEXT` + `sessions.created_at_epoch INTEGER` exist; `updated_at` is not on `sessions` (it's on `streaming_sessions.updated_at_epoch`) |
| `sessions.project_name` / `sessions.cwd` | `sessions.project TEXT NOT NULL` (project identifier string; format is `<parent-dir>/<repo>` per `getCurrentProjectName()` in `src/shared/paths.ts`, git-root-aware) |

The bridge's source→UM translation will need to **join `sessions` with `overviews` (and probably `memories`) on `session_id`** to produce a UM-shaped "summary with title" record. This is a material design adjustment that Phase D's planning must absorb.

## 4. STATUS: WAITING FOR USER ACTION

All non-interactive steps are complete. To finish V1, the user needs to:

### Step A — Open Claude Code with claude-mem active (one session, any project)

```bash
# In any terminal, from any project directory:
claude
# → have any short conversation (even a 2-turn one is enough to trigger
#   claude-mem's SessionStart and Stop hooks that write to the DB)
# → exit the session (Ctrl-D or /quit)
```

**Why a real session is required:** claude-mem's `ensureAllDataDirs()` is invoked by the runtime hooks registered with Claude Code, not by the npm-install or `npx claude-mem install` paths. Until at least one Claude Code session fires a hook, `~/.claude-mem/` does not exist.

### Step B — Run the fixture-prep script

```bash
bash E:/Projects/universal-memory/docs/research/2026-04-24-v0.6-verifications/V1-fixture-prep.sh
```

**Caveat:** the script as originally drafted by the spec uses the `sqlite3` CLI, which is **not installed on this Windows dev box** (`which sqlite3` → not found). The script has been rewritten to prefer `sqlite3` if available and fall back to a Python one-liner (`python -c "import sqlite3; ..."`) otherwise. Python 3.11 with `sqlite3` module (SQLite 3.45.1) is confirmed available on this machine.

Alternative if neither path works on a given host: `npm install -g better-sqlite3` and use a Node one-liner. The script currently emits a helpful error pointing to these options.

### Step C — Review + update this file's §3 + §5 with observed schema

After the script runs:
- `docs/research/2026-04-24-v0.6-verifications/claude-mem-schema.sql` contains the real `.schema` dump
- `server/test/fixtures/claude-mem-sessions-v12.3.9.db` contains the scrubbed fixture (note: filename uses `sessions` for continuity with the spec's naming even though the real file is `claude-mem.db`; we can rename in Phase D if we prefer)

Diff the real schema against §5 below. Any new tables/columns added by migrations 004+ should be recorded here and fed back into the Phase D translation block spec.

### Step D — Commit the schema + fixture

```bash
git add docs/research/2026-04-24-v0.6-verifications/claude-mem-schema.sql \
        server/test/fixtures/claude-mem-sessions-v12.3.9.db \
        docs/research/2026-04-24-v0.6-verifications/V1-claude-mem-schema.md
git commit -m "verify(pre-1): V1 claude-mem real schema + scrubbed fixture

Follow-up to initial V1 commit. Dumped schema from live
~/.claude-mem/claude-mem.db after first Claude Code session;
produced PII-scrubbed fixture for Phase D bridge tests."
```

## 5. Expected Schema Columns the Bridge Will Depend On

Derived from `src/services/sqlite/migrations.ts` (migrations 001–003) and `src/types/database.ts`. **User should confirm each of these exists in the real DB after Step C above.** The bridge path in Phase D will read these fields; any drift means the translation block needs a version-specific branch or a compatibility shim.

### Table `sessions` (migration 001, core)

| Column | Type | Bridge uses it for | Confirmed post-session? |
|--------|------|--------------------|--------------------------|
| `session_id` | TEXT UNIQUE NOT NULL | Stable external ID; UM's `source_id` |  |
| `project` | TEXT NOT NULL | UM `project` field; scope filter |  |
| `created_at` | TEXT | ISO timestamp for UM `created_at` |  |
| `created_at_epoch` | INTEGER | Sort key / range queries |  |
| `source` | TEXT DEFAULT 'compress' | Provenance tag on UM record |  |
| `archive_path` | TEXT (nullable) | Link to archived transcript (optional) |  |
| `metadata_json` | TEXT (nullable) | Passthrough extra context |  |

### Table `overviews` (migration 001, one-per-project summary)

| Column | Type | Bridge uses it for | Confirmed post-session? |
|--------|------|--------------------|--------------------------|
| `session_id` | TEXT NOT NULL (FK → sessions) | Join key |  |
| `content` | TEXT NOT NULL | **The summary text** (was spec'd as `session.summary`) |  |
| `project` | TEXT NOT NULL | Scope filter |  |
| `origin` | TEXT DEFAULT 'claude' | Provenance |  |
| `created_at_epoch` | INTEGER | Pick latest per project |  |

### Table `memories` (migration 001 + 002, chunks + hierarchical fields)

| Column | Type | Bridge uses it for | Confirmed post-session? |
|--------|------|--------------------|--------------------------|
| `session_id` | TEXT NOT NULL (FK → sessions) | Join key |  |
| `text` | TEXT NOT NULL | Body of memory chunk |  |
| `title` | TEXT (added in 002) | **Short title** (was spec'd as `session.title`) |  |
| `subtitle` | TEXT (added in 002) | Secondary display |  |
| `concepts` | TEXT (added in 002) | Tag-like concepts |  |
| `files_touched` | TEXT (added in 002) | Source files referenced |  |
| `origin` | TEXT DEFAULT 'transcript' | Provenance |  |

### Table `streaming_sessions` (migration 003, real-time state)

Has `title`, `subtitle`, `user_prompt`, `updated_at_epoch`, and `status`. Useful if the bridge needs the "most recent session heading/prompt" view, but the bridge **should not depend on this for historical replay** because rows are ephemeral and get superseded by finalized `sessions` + `overviews` + `memories` triples.

### Minimum bridge-translation query (pseudo-SQL, for Phase D to refine)

```sql
SELECT
  s.session_id                      AS source_id,
  s.project                         AS project,
  s.created_at_epoch                AS created_at_epoch,
  s.created_at                      AS created_at,
  COALESCE(
    (SELECT m.title FROM memories m WHERE m.session_id = s.session_id ORDER BY m.created_at_epoch DESC LIMIT 1),
    '(untitled)'
  )                                 AS title,
  (SELECT o.content FROM overviews o WHERE o.session_id = s.session_id ORDER BY o.created_at_epoch DESC LIMIT 1)
                                    AS summary
FROM sessions s
ORDER BY s.created_at_epoch DESC;
```

## 6. Environment

| Tool | Version | Host | Notes |
|------|---------|------|-------|
| Node.js (npm) | nvm4w-managed | Windows 11 | `/c/nvm4w/nodejs` — npm global root `C:\nvm4w\nodejs\node_modules` |
| claude-mem | 12.3.9 | Windows 11 | installed, plugin registered |
| Python | 3.11, sqlite3 3.45.1 | Windows 11 | fallback for schema dump (sqlite3 CLI absent) |
| sqlite3 CLI | NOT installed | Windows 11 | script now has a Python fallback |
| Bun | not checked | Windows 11 | only needed for `npx claude-mem start/search/...` runtime, not for UM's bridge |
