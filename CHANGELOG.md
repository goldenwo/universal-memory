# Changelog

All notable changes to universal-memory are documented here. Format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/); this project
adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`installer/lib/marker-block.sh` idempotency** — re-running `install.sh` or
  `install-cli.sh` now leaves `~/.bashrc` at a stable line count. In v0.4.0-alpha
  the helper prepended a leading `\n` on every write but awk didn't strip the
  blank line that the prior run had written, so each re-install grew the bashrc
  by 1 blank line (unbounded over many runs). Fix: awk now buffers blank lines
  and discards the buffer when it sees the marker-start sentinel. Regression
  tests added to `installer/install-cli.test.sh` (T8) and `server/install.test.sh`
  (T18 extended). Surfaced by a post-release VM smoke test; fixed on `main` but
  not back-ported to the `v0.4.0-alpha` tag — users who re-install from the tag
  hit the bug; users cloning `main` get the fix. See commit `46e8700`.

## [0.4.0-alpha] — 2026-04-21

Hybrid-rebalance release. Five phases (0, B.1, B.3, A, D) plus docs capstone
(E) across 85 commits and three rounds of dual-Opus design review. Headline:
progressive disclosure cuts 41.9% of single-hop tool-call context on reads,
and a first-class `um` CLI replaces ad-hoc curl for everyday vault work.
All Critical / Important / Scalability findings from review are resolved;
ten Minor findings are deferred to v0.5.

### Added

- **Progressive disclosure on read responses** (Phase B.1). REST
  `/api/search`, `/api/list`, `/api/recent/{project}` and MCP `memory_search`,
  `memory_list`, `memory_recent` return compact `{id, title, score, snippet}`
  (~200-byte snippet = title + first 240 chars of body) by default. Opt into
  full bodies via `?full=1` (REST) or `full: true` (MCP). 41.9% single-hop
  context reduction measured against v0.3 baseline using the 20-query
  fixture.
- **`GET /api/recent/{project}`** REST endpoint — filesystem mtime-sorted
  recent session summaries. Parity with MCP `memory_recent`.
- **`um` CLI** (Phase A). Seven subcommands — `um search`, `um state`,
  `um recent`, `um list`, `um capture`, `um tail`, `um --version` — behind a
  dispatcher with a shared `hooks/lib/config.sh` KEY=value loader (env
  overrides repo `.um/config` overrides user `~/.um/config`). Standalone
  installer at `installer/install-cli.sh`. Shared project-resolution lib at
  `hooks/lib/resolve-project.sh`. Reference: `docs/um-cli.md`.
- **`installer/install-cli.sh`** standalone CLI installer (Phase D).
  Git-clone-based; writes an env-sourced managed block into `~/.bashrc` /
  `~/.zshrc`. Cross-platform CI matrix on ubuntu + macOS. Companion doc:
  `installer/install-cli.md`.
- **Shared `installer/lib/marker-block.sh`** sourced by both
  `install.sh` (full-server) and `install-cli.sh` (CLI-only) so the two
  installers emit identical rc-file blocks.
- **Token-cost measurement harness** at `server/test/token-cost.test.mjs`
  with a 20-query fixture + checked-in baseline JSONs (Phase 0 / B.1).
- **Schema drift gate**: `server/test/custom-gpt-actions.test.mjs`
  byte-matches `plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml`
  against `openapi.mjs`'s generator output so the Custom GPT action spec
  cannot silently drift from the canonical schema.

### Changed

- **BREAKING for REST consumers**: `/api/search` and `/api/list` default
  response shape is now `{id, title, score, snippet}` (compact) instead of
  the full body with `metadata`. Pass `?full=1` to opt into full bodies.
  See `MIGRATION.md`.
- **BREAKING for MCP clients reading full bodies**: `memory_search`,
  `memory_list`, `memory_recent` return compact shape by default. Pass
  `full: true` in tool arguments to opt back in.
- **BREAKING for MCP listTools consumers**: `tools/list` returns 4 read
  tools by default (`memory_search`, `memory_list`, `memory_state`,
  `memory_recent`). The 6 write tools (`memory_add`, `memory_delete`,
  `memory_capture`, `memory_checkpoint`, `memory_forget`, `memory_supersede`)
  are filtered out unless `UM_MCP_WRITE_ENABLED=true` on the server. Direct
  `tools/call` against a filtered tool still returns
  `{ ok: false, error: "MCP writes disabled" }` (graceful) — commit
  `0cb912b`.
- `memory_recent` MCP tool now reads the filesystem directly (mtime-sorted)
  via `doRecent()` — previously wrapped `memory_search('session_summary',
  ...)` in v0.3. REST `/api/recent/{project}` has parity. `project` arg now
  required (commits `b9ed0cb`, `e956641`).
- Summarizer prompt compressed 35.5% and default model dropped to the cheap
  tier (commit `524cf0e`).
- Read-tool MCP descriptions trimmed — verbose examples moved to
  `docs/mcp-tools.md` (commit `2fd7cc6`).
- Install docs pivoted from `curl | bash` to `git clone + bash
  installer/install-cli.sh` for the standalone CLI (commit `267ba27`). The
  full-server `installer/install.sh` still supports `curl | bash` via
  self-bootstrap.
- `UM_LIB_DIR` env override wired into all `bin/um*` scripts (commits
  `d3ea4ad`, `92be508`) — lets the installer place hook libs at
  `~/.local/share/um/lib/` without requiring the full plugin tree.

### Fixed

Server:

- `/api/list` now honors `?limit` (was silently ignored — commit `5b3bd2d`).
- `decodeURIComponent` on `/api/state/{project}` path — URL-encoded project
  slugs parse correctly (commit `b42223c`).
- `doState` race-tolerance — non-ENOENT I/O errors log and return
  `state:null` instead of crashing (commits `3f838b1`, `47d3a29`).
- OpenAPI `id` field descriptions now read as filename stem (not mem0
  UUID); `actions-trimmed.yaml` regenerated (commit `5ca00a1`).
- `doRecent` surrogate-safe snippet slice + race-tolerant file reads
  (commit `a5bbd39`).
- MCP `memory_recent` now calls `doRecent` — was silently diverging from
  REST (commit `e956641`).
- Snippet-design fixture relocated to `server/config/` for Docker-image
  safety (commit `aaeaccd`).
- 500-response sanitization — `err.message` scrubbed in the top-level catch
  (commit `4ac9026`).

CLI:

- `um` usage log drops PII — logs `{timestamp, subcommand, arg_count}` only
  (commit `de69f2a`).
- `resolve-project.sh` slug validation — path-traversal guard; e.g.
  `--project "../evil"` rejected (commit `406a184`).
- `um.test.sh` uses an isolated temp dir (previously destroyed real
  subcommand files on cleanup — commit `3257038`).
- `um-tail.sh` sed unescape order fix for bodies with literal backslashes
  (commit `e3473b5`).
- CLI error messages surface `curl` exit code (`-fSsm` replaces `-sfm` —
  commit `171d530`).
- `um-capture` emits `exit 1` on write failure (commit `182539a`).
- `um-forget` / `um-supersede` honor `UM_SERVER_URL` with `UM_ENDPOINT`
  back-compat fallback (commit `bedb0e6`).
- `vault.sh` `date -d` BSD fallback for macOS `find_orphans` (commit
  `6440464`).

Installer:

- `install-cli.sh` guards `SHELL` / `HOME` unbound under `set -u` (commit
  `8ea2a07`).
- `install.sh` honors env-sourced contract (dropped silent Case-2 skip per
  plan RH6 — commit `a6e9dd5`).
- `marker-block.sh` same-dir mktemp + trap cleanup for atomic `mv` (commit
  `60185ca`); escapes single quotes in values (commit `be87cd7`).
- `install-cli.sh` verifies library + script copy success — no silent fail
  (commit `42dc103`).
- `um-tunnel` now copied by the installer; T1 label corrected from symlink
  to dispatcher (commit `9a983b7`).

CI:

- softprops release-asset action pinned to SHA + pre-check installer asset
  exists (commit `7dacb65`).
- Installer cross-platform matrix — ubuntu + macOS (commit `26f8e66`).
- `um.test.sh` uses a portable sed redirect — BSD-compatible (commit
  `8d0ccae`).

### Security

- MCP write tools are now hidden from the default `tools/list` response
  when `UM_MCP_WRITE_ENABLED=false` (default). Reduces accidental exposure
  of write capability to clients that discover tools via `tools/list`
  (Phase B.3, commit `0cb912b`).
- `GET /openapi.yaml` documented as intentionally unauthenticated — exposes
  schema only, no vault contents. See `docs/mcp-tools.md` Security section.
- Usage log stripped of PII (see CLI `de69f2a` above).

### Deprecated / Removed

- `installer/um-cli/lib/` duplicate removed; `install-cli.sh` now copies
  libs directly from `plugins/claude-code/universal-memory/hooks/lib/`
  (commit `714eb8f`).
- `um validate` subcommand dropped per Phase 0.5b (vault-as-git signal
  absent at gate). Phase A ships 7 subcommands, not 8.

### Notes / known limitations

- `/api/list` response envelope is still a raw array, not
  `{results: [...]}`. Intentionally preserved for backward compatibility
  per Phase B.1.4b — will be unified with `/api/search` and `/api/recent`
  in a future release. Not a regression in v0.4.
- Max-transcript tokenization projection (research doc §1 row 4b) is
  likely ~2× understated; the sample is BPE-optimal. Measurement
  methodology flagged for v0.5 tightening.
- `claude-agent-sdk` summarizer mode pipes the transcript but not the
  system prompt — a silent quality regression for that non-default config.
  Tracked as I4 for v0.5 (`summarize.sh` needs to prepend
  `_UM_SYSTEM_PROMPT`).

## [0.3.0-alpha] — 2026-04-20

Cross-platform release. Phases A–F of the v0.3 plan: Codex CLI plugin,
ChatGPT Desktop + Claude.ai + Custom GPT connection guides, OpenAPI 3.1
surface, `um-tunnel` CLI, OpenAI Assistants API example, pluggable
summarizer (`UM_SUMMARIZER`), `/um-preview` slash command, `install.sh
--yes`. See [ROADMAP.md](ROADMAP.md) for the shipped row link to the
release.

[Unreleased]: https://github.com/goldenwo/universal-memory/compare/v0.4.0-alpha...HEAD
[0.4.0-alpha]: https://github.com/goldenwo/universal-memory/releases/tag/v0.4.0-alpha
[0.3.0-alpha]: https://github.com/goldenwo/universal-memory/releases/tag/v0.3.0-alpha
