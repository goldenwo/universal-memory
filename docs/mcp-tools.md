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

**Default visibility (v0.4):** `tools/list` returns the 4 read tools
(`memory_search`, `memory_list`, `memory_state`, `memory_recent`). The 6
write tools (`memory_add`, `memory_delete`, `memory_capture`,
`memory_checkpoint`, `memory_forget`, `memory_supersede`) are filtered out
unless `UM_MCP_WRITE_ENABLED=true` is set on the server — see
[Write tools — enabling](#write-tools--enabling). This schema-hygiene filter
keeps the default context footprint small without hiding capability from
operators who opt in.

---

## Tools

### memory_search

Semantic search over stored memories using vector similarity, with optional status and metadata filters. Returns compact shape `{ id, title, score, snippet }` by default (snippet = title + first 240 chars of body). Pass `full=true` to get full document bodies.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `query` | string | — (required) | Semantic search query |
| `limit` | number | 5 | Max results (max 100) |
| `include_superseded` | boolean | false | Include docs with status: superseded/deprecated/rejected |
| `filters.project` | string | — | Filter by project name |
| `filters.type` | string | — | Filter by doc type (e.g. `session_summary`, `authored`, `state`) |
| `full` | boolean | false | Return full bodies instead of compact shape |

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
  "metadata": "object (optional)"
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
    "project": "string (optional, default: default)",
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

### memory_checkpoint

Force a session summary and state update. **(stub, v0.3 — not implemented server-side)**

**Input schema:**

```json
{ "project": "string (optional)" }
```

**Response:** `{ "ok": false, "error": "memory_checkpoint is not implemented server-side in v0.2.x — run /um-checkpoint in Claude Code or execute hooks/session-end.sh directly. Full MCP-driven implementation requires hook-in-container infrastructure planned for v0.3." }`

This tool is advertised in the tools list so MCP clients can discover it. The server-side implementation is deferred to v0.3 because `session-end.sh` requires host filesystem access and env vars (`UM_OPENAI_API_KEY`) that are not available inside the container.

**Use instead:** In Claude Code, run `/um-checkpoint`. From a terminal, execute `hooks/session-end.sh` directly with `UM_PROJECT=<project>`.

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

---

## Write tools — enabling

To enable the 6 write tools (`memory_add`, `memory_delete`, `memory_capture`,
`memory_checkpoint`, `memory_forget`, `memory_supersede`), set in your `.env`:

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
1. `tools/list` filters the 6 write tools out entirely — clients see only the 4 reads.
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
