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

---

## Tools

### memory_search

Semantic search with optional status and metadata filters.

**Input schema:**

```json
{
  "query": "string (required)",
  "limit": "number (optional, default 5, max 100)",
  "include_superseded": "boolean (optional, default false)",
  "filters": {
    "project": "string (optional)",
    "type": "string (optional)"
  }
}
```

**Example:**

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

**Response:** `{ "results": [ { "id": "...", "memory": "...", "score": 0.87, "metadata": {...} } ] }`

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

List all stored memories.

**Input schema:** `{}` (no parameters)

**Example:**

```bash
curl -s http://localhost:6335/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_list","arguments":{}}}'
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

Fetch the `state.md` for a project (direct file read, does not touch mem0).

**Input schema:**

```json
{ "project": "string (required, pattern: ^[a-zA-Z0-9._-]+$)" }
```

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

---

### memory_recent

Fetch recent `session_summary` documents, optionally filtered by project.

**Input schema:**

```json
{
  "project": "string (optional)",
  "limit": "number (optional, default 5)"
}
```

**Example:**

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

**Response:** `{ "results": [ ... ] }` — sorted by `valid_from` descending.

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

To enable the write tools (`memory_capture`, `memory_forget`, `memory_supersede`), set in your `.env`:

```env
UM_MCP_WRITE_ENABLED=true
UM_MOUNT_MODE=rw
```

Then restart the container:

```bash
docker compose restart memory-server
```

The vault mount mode must be `rw` for writes to persist. When `UM_MCP_WRITE_ENABLED=false`
(the default), the vault stays read-only to the server and write tools return a 
`{ ok: false, error: "MCP writes disabled" }` response rather than an error.

---

## Security — MCP write tools expose the vault over HTTP

**Security — MCP write tools expose the vault over HTTP**

With `UM_MCP_WRITE_ENABLED=true` and the default Docker port mapping, the MCP server accepts unauthenticated write requests from any host that can reach port 6335. This includes:
- Other devices on your LAN (hotel Wi-Fi, coffee-shop Wi-Fi, office network)
- Browser tabs from any domain (CORS is `*`)

Before enabling writes, do one of:
1. **Bind to localhost only** (recommended for single-machine use): set `MEM0_MCP_PORT=127.0.0.1:6335` in `.env` so Docker binds only to localhost.
2. **Front with a reverse proxy** that requires auth — nginx+basic-auth, Cloudflare Access, Tailscale Funnel, etc.
3. **Restrict to a private overlay network** — Tailscale, WireGuard, ZeroTier.

Without one of these, any device on your current network can read and write your entire memory vault.

The server refuses to index or write through symlinks inside the vault.
