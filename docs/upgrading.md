# Upgrading universal-memory

universal-memory is **three separately-updated surfaces**, not one. They ship from the same repo on the same version number, but they update through three different mechanisms and nothing keeps them in step:

| # | Surface | What it is | How it updates |
|---|---|---|---|
| 1 | **Server** | the Docker container | `./install.sh --upgrade` |
| 2 | **Claude Code plugin** | hooks, `/um-*` commands | `claude plugin update universal-memory` |
| 3 | **`um` CLI** | `um-alert`, `um-search`, `um-state`, … | re-run `installer/install-cli.sh` |

Skew between them is silent by default. One install ran a current server for a full release cycle while its CLI sat a release behind — so the capture-freshness cron shipped in that release simply could not be installed: the script it needed did not exist on disk. Nothing reported the gap, because nothing was looking.

**`bash server/install.sh --verify` now reports all three versions and flags skew.** Run it first; it tells you which of the steps below you actually need.

---

## Order matters: server first

**Upgrade the server before the client surfaces.** The plugin refuses to talk to a server older than itself — its capture routes `404` against a server that predates them. Upgrading the plugin first gives you a window where captures silently stop.

Upgrading the server first is always safe: the server is backward-compatible with older clients.

---

## 1. Server

```bash
cd server
./install.sh --upgrade          # to whatever your compose config resolves
./install.sh --upgrade 1.8.1    # to a specific published version
```

`--upgrade` records the running image, pulls the new one, **pre-flights it in a throwaway container before touching the running one**, swaps via compose, health-verifies, and **auto-rolls-back** if the new container never comes up. It exits non-zero if the upgrade did not take.

It also refreshes your `um` CLI afterwards (step 3) when one is installed, so in the common case the server command covers two of the three surfaces.

Prefer to drive compose yourself:

```bash
cd server
UM_VERSION=1.8.1 docker compose pull && UM_VERSION=1.8.1 docker compose up -d
```

Run compose from `server/` and **without `-f`**, so a host-specific `server/docker-compose.override.yml` is picked up — an explicit `-f` suppresses it.

**Failure signature:** the server never comes up. `--upgrade` handles this for you (logs + rollback). Doing it manually, you get a crash-looping container and `docker compose logs memory-server`.

---

## 2. Claude Code plugin

```bash
claude plugin update universal-memory
```

Then **restart Claude Code** — hooks load at session start, so a running session keeps the old ones.

If the update does not appear, refresh the marketplace metadata first:

```bash
claude plugin marketplace update universal-memory
claude plugin update universal-memory
```

**Failure signatures — this is the surface that fails quietly:**

- `skip=server-too-old` in `~/.um/hook.log` — the plugin is newer than the server. **Upgrade the server** (step 1); the plugin is fine.
- A `⚠ UM: captures are OFF` banner at session start — the reason is on the banner. Two common ones: server unreachable, or the server has writes disabled (`UM_MCP_WRITE_ENABLED=true` + `UM_MOUNT_MODE=rw` in `server/.env`; see [MIGRATION.md](../MIGRATION.md) § "v1.6 → v1.7").
- `skip=writes-disabled` in `~/.um/hook.log` — same as above.
- Nothing logged at all — the plugin is not enabled. Check `claude plugin list`, then run `/um-setup`.

---

## 3. The `um` CLI

**This is the surface with no self-update path.** The CLI is a *copy* of the repo's scripts under `~/.local/share/um`; it stays at whatever version was installed until someone re-runs the installer.

```bash
cd /path/to/universal-memory
git pull
bash installer/install-cli.sh --no-path
```

`--no-path` skips the shell-profile rewrite. Use it for upgrades: the installer rewrites its managed block from the *current* environment, so without it a shell that has no `UM_OPENAI_API_KEY` exported will blank that value in your profile.

`server/install.sh --upgrade` does this for you automatically when a CLI is installed, so you usually only need this if you upgraded the server by hand, or if `--upgrade` reported that it could not refresh.

**Failure signatures:**

- `um-alert` (or any subcommand) is **not found** — your CLI predates it. Refresh.
- `um-alert` exits **2** with `server too old — upgrade it to a release that ships the stats layer` — the CLI is current, the *server* is not. Do step 1. (`um-alert` exit codes: `0` fresh, `1` stale, `2` the check could not run.)

---

## Installed from a tarball (no `git pull`)

`--upgrade` and the CLI installer both need a source tree. If you installed from a tarball or a partial copy, there is nothing to `git pull` — re-download and re-run:

```bash
curl -fsSL https://github.com/goldenwo/universal-memory/archive/refs/tags/v1.8.1.tar.gz | tar xz
cd universal-memory-1.8.1
bash installer/install-cli.sh --no-path      # refresh the CLI
cd server && ./install.sh --upgrade 1.8.1    # upgrade the server
```

Your data and configuration are **not** in the source tree — `server/.env`, the vault, and the Qdrant volume all live outside it — so replacing the tree is safe. Copy your existing `server/.env` into the new tree before running `--upgrade`, or point `--upgrade` at the old tree's `server/` directory.

If the CLI is installed but `installer/install-cli.sh` is missing from your tree, `--upgrade` says so explicitly rather than leaving you with a silently stale CLI.

---

## Checking what you are on

```bash
bash server/install.sh --verify
```

reports `version-server`, `version-cli`, `version-plugin`, and `version-source-tree`, and flags:

- **plugin newer than server** — upgrade the server (this is the silent-capture-death shape).
- **CLI behind the source tree** — refresh the CLI; scripts added since your CLI version are missing.
- **server below 1.7.0 with a plugin installed** — a hard failure: that server predates the `/api` capture contract and the plugin cannot capture against it at all.

Individually:

```bash
um --version                                   # CLI
claude plugin list                             # plugin
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "$(cd server && docker compose ps -q memory-server)"    # server
```

For a **remote** server you cannot `docker inspect`, ask it:

```bash
curl -sH "Authorization: Bearer $(cat ~/.um/auth-token)" https://your-server/api/stats
```

`/api/stats` reports the server version, uptime, and capture freshness. It needs the bearer token even from loopback.

---

## See also

- [MIGRATION.md](../MIGRATION.md) — per-version upgrade notes and breaking changes
- [CHANGELOG.md](../CHANGELOG.md) — full release notes
- [docs/claude-code-plugin.md](claude-code-plugin.md) — plugin setup, flags, troubleshooting
