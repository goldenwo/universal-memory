# Bridges

Bridges are one-way ingestion pipelines — they read from an external memory
store and translate each record into a markdown file in your UM vault. The
first bridge ships in v0.6: `um-bridge-claude-mem` ingests sessions from
[claude-mem](https://github.com/jonathanlhart/claude-mem)'s SQLite database.

See [`BRIDGES.md`](../BRIDGES.md) (repo root) for the canonical registry of
supported bridges.

## `um-bridge-claude-mem` (v0.6+)

### What it does

Reads `~/.claude-mem/claude-mem.db` and translates each session into a UM
markdown record at `<vault>/sessions/<project>/claude-mem-<sha>.md` with
frontmatter `source: claude-mem` and a fenced `<external-summary>` body.

Translation contract:
- One row per `sessions` ✕ `memories` ✕ `overviews` LEFT JOIN match
- `session_id` (TEXT) is the stable external ID; the markdown filename SHA
  is derived from it so re-ingesting the same session is idempotent
- Bodies wrapped in `<external-summary source="claude-mem">` markers tell
  downstream LLM consumers (summarizer, session-start injector) to treat
  the content as data, not instruction (§4.3.1 untrusted-content boundary)

### Install

`installer/install-plugin-cc.sh` (run by the wizard's plugin step) installs
the bridge:

- Symlinks `~/.local/bin/um-bridge-claude-mem` → plugin's bin/
- `npm install --omit=dev` in the plugin's `bin/` builds `better-sqlite3`
  (native binding — needs `python3`, `make`, a C++ compiler on the host;
  installer fails gracefully and warns if prereqs are missing)
- Vendor-copies `bridge-contract.mjs` + `lockdir.mjs` into `bin/lib/`

### First run

```bash
um-bridge-claude-mem --once
```

The first run backfills up to `UM_BRIDGE_MAX_PER_RUN` sessions (default 50).
With a large historical claude-mem database (500+ sessions), full backfill
takes multiple ticks at the configured cadence (default 6h via systemd /
launchd / cron). Override with `UM_BRIDGE_MAX_PER_RUN=500` for an immediate
catch-up:

```bash
UM_BRIDGE_MAX_PER_RUN=500 um-bridge-claude-mem --once
```

### Schedule templates

Schedule templates live in `installer/bridge-templates/`. Pick the one that
matches your platform:

| Platform | Template | Activate |
|---|---|---|
| Linux user-systemd | `claude-mem-bridge.systemd-user.timer` + `.service` | `systemctl --user enable --now claude-mem-bridge.timer` |
| macOS | `claude-mem-bridge.launchd.plist` | `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.universal-memory.claude-mem-bridge.plist` |
| Cron (any) | `claude-mem-bridge.cron` | `crontab -e` then paste the line |

systemd uses native `RandomizedDelaySec=600` for jitter. launchd + cron run
the CLI with `UM_BRIDGE_JITTER_SEC=600` so it sleeps 0–600 s before
ingesting (avoids host-concurrent stampede on the reindex endpoint).

### Flags

| Flag | Purpose |
|---|---|
| `--once` | Run a single ingest pass, exit 0. Default invocation for scheduled runs. |
| `--db-path=PATH` | Override default DB path (`~/.claude-mem/claude-mem.db`). Path must resolve under `~/.claude-mem/` or the repo's `server/test/fixtures/` allowlist (UNC paths + symlink-bypass rejected per §6.1 N2). |
| `--cursor-reset` | Delete the cursor file at `<vault>/.local/bridges/claude-mem.json` and exit 0. **Use after a claude-mem schema upgrade** (the bridge schema-version range is pinned per release; mismatched DB exits with `SERVER_INTERNAL` until the bridge is upgraded too). Next run re-ingests every claude-mem session from scratch. |
| `--help` | Print usage + supported claude-mem schema versions. |

### Exit codes

| Code | Meaning | Cursor advanced? |
|---|---|---|
| 0 | Success / silent skip (DB missing, cursor reset done) | Yes (if rows ingested) |
| 1 | CLI error (path validation failure, unexpected exception) | No |
| 2 | `UPSTREAM_FAILURE` (reindex network/HTTP error after 3 retries) | Up to last successful row |
| 3 | `SERVER_INTERNAL` (claude-mem schema version not in supported range) | No |
| 4 | `STATE_LOCK_CONTENTION` (DB locked by claude-mem itself, retried 3× then exited) | No |

Downstream tooling that wraps the bridge (CI gates, monitoring) can rely on
these codes. New codes are additive across versions; codes 0–4 are stable.

### Required env

| Env | Default | Purpose |
|---|---|---|
| `UM_VAULT_DIR` | (must be set) | Where bridge writes markdown |
| `UM_SERVER_URL` | `http://localhost:6335` | Where to POST `/api/reindex` |
| `UM_AUTH_TOKEN` | (required for non-loopback) | Bearer token from `~/.um/auth-token` |
| `UM_BRIDGE_MAX_PER_RUN` | `50` | Per-tick session cap |
| `UM_BRIDGE_JITTER_SEC` | `0` (CLI) / `600` (launchd, cron) | Startup jitter for non-systemd runners |

### Troubleshooting

- **Nothing in vault after first install:** the bridge daemon hasn't run
  yet. Run `um-bridge-claude-mem --once` manually to backfill the first 50
  sessions immediately.
- **Bridge keeps exiting 3 (SERVER_INTERNAL):** claude-mem upgraded its
  schema and the bridge doesn't know about the new version yet. Either
  pin claude-mem to a known-good version or wait for a v0.6.x bridge
  update with the new schema added to `SUPPORTED_SCHEMA_RANGE`.
- **Bridge exits 4 (STATE_LOCK_CONTENTION) repeatedly:** claude-mem itself
  is holding the DB. Stop interactive claude-mem sessions (`claude-mem
  status`) and re-run the bridge. The bridge already retries 3× with 1s
  backoff.
- **Bridge exits 2 (UPSTREAM_FAILURE) on every tick:** check `UM_SERVER_URL`
  is reachable and `UM_AUTH_TOKEN` is set in the bridge's env. The cursor
  preserves progress, so the next successful tick resumes where the
  previous failure stopped.

### Security notes

- Bridge content is **not trusted**. The wrapper rejects bodies containing
  literal `</external-summary>` markers (defeats LLM-aware injection where
  attacker entity-encodes the close tag and the LLM decodes it back during
  reasoning). REJECT-on-marker is stronger than HTML-escape because the
  consumer is an LLM, not an HTML parser.
- `--db-path` accepts only paths under `~/.claude-mem/` (canonical realpath)
  or, in dev, the repo's `server/test/fixtures/`. UNC paths, null bytes,
  and `~/.claude-mem` symlinked elsewhere are rejected.
- The bridge runs as the host user, NOT as `node` inside the container —
  it's a plugin-local CLI, not a server-side process. Vault write
  permissions follow the user's UID:GID (no UM_CONTAINER_USER flow).

### Mid-life recovery

If the bridge gets into a stuck state (e.g., a corrupted cursor pointing at
a deleted session_id), `--cursor-reset` deletes the cursor and the next run
re-ingests every session from claude-mem's epoch-zero. Re-ingestion is
idempotent (markdown filenames are stable SHA-of-session_id), so existing
files are overwritten in place — no duplicate vault entries.

## See also

- [`BRIDGES.md`](../BRIDGES.md) — registry of registered `source:` values
- [`docs/um-cli.md`](um-cli.md) — read-side CLIs for the vault
- [`docs/process/review-playbook.md`](process/review-playbook.md) — how
  bridge designs go through pre-implementation review
- [`MIGRATION.md`](../MIGRATION.md) — v0.5→v0.6 migration including bridge
  considerations
