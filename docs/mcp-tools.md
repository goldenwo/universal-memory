# MCP Tools Reference

universal-memory exposes a JSON-RPC 2.0 MCP surface at `POST /mcp`.
All requests use the `tools/call` method. Responses are wrapped in
`{ content: [{ type: "text", text: "<JSON string>" }] }`.

## Transport

```
POST http://localhost:6335/mcp
Content-Type: application/json
```

Standard MCP handshake (initialize → initialized → tools/list → tools/call).
Clients that skip the handshake can call `tools/call` directly.

---

## Tool listing

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Default visibility (v0.5):** `tools/list` returns the 4 read tools
(`memory_search`, `memory_list`, `memory_state`, `memory_recent`). The 7
write tools (`memory_add`, `memory_delete`, `memory_capture`,
`memory_checkpoint`, `memory_forget`, `memory_supersede`, `memory_append_turn`)
are filtered out unless `UM_MCP_WRITE_ENABLED=true` is set on the server — see
[Write tools — enabling](#write-tools--enabling). This schema-hygiene filter
keeps the default context footprint small without hiding capability from
operators who opt in.

**Note on `UM_SUMMARIZE_MODEL` config parity:** The summarization model can be
configured in `server/.env` as `UM_SUMMARIZE_MODEL`. If you also set this in
your CC shell env (for `claude-agent-sdk` mode), keep the two in sync — the
server `.env` value is authoritative for server-side summarization, but
`hooks/lib/summarize.sh` reads from the CC shell env for hook-driven
summarization. Mismatches result in different model tiers being used for
server vs hook paths.

---

## Project soft-default policy (v1.1 F1)

When a **write tool** (`memory_capture`, `memory_add`, `memory_append_turn`,
`memory_checkpoint`) is called without a `metadata.project` / `project` slug,
the server falls back to the value of `UM_DEFAULT_PROJECT` (literal `default`
when unset). A one-line warn appears in the server log so operators can see
soft-default writes accumulating:

```
{"level":"warn","tool":"memory_add","project_effective":"default", ...,
 "reason":"caller_omitted_project","msg":"memory_add: caller omitted project; defaulting to \"default\" (set UM_DEFAULT_PROJECT to override the fallback slug)."}
```

**Read tools** (`memory_state`, `memory_recent`) intentionally **keep their
hard-fail** on a missing project — silently returning data from the fallback
project would be more surprising than the error. `memory_search` remains
project-optional (post-filter; missing project searches across all).

Wrong-type or regex-failing slugs (e.g. `../escape`, `my project`) still
hard-fail with `INPUT_INVALID` on every tool — the soft-default only applies
to the *omitted* arm (undefined / null / empty string).

This policy resolves the heterogeneous-default behavior the
[A1 audit](audits/2026-05-08-cross-surface-defaults.md) §F1 + §F5 + §F6 called
out (three different responses to the same omission across the four write
tools pre-v1.1).

---

## Lane / persona schema (v1.1 D2)

Additive metadata partitions for **qdrant writes**. Both fields are slug-shaped (validated by F1's canonical `PROJECT_SLUG_RE = /^[a-zA-Z0-9._-]+$/`), single-valued, optional. Direct advance of [#72](https://github.com/goldenwo/universal-memory/issues/72) **axis 5 (auto context routing)** — D2 ships the schema substrate; the LLM auto-classifier that populates the fields is D3+ scope.

| Field | Purpose | Examples |
|---|---|---|
| `lane` | Topic-area / context partition | `work`, `personal`, `writing`, `side-project` |
| `persona` | Identity-aspect partition | `me-engineer`, `me-parent`, `me-author` |

**Write surfaces (qdrant-backed) accept lane/persona on `metadata`:**

- `memory_capture` (MCP)
- `memory_add` (MCP)
- REST `POST /api/add`

`memory_append_turn` and `memory_checkpoint` are NOT extended in D2 — those tools write to vault filesystem only and do not flow through `umAdd()`. Their lane/persona affordance is deferred to a future phase that introduces vault-frontmatter `lane:` / `persona:` keys.

**Read surface (qdrant-backed) accepts lane/persona on `filters`:**

- `memory_search` (MCP) — `args.filters.{lane, persona}`
- REST `POST /api/search` — `body.filters.{lane, persona}`
- REST `GET /api/search` — does NOT support `filters` (query-string form); lane/persona filtering requires POST

Read filters AND-combine with the existing `filters.project` and `filters.type`. `memory_list`, `memory_recent`, `memory_state` are vault-backed and NOT extended in D2.

**Operator-visible read-filter semantics on pre-D2 points:** an explicit `filters.lane='<slug>'` excludes points whose payload has no `lane` key (the JS post-filter compares `r.metadata.lane === filters.lane` → `undefined !== '<slug>'` → excluded). Pre-D2 points remain visible only on no-filter queries. A future Phase F backfill sweep can retroactively populate lane/persona on legacy points.

**Dedup partition guarantee (interacts with v1.1 D1):** same text + same userId + same (lane, persona) → DEDUP_MERGED (one record). Different lane → 2 records. Different persona (within the same lane) → 2 records. Lane-set new write + legacy no-lane existing point → 2 records (asymmetric back-compat). Legacy + new-write-without-lane → DEDUP_MERGED (symmetric back-compat).

**Absence semantics:** omitted lane/persona (undefined / null / `""` / whitespace-only) → payload contains NO `lane` / `persona` key (not `null`, not `""`, not `"default"`). The validator throws `INPUT_INVALID` BEFORE any side effect on non-string or regex-mismatch input — failure-fast, no partial vault writes.

**No env var.** Lane and persona ship coherent from day one — no historical heterogeneity to unify, no `UM_DEFAULT_LANE` equivalent of F1.

**Qdrant payload index.** Server boot creates payload indexes on `lane` and `persona` (idempotent on 409 conflict; WARN-not-throw on other errors). Filtered queries hit the index; pre-D2 deployments with no indexes degrade to full-scan until a server restart re-runs the init.

---

## Tools

### memory_search

Semantic search over stored memories using vector similarity, with optional status and metadata filters. Returns compact shape `{ id, title, score, snippet }` by default (snippet = title + first 240 chars of body). Pass `full=true` to get full document bodies.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `query` | string | — (required) | Semantic search query |
| `limit` | number | 5 (50 when `only_superseded`) | Max results (max 100 on normal path; pagination window on `only_superseded` path) |
| `offset` | number | 0 | Pagination offset — used with `only_superseded` |
| `include_superseded` | boolean | false | Include docs with status: superseded/deprecated/rejected |
| `only_superseded` | boolean | false | Return ONLY superseded records (inverts the default exclusion). See below. |
| `filters.project` | string | — | Filter by project name |
| `filters.type` | string | — | Filter by doc type (e.g. `session_summary`, `authored`, `state`) |
| `filters.lane` | string | — | Filter by lane partition (v1.1 D2) |
| `filters.persona` | string | — | Filter by persona partition (v1.1 D2) |
| `full` | boolean | false | Return full bodies instead of compact shape |

**`only_superseded` — two-mode listing (v1.1 D3.1):**

Available on all three search surfaces: `memory_search` (MCP), `POST /api/search`, and `GET /api/search` (query param `only_superseded=true`). Used by operators and the auto-supersession system to inspect supersession history. Inverts the default status exclusion: returns ONLY records with `metadata.status === 'superseded'`. A no-status (pre-D3) record is NOT returned in this mode.

**Mode (a) — partition-scoped (when `filters.lane` and/or `filters.persona` given):**
Returns superseded records within that lane/persona partition only. Uses the same AND-combined lane/persona JS post-filter as the normal D2 path. **Available on MCP and REST POST only** — GET query-string form does not support `filters`, so GET is mode (b) only.

**Mode (b) — cross-partition (neither `filters.lane` nor `filters.persona` given):**
Returns ALL superseded records for the user across every partition. Each returned row exposes its `lane`, `persona`, and `supersededBy` so the operator can see which partition each record came from. In `full=true` mode these are carried in the `metadata` object; in compact mode they are added as top-level row fields. GET always runs in mode (b).

**Pagination on GET:** use `?only_superseded=true&offset=<n>&limit=<n>` (default limit 50, default offset 0).

**Sort:** `supersededAt` DESC (newest supersession first), then `id` ASC as a stable tiebreaker for equal timestamps — deterministic across repeated calls.

**Pagination:** `limit` (default **50** when `only_superseded` is set; caller-supplied value takes precedence) and `offset` (default 0). After sort, returns `slice(offset, offset + limit)`. Page 2 example: `limit: 10, offset: 10`.

**Precedence:** if both `only_superseded: true` and `include_superseded: true` are passed, `only_superseded` wins — it is the more specific intent. The result set contains ONLY superseded records.

**Inert when unset:** when `only_superseded` is absent or false, the handler behaves exactly as before — the default exclusion path is byte-identical and unaffected.

**Compact response (default):**

```json
{
  "results": [
    { "id": "arch-decision-v2", "title": "Architecture decision v2", "score": 0.92, "snippet": "Architecture decision v2\n\nWe chose Qdrant for vector sto..." }
  ]
}
```

**Full response (`full=true`):**

```json
{
  "results": [
    { "id": "arch-decision-v2", "title": "Architecture decision v2", "score": 0.92, "body": "# Architecture decision v2\n\nFull content here...", "metadata": { "type": "authored", "project": "universal-memory", "status": "current", "valid_from": "2026-04-17T14:00:00Z" } }
  ]
}
```

**When to use `full=true`:** When you need to read the actual content of matched documents — for example, to summarize decisions or extract details. For deciding *which* documents exist or scoring relevance, compact shape is sufficient and cheaper.

**Example — compact search:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params": {
      "name": "memory_search",
      "arguments": {
        "query": "session continuity architecture",
        "limit": 5,
        "filters": { "project": "universal-memory" }
      }
    }
  }'
```

**Example — full bodies for session summaries:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params": {
      "name": "memory_search",
      "arguments": {
        "query": "v0.4 hybrid rebalance progress",
        "filters": { "type": "session_summary", "project": "universal-memory" },
        "full": true
      }
    }
  }'
```

---

### memory_add

Add a fact to long-term memory (mem0 extraction pipeline).

**Input schema:**

```json
{
  "text": "string (required)",
  "metadata": "object (optional) — when omitted or missing `project`, the soft-default project slug from UM_DEFAULT_PROJECT (or \"default\") is injected. See [Project soft-default policy](#project-soft-default-policy-v11-f1)."
}
```

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params": {
      "name": "memory_add",
      "arguments": { "text": "The project uses Qdrant for vector storage." }
    }
  }'
```

---

### memory_list

List all stored memories. Returns compact shape `{ id, title, snippet }` by default. Pass `full=true` to get full document bodies including all metadata.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `full` | boolean | false | Return full bodies instead of compact shape |

**Compact response (default):**

```json
{ "results": [ { "id": "arch-decision-v2", "title": "Architecture decision v2", "snippet": "Architecture decision v2\n\nWe chose Qdrant..." } ] }
```

**When to use `full=true`:** Use compact for browsing/discovery (much cheaper for large vaults). Use `full=true` only when you need to read actual document bodies — e.g., a bulk export or vault-wide audit.

**Example — compact list:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_list","arguments":{}}}'
```

**Example — full bodies:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_list","arguments":{"full":true}}}'
```

---

### memory_delete

Delete a memory by ID.

**Input schema:**

```json
{ "memoryId": "string (required)" }
```

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":4,"method":"tools/call",
    "params": { "name": "memory_delete", "arguments": { "memoryId": "abc123" } }
  }'
```

---

### memory_state

Fetch the `state.md` for a project — direct file read from the vault, does not touch mem0. Use this to get the current state-of-play for a project at session start.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `project` | string | — (required) | Project name. Pattern: `^[a-zA-Z0-9._-]+$` |

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":5,"method":"tools/call",
    "params": { "name": "memory_state", "arguments": { "project": "universal-memory" } }
  }'
```

**Response (file exists):**

```json
{
  "ok": true,
  "project": "universal-memory",
  "state": {
    "frontmatter": { "type": "state", "id": "...", "valid_from": "2026-04-17T..." },
    "body": "# State of play\n..."
  },
  "valid_from": "2026-04-17T14:32:00Z"
}
```

**Response (file missing):**

```json
{ "ok": true, "project": "universal-memory", "state": null, "valid_from": null }
```

**Note:** `valid_from` is hoisted from frontmatter to the top-level response for quick age checks without parsing the body.

---

### memory_recent

Fetch recent memories from a project's `authored/` directory, sorted by filesystem mtime descending (newest file first). Returns compact shape `{ id, title, snippet }` by default; pass `full=true` for full bodies including `body` and `metadata` fields.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `project` | string | **required** | Project name (must match `^[a-zA-Z0-9._-]+$`) |
| `limit` | number | 10 | Max results |
| `full` | boolean | false | Return full bodies instead of compact shape |

**Compact response (default):**

```json
{ "results": [ { "id": "session-2026-04-21", "title": "Session 2026-04-21", "snippet": "Session 2026-04-21\n\nCompleted B.3.1a: write-tool filtering..." } ] }
```

**Full response (`full=true`):**

```json
{ "results": [ { "id": "session-2026-04-21", "title": "Session 2026-04-21", "snippet": "...", "body": "# Session 2026-04-21\n\nFull body text..." } ] }
```

**When to use `full=true`:** Use compact to see which recent documents exist. Use `full=true` to actually read the content — for example, to orient at session start or answer questions about recent progress.

**Example — compact recent sessions:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":6,"method":"tools/call",
    "params": {
      "name": "memory_recent",
      "arguments": { "project": "universal-memory", "limit": 3 }
    }
  }'
```

**Example — full bodies for last 2 sessions:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":6,"method":"tools/call",
    "params": {
      "name": "memory_recent",
      "arguments": { "project": "universal-memory", "limit": 2, "full": true }
    }
  }'
```

---

### memory_capture

Write a new authored document to the vault and reindex it.

**Requires `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`.**

**Input schema:**

```json
{
  "content": "string (required) — markdown body, no frontmatter",
  "metadata": {
    "type": "string (required)",
    "id": "string (required) — becomes the filename stem",
    "title": "string (required)",
    "project": "string (optional) — defaults to UM_DEFAULT_PROJECT (or \"default\") when omitted; see [Project soft-default policy](#project-soft-default-policy-v11-f1)",
    "...": "any other frontmatter fields"
  }
}
```

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":7,"method":"tools/call",
    "params": {
      "name": "memory_capture",
      "arguments": {
        "content": "Key insight from today: the MCP surface is now complete.",
        "metadata": {
          "type": "authored",
          "id": "insight-mcp-complete-2026-04-17",
          "title": "MCP surface complete",
          "project": "universal-memory"
        }
      }
    }
  }'
```

**Response:** `{ "ok": true, "path": "authored/universal-memory/insight-mcp-complete-2026-04-17.md", "id": "...", "indexed": true }`

**Response (writes disabled):** `{ "ok": false, "error": "MCP writes disabled; set UM_MCP_WRITE_ENABLED=true ..." }`

---

### memory_append_turn

Append a conversation turn to the raw-capture pipeline for a project. Enables non-CC surfaces (Claude.ai, ChatGPT Desktop, Codex) to feed raw turns into the vault — the same captures that the Claude Code Stop hook writes automatically. Subsequent `memory_checkpoint` calls will synthesize these turns into session summaries and refresh `state.md`.

Distinct from `memory_add` (mem0 fact extraction, no project structure) and `memory_capture` (authored documents with frontmatter). Use `memory_append_turn` when you want turn-level capture that feeds the session-end pipeline.

**Requires `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`.**

**Parameters:**

| Arg | Required | Default | Purpose |
|-----|----------|---------|---------|
| `project` | no (v1.1 F1) | `UM_DEFAULT_PROJECT` (or `default`) | Project slug (`^[a-zA-Z0-9._-]+$`). Omitting it triggers the soft-default + a warn log — see [Project soft-default policy](#project-soft-default-policy-v11-f1). Invalid slugs still hard-fail. |
| `content` | yes | — | Turn text (max 8192 bytes UTF-8; server returns an error if exceeded — split long turns or truncate) |
| `role` | yes | — | `user` / `assistant` / `system` |
| `timestamp` | no | now-UTC | ISO 8601 timestamp |
| `conversation_id` | no | — | Optional grouping hint (max 256 bytes, printable ASCII only — no newlines, CR, or control chars) |

> Note: raw-capture files contain heterogeneous headers — Claude Code's stop.sh
> writes `## <ISO>\n` (transcript-only, no role); `memory_append_turn` writes
> `## <ISO> <role> [(conversation_id: ...)]` (always has role). The summarizer
> accepts both formats.

**Example request (JSON-RPC via MCP):**

```json
{ "project": "myproj", "content": "Hello", "role": "user" }
```

**Example (curl):**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":10,"method":"tools/call",
    "params": {
      "name": "memory_append_turn",
      "arguments": {
        "project": "myproj",
        "content": "What is the current state of the universal-memory project?",
        "role": "user"
      }
    }
  }'
```

**Response (success):**

```json
{
  "schema_version": 1,
  "ok": true,
  "path": "captures/myproj/raw/2026-04-22.md",
  "appended": true,
  "bytes_written": 384
}
```

**Response (writes disabled):** `{ "ok": false, "error": "MCP writes disabled; set UM_MCP_WRITE_ENABLED=true ..." }`

---

### memory_checkpoint

Trigger a session summary + state refresh for the given project. Pipeline: reads raw captures → LLM-summarizes → writes to `sessions/<project>/` → merges into `state/<project>/state.md` atomically → re-indexes into mem0. Cost-capped per day per project. Parity with `/um-checkpoint` in Claude Code.

**Requires `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`.**

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `project` | string | `UM_DEFAULT_PROJECT` (or `default`) since v1.1 F1 | Project slug. Omitting it triggers the soft-default + a warn log — see [Project soft-default policy](#project-soft-default-policy-v11-f1). Invalid slugs still hard-fail. |
| `since` | string (ISO 8601) | last session_summary.valid_from | Catchup lower bound; optional |
| `until` | string (ISO 8601) | now | Catchup upper bound; optional |
| `skip_state_merge` | boolean | false | Summary-only run; omit state.md reindex; optional |

**Response (success):**

```json
{
  "schema_version": 1,
  "ok": true,
  "summary_id": "session-2026-04-23T14-32-00Z",
  "summary_path": "sessions/universal-memory/session-2026-04-23T14-32-00Z.md",
  "state_updated": true,
  "state_path": "state/universal-memory/state.md",
  "cost_usd": 0.0023,
  "tokens_in": 1840,
  "tokens_out": 412,
  "duration_ms": 5200
}
```

**Response (writes disabled):** `{ "ok": false, "error": "MCP writes disabled; set UM_MCP_WRITE_ENABLED=true ..." }`

**Note:** If `UM_SUMMARIZER=claude-agent-sdk` is set server-side, it falls back to `openai`/`ollama` with a warning log because Docker cannot spawn a host-side Claude Code process.

---

### memory_forget

Deprecate a document — sets `status=deprecated` and `invalidated_at=<now>` in its frontmatter, then reindexes so mem0 reflects the updated status.

**Requires `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`.**

**Input schema:**

```json
{ "id": "string (required) — document ID (filename stem without .md)" }
```

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":8,"method":"tools/call",
    "params": {
      "name": "memory_forget",
      "arguments": { "id": "old-decision-2025-01-01" }
    }
  }'
```

**Response:** `{ "ok": true, "id": "old-decision-2025-01-01", "path": "authored/.../old-decision-2025-01-01.md", "status": "deprecated" }`

---

### memory_supersede

Replace an existing document with a new one. Old doc gets `status=superseded`, new doc is created with `supersedes: [old_id]`. Both are reindexed.

**Requires `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`.**

**Input schema:**

```json
{
  "old_id": "string (required) — ID of the document to supersede",
  "new_doc": {
    "type": "string (required)",
    "id": "string (required) — new document ID",
    "title": "string (required)",
    "content": "string (required) — markdown body",
    "project": "string (optional)",
    "...": "any other frontmatter fields"
  }
}
```

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":9,"method":"tools/call",
    "params": {
      "name": "memory_supersede",
      "arguments": {
        "old_id": "arch-decision-v1",
        "new_doc": {
          "type": "authored",
          "id": "arch-decision-v2",
          "title": "Architecture decision v2",
          "content": "Updated architecture details...",
          "project": "universal-memory"
        }
      }
    }
  }'
```

**Response:**

```json
{
  "ok": true,
  "old_id": "arch-decision-v1",
  "new_id": "arch-decision-v2",
  "old_status": "superseded",
  "new_status": "current",
  "indexed": { "old": true, "new": true }
}
```

#### `unsupersede` action (v1.1 D3.1 — operator undo)

Flip a previously-superseded qdrant-fact point back to `status:'current'`. This is the inverse of the supersede path — an operator undo surface for when a supersession was applied in error or needs reverting.

**Requires `UM_MCP_WRITE_ENABLED=true`.**

**Input schema:**

```json
{
  "action": "unsupersede",
  "id": "string (required) — qdrant point ID of the superseded fact to restore"
}
```

The `id` must pass the same `validateSafeName` check as all other write operations (slug-shaped: `/^[a-zA-Z0-9._-]+$/`). The vault-doc path of `memory_supersede` (the `old_id` / `new_doc` form above) is unchanged — `unsupersede` applies only to qdrant-fact points.

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $UM_AUTH_TOKEN" \
  -d '{
    "jsonrpc":"2.0","id":10,"method":"tools/call",
    "params": {
      "name": "memory_supersede",
      "arguments": {
        "action": "unsupersede",
        "id": "arch-decision-v1"
      }
    }
  }'
```

**Response:**

```json
{
  "ok": true,
  "id": "arch-decision-v1",
  "status": "current"
}
```

---

## Write tools — enabling

To enable the 7 write tools (`memory_add`, `memory_delete`, `memory_capture`,
`memory_checkpoint`, `memory_forget`, `memory_supersede`, `memory_append_turn`), set in your `.env`:

```env
UM_MCP_WRITE_ENABLED=true
UM_MOUNT_MODE=rw
```

Then restart the container:

```bash
docker compose restart memory-server
```

The vault mount mode must be `rw` for writes to persist. When
`UM_MCP_WRITE_ENABLED=false` (the default), two things happen:
1. `tools/list` filters the 7 write tools out entirely — clients see only the 4 reads.
2. Direct `tools/call` against a write tool returns `{ ok: false, error: "MCP writes disabled" }` rather than throwing.

The second behavior is intentional: clients that discovered the writes from
an older `tools/list` response (or via the OpenAPI schema) get a graceful
error, not an HTTP 500.

---

## Security

### MCP write tools expose the vault over HTTP

With `UM_MCP_WRITE_ENABLED=true` and the default Docker port mapping, the MCP server accepts unauthenticated write requests from any host that can reach port 6335. This includes:
- Other devices on your LAN (hotel Wi-Fi, coffee-shop Wi-Fi, office network)
- Browser tabs from any domain (CORS is `*`)

Before enabling writes, do one of:
1. **Bind to localhost only** (recommended for single-machine use): set `MEM0_MCP_PORT=127.0.0.1:6335` in `.env` so Docker binds only to localhost.
2. **Front with a reverse proxy** that requires auth — nginx+basic-auth, Cloudflare Access, Tailscale Funnel, etc.
3. **Restrict to a private overlay network** — Tailscale, WireGuard, ZeroTier.

Without one of these, any device on your current network can read and write your entire memory vault.

The server refuses to index or write through symlinks inside the vault.

---

## Extending

### Adding a new MCP tool

To register a new MCP tool that mutates the vault (write tool):

1. Implement `server/lib/<name>.mjs` exporting a `do<Name>(args, ctx)` function
   with the DI pattern `{ vaultDir, memoryClient = memory }` so it's
   unit-testable.
2. Add a unit test at `server/test/<name>.test.mjs` (fixture-driven per
   spec §4 principle).
3. Add the tool name to `WRITE_TOOL_NAMES` in `server/mem0-mcp-http.mjs`.
4. Add an entry to the `TOOLS` array in the same file — include full
   `inputSchema` with required/optional fields. Include `schema_version` in
   the response shape per spec §4 "version your contracts."
5. Wire `case '<name>':` in the `tools/call` dispatcher to call your
   `do<Name>`.
6. Add a REST route `POST /api/<endpoint>` and an OpenAPI path entry in
   `server/openapi.mjs`. Add request + response components. Include
   `schema_version` field in the response schema.
7. Re-run `actions-trimmed.yaml` regen: `( cd server && node -e "..." ) > ...`.
8. Add a smoke test in `server/test/smoke.sh` at the next free `T10-<letter>`
   label.

Follow `memory_append_turn` (v0.5) as the reference example. For read-only
tools, skip step 3 and add routes under the 4-default-visible set instead.

### `GET /openapi.yaml` is intentionally unauthenticated

The server exposes its OpenAPI 3.1 schema at `GET /openapi.yaml` (plus a
trimmed Custom-GPT-friendly subset at `GET /openapi.yaml?gpt=1`). Both
endpoints are **intentionally unauthenticated and non-sensitive** — they
describe the public HTTP surface (routes, parameter shapes, response schemas)
only, and expose no vault contents, no memory IDs, no user data. Treat the
schema like the HTML of a public login page: it advertises what the server
will accept, not what the vault contains.

If you front the server with a reverse proxy, you can still optionally
gate `/openapi.yaml` behind auth — but doing so breaks ChatGPT Custom GPT's
"Import from URL" flow, which requires unauthenticated schema fetch.

### Adding a summarizer backend

To register a new summarizer backend (e.g. anthropic, google, a custom
local endpoint):

1. Write an invoke function in `server/lib/summarize.mjs` with the
   signature `async (transcript, ctx) => ({summary, costUsd, tokensIn, tokensOut})`.
2. Add a registry entry to `BACKENDS`: `{ name: 'foo', invoke: fooInvoke, requires: ['FOO_KEY'] }`.
3. Drop an optional fallback: `{ name: 'foo', invoke: null, fallback: 'openai', reason: 'upstream TBD' }`.
4. Tests in `server/test/summarize.test.mjs` iterate `Object.keys(BACKENDS)` —
   new backends are auto-covered; add a backend-specific case only if stubbing differs.

v0.7's provider-neutrality theme uses this pattern to add anthropic +
google + additional ollama variants without touching dispatch logic.
