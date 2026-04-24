# Migration guide

## v0.5 → v0.6

### Breaking: `/api/list` response envelope

Before (v0.5): `GET /api/list` returned a bare JSON array.

```bash
$ curl http://localhost:6335/api/list
[{"id":"...","text":"...","metadata":{...}}, ...]
```

After (v0.6): returns `{results: [...]}` matching `/api/search` and `/api/recent`.

```bash
$ curl http://localhost:6335/api/list
{"results":[{"id":"...","text":"...","metadata":{...}}, ...]}
```

Why: consistency across list-shape endpoints; future-proofs for additive top-level siblings (`provider`, `latency_ms` in v0.7+) without another shape change.

---

## v0.4.0-alpha → v0.5.0-alpha

Four changes worth knowing about. None are breaking for existing Claude Code
users — all are additive or fix silent regressions.

### 1. New write tool `memory_append_turn`

Non-CC surfaces (Claude.ai, ChatGPT Desktop, Codex) can now append
conversation turns to the raw-capture pipeline via the `memory_append_turn`
MCP tool or `POST /api/append-turn` REST endpoint. The three required args are
`project`, `content`, and `role` (`user`/`assistant`/`system`).

This is distinct from:
- `memory_add` — runs mem0's fact-extractor; no project structure, no raw
  capture, no session-end pipeline.
- `memory_capture` — writes a stable authored document with full frontmatter;
  appropriate for ADRs, canonical docs, anything that needs a stable ID and
  versioning.

Use `memory_append_turn` when you want turn-level capture that feeds into
`memory_checkpoint`'s synthesis pipeline. If your rubric (system prompt paste-in
for Claude.ai / ChatGPT Desktop / Custom GPT setups) is re-pasted from the
current `docs/memory-routing-rubric.md`, it will already include the new
`memory_append_turn` routing clause.

### 2. `memory_checkpoint` server-side body

`memory_checkpoint` is no longer a stub. In v0.4 it returned an actionable
error pointing at `/um-checkpoint` or `hooks/session-end.sh`. In v0.5 it
executes the full session-end pipeline: reads raw captures → LLM-summarizes →
writes to `sessions/<project>/` → merges into `state/<project>/state.md` →
re-indexes into mem0.

Claude Code users are unaffected — the hook-driven pipeline is unchanged.
Claude.ai / ChatGPT Desktop / Codex users gain the ability to trigger session
summaries and `state.md` refreshes directly via MCP.

**Important caveat:** if `UM_SUMMARIZER=claude-agent-sdk` is set in
`server/.env`, the server-side checkpoint will fall back to `openai`/`ollama`
with a warning log — Docker cannot spawn a host-side Claude Code process.
Recommendation: set `UM_SUMMARIZER=openai` or `UM_SUMMARIZER=ollama` in
`server/.env` to use the server-side path cleanly. The `claude-agent-sdk` mode
remains valid for hook-driven summarization in the CC plugin (which spawns CC
directly).

### 3. Modular install

`install-cli.sh` continues to work exactly as before (backward-compat). No
changes needed for existing CLI-only installs.

The new entry point `install.sh` now supports composable component flags:

```bash
bash installer/install.sh --server          # server only
bash installer/install.sh --plugin-cc       # CC plugin only
bash installer/install.sh --plugin-codex    # Codex plugin only
bash installer/install.sh --cli             # CLI only
bash installer/install.sh --all             # everything
bash installer/install.sh                   # interactive wizard if TTY, else equivalent to --all
bash installer/install.sh --yes             # skip all prompts
bash installer/install.sh --dry-run         # print actions without executing
```

Existing v0.4 invocations of `installer/install.sh` with no flags continue to
work (the wizard fires only when stdin is a TTY and no flags are present).

**After upgrade:** restart Claude Code (quit + relaunch) so the updated plugin loads. CC reads plugin manifests at startup; a running session continues to use the old plugin until restart.

### 4. `UM_PROMPT_DIR` env var (non-breaking)

The installer now writes a `UM_PROMPT_DIR` export to the managed block in
`~/.bashrc`/`~/.zshrc` for plugin-cc installs. `hooks/lib/summarize.sh` and
`update-state.sh` read the summarize and state-update prompts from that
directory; if `UM_PROMPT_DIR` is unset, they fall back to the plugin-local
`hooks/lib/prompts/` directory as before.

This means re-running the installer (to pick up the new managed block) will
eliminate prompt drift between the CC plugin and any server-side prompt path.
Re-install is optional — existing installs continue to work with the fallback.

**Known limitations (deferred to v0.6):**
- Cross-process concurrent-write coordination between Claude Code's stop.sh
  (perl Fcntl::flock) and the node server's memory_append_turn (proper-lockfile)
  uses different lock mechanisms. Corruption risk is practically low (stop.sh
  writes <10ms) but cross-language coordination is a v0.6 hardening item.

---

### Rollback from v0.5 to v0.4

All v0.5 changes are additive — new tool (`memory_append_turn`), new env var (`UM_PROMPT_DIR`), new installer flags, real `memory_checkpoint` body replacing the v0.4 stub. There are NO vault schema changes: `captures/`, `sessions/`, `state/` directories are unchanged.

To rollback: `git checkout v0.4.0-alpha` on the server repo and redeploy the Docker stack. The client plugin at `~/.claude/plugins/universal-memory/` can be reinstalled via `installer/install-cli.sh` from v0.4. Existing vault data stays compatible.

The only consideration: any raw captures written via `memory_append_turn` (v0.5-only tool) will still be present in `captures/<project>/raw/<date>.md` as v0.5-format headers (`## <ISO> <role> [(conversation_id: ...)]`). The v0.4 session-end summarizer treats any `## ` line as a turn header and accepts them. No cleanup needed.

---

### Closing note for v0.4 → v0.5

No database migrations, no config-file rewrites, no plugin reinstall required.
Re-installing (`bash installer/install.sh --plugin-cc`) will pick up the new
`UM_PROMPT_DIR` managed-block entry; hooks gracefully default to the
plugin-local `prompts/` directory if `UM_PROMPT_DIR` is unset. The vault
filesystem layout is unchanged.

---

## v0.3.0-alpha → v0.4.0-alpha

Four user-visible changes need attention. Two are breaking for programmatic
consumers of UM's REST / MCP surface; one is a behavior change on
`memory_recent`; one is a cosmetic install-docs pivot.

### 1. REST response shapes changed (breaking)

**What changed.** `/api/search`, `/api/list`, and `/api/recent/{project}`
now return compact `{id, title, score, snippet}` by default. The full
`body` + `metadata` fields are no longer sent unless you ask for them.

**Who's affected.** Any script, agent, or integration that parses `body`
or `metadata` from these endpoints.

**Fix.** Append `?full=1` to the query string.

```bash
# v0.3 — full body every time
curl -s "http://localhost:6335/api/search?query=foo&limit=5"

# v0.4 default — compact snippet
curl -s "http://localhost:6335/api/search?query=foo&limit=5"

# v0.4 — opt into v0.3 behavior
curl -s "http://localhost:6335/api/search?query=foo&limit=5&full=1"
```

**Why.** Tool-call context in LLM surfaces is expensive. Compact shape
cuts 41.9% of single-hop read context against the v0.3 baseline. Clients
that genuinely need full bodies get them with one extra query param.

### 2. MCP response shapes + tool visibility (breaking)

**What changed.**

1. `memory_search`, `memory_list`, `memory_recent` return compact shape by
   default. Pass `full: true` in tool arguments to opt back in.
2. `tools/list` returns 4 tools by default — the 4 reads. The 7 write
   tools (`memory_add`, `memory_append_turn`, `memory_capture`,
   `memory_checkpoint`, `memory_delete`, `memory_forget`, `memory_supersede`)
   are filtered out of discovery unless `UM_MCP_WRITE_ENABLED=true` on
   the server.

**Who's affected.**

- MCP clients whose system prompt references "11 tools" or expects to see
  write tools in the discovery response.
- Clients that consume `memory_search` body content directly.

**Fix.**

1. For full bodies, pass `full: true` in `tools/call` arguments:

   ```json
   {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"foo","full":true}}}
   ```

2. To see writes in `tools/list`, set `UM_MCP_WRITE_ENABLED=true` in the
   server's `.env`, then `docker compose restart memory-server`. This has
   always been the gate for write *success*; now it's also the gate for
   write *visibility*.

**Why.** Reading `memory_search` responses one screenful at a time without
compact snippets eats 40%+ of useful LLM context. Hiding writes by default
also reduces accidental footgun surface for non-operator clients that
discover tools dynamically.

### 3. `memory_recent` semantics changed (behavior change)

**What changed.** `memory_recent` used to wrap
`memory_search('session_summary', ...)` — mem0 vector-scored results
tagged as session summaries. It now reads the filesystem directly
(mtime-sorted, newest first) via the same code path as
`GET /api/recent/{project}`.

**Who's affected.** Anyone who relied on the vector-scored ordering or the
implicit "only session_summary type" filter.

**Fix.** The `project` argument is now required (previously implicit).
Pass a project name or slug. Pass `full: true` to get bodies instead of
snippets.

**Why.** Filesystem mtime is monotonic, cheap, and deterministic.
Vector-scored "recent" was semantically confusing — why would a
three-month-old doc score higher than yesterday's? REST parity via
`/api/recent/{project}` is new in v0.4.

### 4. Install docs pivot (cosmetic)

**What changed.** `installer/install-cli.md` describes the install method
as `git clone + bash installer/install-cli.sh` rather than a single-file
`curl | bash` URL.

**Who's affected.** Anyone following older docs that pointed at a
release-asset `install-cli.sh` URL.

**Fix.** Clone the repo at the `v0.4.0-alpha` tag, then run the installer:

```bash
git clone --branch v0.4.0-alpha https://github.com/goldenwo/universal-memory
cd universal-memory
bash installer/install-cli.sh
```

**Why.** The CLI installer needs access to the full repo layout to copy
libs and subcommand scripts. Self-bootstrapping `curl | bash` for the CLI
is deferred to a future release. The server installer
(`installer/install.sh`) still supports `curl | bash` — it clones
internally.

### Closing note

No database migrations, no config-file rewrites, no plugin reinstalls —
just the above. The vault filesystem layout is unchanged.
