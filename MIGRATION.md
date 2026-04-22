# Migration guide

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
2. `tools/list` returns 4 tools by default — the 4 reads. The 6 write
   tools (`memory_add`, `memory_delete`, `memory_capture`,
   `memory_checkpoint`, `memory_forget`, `memory_supersede`) are filtered
   out of discovery unless `UM_MCP_WRITE_ENABLED=true` on the server.

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
