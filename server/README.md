# Memory server

Self-hostable backend for the universal-memory system. Packaged as a single Docker Compose stack.

**Status:** 🚧 Scaffold — implementation coming. Current working reference lives at `~/.openclaw/scripts/mem0-mcp-http.mjs` on the maintainer's Pi and will be lifted into this directory.

## What it runs

- **Qdrant** — vector store for fast semantic recall.
- **mem0 HTTP server** — exposes `/api/search`, `/api/add`, `/api/list`, `DELETE /api/:id`, and `/mcp` (JSON-RPC) endpoints. Wraps mem0 OSS with warm in-process Memory instance.
- **Cron jobs** — workspace consolidation, cross-project compile pass, ADR topic compilation.

## Prerequisites

- Docker Engine 20.10+ with Docker Compose v2
- An OpenAI API key (for embeddings + extraction LLM), or configure alternative provider
- ~1 GB free disk for the Qdrant collection (grows with memory volume)

## Install

```bash
cp .env.example .env
# Edit .env: set OPENAI_API_KEY, MEM0_USER_ID (any string), optional tuning
docker-compose up -d
```

Verify:

```bash
curl http://localhost:6335/health
# expected: {"ok": true, "memories": 0}
```

## Data

Qdrant data lives at `./data/qdrant/`. Back this up periodically, or rely on the re-ingestion pipeline (run over source markdown) as the recovery path.

## Endpoints

See [../docs/architecture.md](../docs/architecture.md) for the full protocol. Summary:

- `POST /api/search` — `{query, limit}` → top-K atomic facts
- `POST /api/add` — `{text}` → mem0 extraction pipeline stores atomic facts
- `GET /api/list` — all memories for the configured userId
- `DELETE /api/:id` — remove a specific memory
- `POST /mcp` — JSON-RPC for MCP clients (Claude Code, Claude Desktop)
- `GET /health` — liveness + memory count

## Configuration

See [.env.example](.env.example) for all knobs.

## Upgrade

```bash
git pull
docker-compose pull
docker-compose up -d
```

## Alternative: bare install (no Docker)

See [systemd/README.md](systemd/README.md) — TBD.
