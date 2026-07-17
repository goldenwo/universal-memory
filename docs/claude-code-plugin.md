# Claude Code plugin — install, first-run setup, and operator guide

The universal-memory Claude Code plugin gives every session automatic capture
and automatic recall against a UM server — local Docker or remote self-hosted.
Since #159 the hooks are **API-always thin HTTP clients**: every capture goes
through the server (`POST /api/append-turn`, `POST /api/checkpoint`), loopback
or remote alike. The server is the only vault writer; client installs need no
LLM API key and no local vault directory.

This page is the canonical reference the hooks link to when something needs
your attention (`⚠ UM: captures are OFF — … see <this page>`).

## Minimum server version

**This plugin requires a universal-memory server ≥ v1.7.0** — the release that
ships the `/api/append-turn` + `/api/checkpoint` capture contract the hooks
and probes are pinned against (auth → write-gate → validation ordering,
`X-UM-Source` attribution, capture counters).

Version skew is first-class: marketplace installs decouple the plugin from the
server, so the setup probe and every hook distinguish

- **HTTP 404 on the write probe → server too old.** The server predates the
  `/api` capture contract — upgrade it (`git pull` + redeploy, or pull a
  `ghcr.io/goldenwo/universal-memory-server` tag ≥ 1.7.0).
- **HTTP 403 → writes disabled.** The server is current but has
  `UM_MCP_WRITE_ENABLED=false` (the shipped default) — flip the flag, see
  [Operator side](#operator-side--server-flags-for-capture) below.

## Install

### Shape A — marketplace (no repo checkout)

```bash
claude plugin marketplace add goldenwo/universal-memory
claude plugin install universal-memory@universal-memory
```

A marketplace install ships the hooks but **no config** — without setup the
hooks resolve the loopback default forever. Run the plugin's first-run setup
once (next section).

### Shape B — installer (repo checkout)

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory
bash installer/install.sh --plugin-cc          # local server on this box
bash installer/install.sh --remote <url>       # point at a remote server
```

`--remote` performs the same verify + config write as `um-setup` (below), plus
installer-only extras: shell-profile marker-block reconciliation and a warning
when a local vault still has un-checkpointed raw captures.

## First-run setup: `um-setup`

The plugin bundles its own self-contained setup — run it once after
installing, either as the slash command **`/um-setup`** inside Claude Code
(it locates the script via `${CLAUDE_PLUGIN_ROOT}` wherever the marketplace
placed the plugin) or directly in a terminal, which gives you a hidden token
prompt:

```bash
# from a repo checkout:
bash plugins/claude-code/universal-memory/hooks/um-setup.sh
```

What it does:

1. Prompts for the server URL (default `http://localhost:6335`) and an auth
   token (hidden input; empty is valid for loopback no-auth installs).
2. Verifies the server: `GET /health`, then an **authed write probe** of
   `POST /api/append-turn` (an empty body is rejected by validation only
   *after* auth and the write gate pass, so nothing is written and the HTTP
   code is diagnostic).
3. On success only, writes `~/.um/endpoint` and `~/.um/auth-token`
   (mode 600). On failure it prints one actionable message per cause —
   unreachable / writes-disabled (403) / bad token (401) / server-too-old
   (404) / rate-limited (429) / redirecting endpoint (3xx — configure the
   final URL directly) / server-side error (5xx) — exits non-zero, and
   writes **nothing**.

Non-interactive (scripts/CI): `--endpoint URL --token TOKEN`, or env
`UM_SETUP_ENDPOINT` / `UM_SETUP_TOKEN`.

## How the hooks resolve the server

Endpoint precedence (spec §4):

1. `UM_SERVER_URL` env — canonical endpoint variable.
2. `UM_ENDPOINT` env — deprecated alias, still honored.
3. `~/.um/endpoint` file — written by `um-setup` / `install.sh --remote`.
4. Default `http://localhost:6335`.

An env export **shadows** the file tier — `um-setup` warns when it detects
that. Token: `${UM_TOKEN_FILE:-~/.um/auth-token}`; an absent/empty file means
no `Authorization` header (loopback no-auth).

**Switching an existing local install to a remote endpoint** strands any
un-checkpointed local raw captures (the remote server cannot read this
machine's filesystem) — run one checkpoint (`/um-checkpoint` or a final
session) against the local server first, then repoint.

## What runs when

| Hook / command | When | What it does |
|---|---|---|
| **SessionStart** | new session / clear / compact | Fetches your project's `state.md` from the server and injects it as context; assesses server health and **prepends a visible ⚠ banner when captures are OFF** (unreachable or writes-disabled) |
| **UserPromptSubmit** | first prompt of a session | Vector-searches memory for the prompt and injects top hits |
| **Stop** | after every Claude turn | Parses the real transcript (delta cursor — no duplicates, no loss) and POSTs each new message to `/api/append-turn` |
| **SessionEnd** | clean exit | Detached POST `/api/checkpoint` — the server synthesizes the session summary + `state.md` with **its** LLM key |
| **`/um-checkpoint`** | on demand | Forces a checkpoint immediately |
| **`/um-setup`** | first run | The setup flow above |

Every hook fire logs one line to `~/.um/hook.log`
(`<ts> <hook> posted http=<code>` / `skip=<reason>` / `error=<reason>`).
Silent capture death is the enemy: a misconfigured server shows up both there
and in the next session's ⚠ banner.

## Operator side — server flags for capture

Plugin captures write through the server, and the server's **shipped defaults
refuse writes**. On the server's `server/.env`:

```bash
UM_MCP_WRITE_ENABLED=true   # default false — 403s every capture until flipped
UM_MOUNT_MODE=rw            # default ro — flag-true + ro mount fails 5xx (EROFS), not 403
```

then restart (`docker compose up -d`). The distinction matters when
debugging: **403 means flip the flag; 5xx means check the mount and server
logs.**

Capture counters (observability, #171): the server records per-day
`capture.*` counters in a UM-owned SQLite file. `UM_COUNTERS_DB_PATH`
defaults next to the mem0 history DB so an existing `/history` bind mount
persists both; with only ephemeral storage the counters still work but reset
on container restart. Counter writes are fire-and-forget — they never fail a
capture.

Auth: remote servers should require `Authorization: Bearer <UM_AUTH_TOKEN>`;
loopback skips auth by default (`UM_ALLOW_LOOPBACK_NOAUTH=true`).

### Deployment health: `GET /api/stats` + `um-alert.sh`

`GET /api/stats` (bearer required — this endpoint never gets the loopback
no-auth bypass) answers "is memory alive" in one JSON document: per-surface
capture freshness (`last_day_seen` + `freshness_hours`), 7-day pipeline
outcomes, corpus size/growth, recall volume, and since-boot serving-latency
percentiles. A missing counters DB degrades gracefully (`capture: null` +
`degraded: ["counters-unavailable"]`, HTTP 200) — fresh installs have no
counters file until the first capture.

Honesty note on the recall figures: `searches_today` / `searches_7d` count
search **and list** reads on the mem0-compat surface — a platform-mode client
that polls list (as some plugins do) inflates them relative to "questions a
human asked".

`um-alert.sh` turns that endpoint into a cron-able freshness check — the
direct fix for silent capture death (captures dark for days with zero
signal). Exit codes: `0` fresh, `1` stale (no surface — or the `--surface`
one — captured within `--max-age-hours`, default 26), `2` the check itself
couldn't run (unreachable / auth / degraded counters — distinct from
staleness on purpose). It reads the same `~/.um/endpoint` + `~/.um/auth-token`
config as the hooks. The CLI installer places it at
`~/.local/share/um/cli/um-alert.sh`:

```cron
26 6 * * * $HOME/.local/share/um/cli/um-alert.sh || <your-notify-command>
```

(The one-line stale/failure message goes to stderr, so cron's mail — or your
notify hook — carries the diagnosis.)

## Troubleshooting

- **⚠ "captures are OFF — server unreachable"**: check the URL in
  `~/.um/endpoint` (or your `UM_SERVER_URL` export — it wins), the server
  process, and any tunnel between. `curl <endpoint>/health` should return
  `{"ok":true,…}`.
- **⚠ "captures are OFF — server has writes disabled"** / `skip=writes-disabled`
  in `hook.log`: flip `UM_MCP_WRITE_ENABLED=true` + `UM_MOUNT_MODE=rw`
  server-side (above).
- **`skip=server-too-old` in `hook.log`**: upgrade the server to ≥ v1.7.0.
- **`error=http-502` on checkpoint**: `state.md` WAS written; only the vector
  reindex failed — state is current, the search index is stale until the next
  successful checkpoint. Check qdrant.
- **Nothing captured, nothing logged**: confirm the plugin is enabled
  (`claude plugin list`) and re-run `um-setup` — its write probe reproduces
  the failure with an actionable message.

## Upgrading from pre-1.7 local installs

The 1.7.0 hooks retire local-file capture and the client-side summarizer. An
in-place upgrade (`git pull` + restart) with a default `.env` goes
capture-dark with a 403 until you flip the two flags above — the SessionStart
banner will tell you. Full migration notes: [CHANGELOG.md](../CHANGELOG.md).
