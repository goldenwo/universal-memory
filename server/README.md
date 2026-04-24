# Memory server

Self-hostable backend for the universal-memory system. Packaged as a single Docker Compose stack.

**Status:** v0.1 — Docker Compose + vector memory server, smoke-tested. No graph memory yet (Kuzu deferred to v0.2), no synthesis-pass cron.

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
./install.sh                        # interactive wizard — prompts for API key, writes .env, brings up stack, polls /health
bash test/smoke.sh                  # optional end-to-end round-trip test
```

For advanced / CI use, run the wizard non-interactively:

```bash
UM_NONINTERACTIVE=1 OPENAI_API_KEY=sk-... MEM0_USER_ID=your-id ./install.sh
```

Or skip the wizard entirely and drive things by hand:

```bash
cp .env.example .env    # then edit .env: set OPENAI_API_KEY, MEM0_USER_ID
docker compose up -d
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

## Advanced: writes-enabled install (v0.5+)

By default the container mounts the vault read-only (`UM_MOUNT_MODE=ro`) and
MCP write tools are gated off (`UM_MCP_WRITE_ENABLED=false`). That's the safe
production posture.

To opt into the MCP write surface (`memory_append_turn`, `memory_checkpoint`,
`memory_capture`, `memory_forget`, `memory_supersede`), pass the env overrides
to install.sh. Both MUST be set together — `install.sh` rejects `UM_MOUNT_MODE=rw`
without `UM_MCP_WRITE_ENABLED=true`:

```bash
UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-... \
  MEM0_USER_ID=your-id \
  UM_VAULT_DIR=/path/to/your/vault \
  UM_MOUNT_MODE=rw \
  UM_MCP_WRITE_ENABLED=true \
  UM_CONTAINER_USER="$(id -u):$(id -g)" \
  ./install.sh
```

`UM_CONTAINER_USER` pins the container UID:GID to match the host user so the
files the server writes into the mounted vault are owned by you on the host
— without it, the container runs as `node` (UID 1000) and the vault ends up
with files the host user can't cleanly overwrite/delete.

**Pin it ONCE on the first `docker compose up`** and don't change the value
mid-lifecycle. Changing the UID while the vault already has content causes
mixed ownership that blocks later overwrites with EACCES. If you must change
it, stop the stack, `chown -R <new-uid>:<new-gid> <vault-dir>`, then bring
the stack back up.

`UM_CONTAINER_USER` accepts the literal `node` (default) or a numeric
`<uid>:<gid>` pair with both values > 0. `install.sh` rejects root (`0:0`)
and any zero in either half — combined with `UM_MOUNT_MODE=rw` that would
get root inside the container writing to the host vault.

## Upgrade

```bash
git pull
docker-compose pull
docker-compose up -d
```

## Alternative: bare install (no Docker)

See [systemd/README.md](systemd/README.md) — TBD.
