# Memory server

Self-hostable backend for the universal-memory system. Packaged as a single Docker Compose stack.

**Status:** v0.1 — Docker Compose + vector memory server, smoke-tested. No graph (deferred to v0.2 per [ADR-0004](../docs/decisions/0004-kuzu-for-graph-memory.md)), no cron, no install wizard.

## What it runs

- **Qdrant** — vector store for fast semantic recall.
- **mem0 HTTP server** — exposes `/api/search`, `/api/add`, `/api/list`, `DELETE /api/:id`, and `/mcp` (JSON-RPC) endpoints. Wraps mem0 OSS with warm in-process Memory instance.
- **Cron jobs** — workspace consolidation, cross-project compile pass, ADR topic compilation.

## Prerequisites

- Docker Engine 20.10+ with Docker Compose v2
- An OpenAI API key (for embeddings + extraction LLM), or configure alternative provider
- ~1 GB free disk for the Qdrant collection (grows with memory volume)

## Run it

```bash
cp .env.example .env
# edit .env: set OPENAI_API_KEY and MEM0_USER_ID
docker compose up -d
curl http://localhost:6335/health   # expect {"ok":true,"memories":0}
bash test/smoke.sh                  # end-to-end round-trip test
```

To stop and remove: `docker compose down` (data persists in `./data/qdrant`).
To fully reset: `docker compose down && rm -rf ./data/qdrant`.

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
