# V1 — claude-mem Schema & Fixture Prep

**Date:** 2026-04-24
**Cycle:** v0.6 Pre-1
**Spec ref:** §9.1 (Phase D bridge blocker; pulled forward to Week 1 per I4)
**Status:** FIXTURE SYNTHESIZED (2026-04-24) — see §4 below. Non-interactive steps complete (package installed, plugin registered, schema inspected from source). Rather than block Phase D on a real claude-mem session, the fixture was synthesized deterministically from the upstream schema source.

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
  Plugin dir:  C:\Users\<you>\.claude\plugins\marketplaces\thedotmack
  IDEs:        claude-code

  Next Steps
  Open Claude Code and start a conversation -- memory is automatic!
```

Install **succeeded** on both steps, fully non-interactively. No prompts were triggered.

## 3. Initial Schema at Install Time

**`~/.claude-mem/` does not exist after install.** The data directory and `claude-mem.db` are created lazily on the first Claude Code session where claude-mem hooks fire. This is by design: `src/shared/paths.ts` defines `ensureAllDataDirs()` but it's called by the runtime (worker/hooks), not by the installer.

Since no DB exists to dump, the schema documented in §5 below was extracted directly from the source migration files in the installed plugin tree:

- `C:\Users\<you>\.claude\plugins\marketplaces\thedotmack\src\services\sqlite\migrations.ts` (migrations 001–003 in the snippet read)
- `C:\Users\<you>\.claude\plugins\marketplaces\thedotmack\src\types\database.ts` (record-type interfaces)

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

## Status: FIXTURE SYNTHESIZED (2026-04-24)

Rather than block Phase D on a real claude-mem session, the fixture was
synthesized from the source-documented schema. See
`server/test/fixtures/claude-mem-sessions-v12.3.9.db` — structurally
valid, 2-3 labeled-synthetic sessions, deterministic timestamps.

Phase D bridge tests run against this fixture. If real claude-mem data
later surfaces structural differences (e.g., a new column in
v12.4+), regenerate the fixture from the updated source.

### What was synthesized

- **Fixture DB:** `server/test/fixtures/claude-mem-sessions-v12.3.9.db` (147,456 bytes)
- **Schema:** migrations 001 + 002 applied verbatim from the installed plugin source at `C:\Users\<you>\.claude\plugins\marketplaces\thedotmack\src\services\sqlite\migrations.ts`. `PRAGMA user_version = 2`.
- **Tables created:** `sessions`, `memories`, `overviews`, `diagnostics`, `transcript_events` (plus all 001+002 indexes, including the hierarchical-memory fields `title`/`subtitle`/`facts`/`concepts`/`files_touched` on `memories`).
- **Rows inserted:** 3 each in `sessions`, `memories`, `overviews` — all with `session_id` values `test-session-001`, `test-session-002`, `test-session-003` and deterministic `created_at_epoch` values anchored at `2026-01-15T10:00:00Z` (BASE_EPOCH = 1768514400) + 0h / +1h / +2h.
- **Synthetic labeling:** every `memories.title` starts with `[synthetic]`; every `overviews.content` begins with the sentence "Synthetic fixture for bridge testing — not real claude-mem data." `sessions.metadata_json` also carries a `synthetic: true` flag.
- **Escape-coverage rows:** session 001 is plain-ASCII; session 002 has spaces, apostrophes, `--`, and `&` in title and project (`"Dev/Alice's Side Project"`); session 003 has accented Latin characters and a rocket emoji in the title and a third distinct project slug (`"Projects/cafe-orders"`). Together these exercise slugification, JSON escaping, and UTF-8 round-tripping.

### Verification run (better-sqlite3, read-only)

Ran the exact translation query from §5 against the fixture using `better-sqlite3@12.4.x` resolved from `server/node_modules`. Output (trimmed):

```
opened:   server/test/fixtures/claude-mem-sessions-v12.3.9.db
PRAGMA user_version = 2
tables:   [ diagnostics, memories, overviews, sessions, transcript_events ]
counts:   { sessions: 3, memories: 3, overviews: 3 }

test-session-003  project="Projects/cafe-orders"
  title  : [synthetic] Café résumé — naïve façade (emoji: rocket U+1F680)
test-session-002  project="Dev/Alice's Side Project"
  title  : [synthetic] Alice's notebook -- v2 plans & scope
test-session-001  project="Projects/universal-memory"
  title  : [synthetic] Bridge translation scaffolding

VERIFY OK
```

Ordering is most-recent-first (C → B → A), every title carries the `[synthetic]` prefix, every summary embeds the synthetic-notice sentence, and non-ASCII characters survive the round-trip. The fixture is ready for Phase D bridge tests.

### Scope notes + judgment calls

- **Migration cutoff:** only migrations 001 + 002 are applied. The bridge translation block in §5 depends solely on columns introduced by those two — so going further would only add tables the bridge ignores. Migrations 003–010 include SDK-agent architecture tables (`sdk_sessions`, `observations`, `session_summaries`, FTS5 virtual tables, subagent identity columns) that the installed runtime additionally creates via the `MigrationRunner` in `src/services/sqlite/migrations/runner.ts`. If Phase D's bridge later reaches into those, regenerate the fixture with the extra migrations.
- **Schema-version tracking:** upstream tracks applied migrations in a `schema_versions` table, not `PRAGMA user_version`. The bridge opens the DB read-only and only reads `sessions`/`memories`/`overviews`, so it does not consult either mechanism. The fixture sets `user_version = 2` as an annotation for maintainers; we did not populate a synthetic `schema_versions` row because nothing reads it.
- **`document_id` UNIQUE constraint:** each memory row has a deterministic `doc-<session-id>-001` document_id, so the UNIQUE index is satisfied without collision.
- **`idx_overviews_project_latest`:** the upstream migration defines this as `CREATE UNIQUE INDEX ... ON overviews(project, created_at_epoch DESC)`. That would make per-project-multiple overviews illegal; our three synthetic sessions use three distinct projects, so the constraint is not exercised here. Phase D should check whether the real runtime ever writes two overviews for one project (it may bypass this via an inline-migration runtime step; see the `removeSessionSummariesUniqueConstraint` call in `runner.ts`).

### How to regenerate

The builder script is self-contained (stdlib `sqlite3`, no third-party deps). It lives outside the repo at `E:\tmp\fixture-build\build_fixture.py`; re-running it deterministically overwrites the fixture and re-emits `claude-mem-schema.sql`. If the script needs to move into the repo for CI regeneration, copy it to `server/test/fixtures/_build_claude_mem_fixture.py`.

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
