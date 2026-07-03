# universal-memory

Self-hosted AI memory that closes the session-continuity gap across every Claude surface.

[![smoke](https://github.com/goldenwo/universal-memory/actions/workflows/smoke.yml/badge.svg)](https://github.com/goldenwo/universal-memory/actions/workflows/smoke.yml)
[![release](https://github.com/goldenwo/universal-memory/actions/workflows/release.yml/badge.svg)](https://github.com/goldenwo/universal-memory/actions/workflows/release.yml)

Published images: `ghcr.io/goldenwo/universal-memory-server` — semver tags (`X.Y.Z`, `X.Y`) and `latest` for stable releases.

---

## The problem

Claude Code, Claude.ai, and Claude Desktop share no memory by default. A decision made in a morning coding session is invisible to an afternoon writing session and invisible to tomorrow. universal-memory fixes that: one memory store, accessible from every Claude surface, so context follows you instead of resetting each time.

---

## What you get

- **Session continuity** — a `state.md` file per project is injected at the start of every session. Current focus, in-flight work, recent decisions, next actions — all there without manual setup.
- **Cross-surface access** — any MCP client (Claude Code, Claude.ai connector, Claude Desktop) can read and write memory via 11 MCP tools (4 read tools visible by default; write tools opt-in via `UM_MCP_WRITE_ENABLED=true`). Progressive disclosure: read responses return compact snippets by default; opt into full bodies via `?full=1` or `full: true`. Work captured in Claude Code is visible from Claude.ai the same day.
- **Cross-env first-class capture** — capture is not Claude Code-only. Claude.ai, ChatGPT Desktop, and Codex use `memory_append_turn` to feed conversation turns directly into the raw-capture pipeline, and `memory_checkpoint` to trigger session summaries and `state.md` refresh — the same pipeline that Claude Code's Stop/SessionEnd hooks drive automatically.
- **Command-line toolkit** — 7-subcommand `um` CLI (`search`, `state`, `recent`, `list`, `capture`, `tail`, `--version`) for shell scripts, cron jobs, and power-user workflows. Composable with grep / awk / jq. Installs standalone via `installer/install-cli.sh` against any reachable UM server.
- **Authored knowledge that lasts** — structured documents (ADRs, character sheets, hypotheses, goals, strategies) live in plain markdown with frontmatter versioning. Superseded documents are auditable; current ones are surfaced by default. **New in v1.1:** two Claude Code skills cover both authored and casual capture. `/adr "<title>"` writes an ADR to `docs/decisions/NNNN-<slug>.md` in the consumer's repo, commits it, and registers the decision atomically with the UM server in one step. `/remember <text>` is the doctype-free counterpart for casual no-project saves — POSTs the fact directly to the server (no file, no git repo required), with D1 dedup ensuring identical text is idempotent by content.
- **Markdown as source of truth** — no vendor lock-in. If any component (vector store, LLM provider, plugin format) is replaced, your knowledge survives as readable files under git.
- **Upstream bridges** — one-way ingest from external memory stores. The first bridge, `um-bridge-claude-mem`, mirrors your claude-mem session history into the UM vault as searchable markdown so cross-surface queries see it too. Bridge-emitted content is fenced with `<external-summary source="…">` markers so the summarizer treats it as data, not instruction. See [`docs/bridges.md`](docs/bridges.md).

---

## Who this is for

Anyone who uses Claude across multiple sessions and wants continuity. This is not a coder-only tool.

- A novelist tracking character sheets, plot decisions, and chapter notes across weeks of writing sessions.
- A researcher logging hypotheses, experiment outcomes, and literature notes across tools.
- A person tracking life goals, learning plans, and personal decisions.
- A team capturing architecture decisions, quarterly strategies, and meeting outcomes.
- A developer who wants session state and ADRs to follow them across machines and surfaces.

---

## How it differs from alternatives

**vs mem0** — mem0 is the vector-search engine inside universal-memory. UM adds on top: session continuity (`state.md` injection at every session start), structured authored knowledge with versioning, and a cross-surface MCP interface. Using mem0 alone means no session state, no catchup mechanism, no document versioning.

**vs Claude-mem** — Claude-mem is Claude Code-only. universal-memory is cross-surface: Claude.ai, Claude Desktop, and any MCP client can read and write the same memory store via the server. **The two compose**: `um-bridge-claude-mem` ingests claude-mem's session history into the UM vault, so a session logged in Claude Code becomes searchable from Claude.ai too.

**vs Obsidian** — Obsidian is a PKM tool for humans. universal-memory is agent-accessible: the same vault that a human can open in any editor can also be queried by agents at conversation speed via the MCP surface.

---

## Three surfaces, one vault

universal-memory exposes the same vault through three equal-peer interfaces:

- **MCP** — every Claude surface (Code, Desktop, Claude.ai) + Codex + Custom GPT via the [Model Context Protocol](https://modelcontextprotocol.io). Progressive disclosure: read responses default to compact snippets; request full bodies explicitly.
- **REST** — OpenAPI 3.1 at `/openapi.yaml`. Use from ChatGPT Custom GPT Actions, the OpenAI Responses API, or any HTTP client. Same compact-shape defaults.
- **CLI (`um`)** — 7-subcommand shell toolkit for scripting, cron, and power-user flows. Composable with grep / awk / jq.

All three read and write the same markdown vault. Pick whichever fits the moment; switch freely.

---

## Quickstart

### 1. Start the memory server

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
cp .env.example .env         # set OPENAI_API_KEY and VAULT_PATH
docker compose up -d
```

Or use the one-command install wizard — see [docs/quickstart.md](docs/quickstart.md).

### 1b. (Optional) Install the `um` CLI

For shell scripting, cron jobs, or power-user flows, install the CLI independently of the server. Point it at any reachable UM server (local or remote):

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory
bash installer/install-cli.sh
```

See [installer/install-cli.md](installer/install-cli.md) for full details, and [docs/um-cli.md](docs/um-cli.md) for the 7-subcommand reference.

### 2. First Claude Code session with the UM plugin

Install the plugin (see [docs/quickstart.md](docs/quickstart.md) for the exact command). Open a Claude Code session. As you work, the Stop hook appends raw captures to the vault. Nothing else is required.

### 3. Second Claude Code session — continuity works

At the start of the next session, the SessionStart hook:
- Detects unprocessed captures from the previous session.
- Synthesizes them into a session summary.
- Writes a fresh `state.md`.
- Injects `state.md` as context before your first message.

Your current focus, in-flight tasks, recent decisions, and next actions are waiting.

### 4. Force a checkpoint mid-session

At any point during a session, run:

```
/um-checkpoint
```

This immediately refreshes `state.md` from accumulated captures. Useful after a significant decision you want captured before continuing.

### 5. From Claude.ai or ChatGPT Desktop — connect and capture

Connect the MCP server to any MCP-capable surface via the connector URL (`http://your-host:6335/mcp`, or a tunnel URL for remote surfaces). Once connected:

```
memory_state("my-project")    # loads current state.md from the remote surface
memory_search("query")        # semantic search across all indexed documents
memory_capture(...)           # write a new document to the vault from the remote surface
```

> **Authentication.** Any request reaching UM through a tunnel or reverse proxy must include `Authorization: Bearer <UM_AUTH_TOKEN>`. See [docs/connecting-claude-ai.md](docs/connecting-claude-ai.md) or [docs/connecting-chatgpt-desktop.md](docs/connecting-chatgpt-desktop.md) for connector-specific setup. Loopback installs (Claude Desktop → `localhost:6335` directly) do not require auth.

Captures made from any surface are visible in Claude Code sessions and vice versa.

Surface-specific guides:
- **ChatGPT Desktop:** see [docs/connecting-chatgpt-desktop.md](docs/connecting-chatgpt-desktop.md) for tunnel options, connector setup, and the rubric paste-in.
- **Claude.ai / Claude Desktop:** see [docs/connecting-claude-ai.md](docs/connecting-claude-ai.md) for tunnel options, connector setup (web + desktop app), and the rubric paste-in.
- **ChatGPT Custom GPT (web):** see [plugins/chatgpt-custom-gpt/universal-memory/README.md](plugins/chatgpt-custom-gpt/universal-memory/README.md) for wiring UM's REST surface to a personal Custom GPT via Actions (search / state / add / delete; no MCP-only tools).
- **Codex CLI (OpenAI):** see [plugins/codex/universal-memory/README.md](plugins/codex/universal-memory/README.md) for the config-only plugin + MCP connector setup. **Recall-only.** Codex sessions can call `memory_search` / `memory_state` / `memory_capture` via MCP, but the automatic raw-capture + summary pipeline stays Claude-Code-only until Codex ships `SessionEnd`, plugin-bundled hooks, and Windows hook support. Background in [docs/codex-integration-notes.md](docs/codex-integration-notes.md).
- **OpenAI Assistants API (developer integration):** see [examples/openai-assistants/](examples/openai-assistants/) — Node + Python examples of an Assistant using UM as a memory tool. Smoke-tested end-to-end.
- **mem0 Platform clients (e.g. the OpenClaw memory plugin):** see [docs/mem0-compat.md](docs/mem0-compat.md) — a flag-gated facade (`UM_MEM0_COMPAT_ENABLED=true`) speaking the mem0 Platform HTTP dialect. Already on mem0? Point the client's `baseUrl` at your UM server and use your `UM_AUTH_TOKEN` as the API key — zero client changes.
- **CLI (`um`):** see [docs/um-cli.md](docs/um-cli.md) for the 7-subcommand reference (`search`, `state`, `recent`, `list`, `capture`, `tail`, `--version`).

---

## MCP tool surface

11 tools total — 4 read tools (`memory_search`, `memory_list`, `memory_state`, `memory_recent`) visible to any MCP client by default; 7 write tools (`memory_add`, `memory_capture`, `memory_checkpoint`, `memory_delete`, `memory_forget`, `memory_supersede`, `memory_append_turn`) visible only when `UM_MCP_WRITE_ENABLED=true`. See [docs/mcp-tools.md](docs/mcp-tools.md) for full schemas and examples.

Read tools (`memory_search`, `memory_list`, `memory_recent`, `memory_state`) return compact snippets by default (~200 bytes per hit); pass `full: true` to retrieve full bodies.

| Tool | Type | What it does |
|---|---|---|
| `memory_search` | read | Semantic search over indexed documents |
| `memory_list` | read | List all indexed memories |
| `memory_state` | read | Load `state.md` for a project |
| `memory_recent` | read | Recent authored docs for a project, filesystem-mtime-sorted (`project` required) |
| `memory_add` | write | Add a fact to the index |
| `memory_capture` | write | Write a new authored document to the vault |
| `memory_checkpoint` | write | Trigger session summary + state refresh |
| `memory_forget` | write | Deprecate a document by ID |
| `memory_supersede` | write | Replace a document; preserves audit chain |
| `memory_append_turn` | write | Append a conversation turn to raw-capture pipeline (non-CC surfaces) |
| `memory_delete` | write | Remove a memory from the index |

Write tools require `UM_MCP_WRITE_ENABLED=true` in your `.env`.

---

## Repository layout

```
universal-memory/
├── server/                      Self-hostable backend (Qdrant + mem0 + MCP endpoint)
├── installer/
│   ├── install.sh               Full server install wizard (docker compose + env)
│   └── install-cli.sh           Standalone `um` CLI install (no server required)
├── plugins/
│   ├── claude-code/             Claude Code plugin (hooks, /um-checkpoint skill)
│   ├── codex/                   Codex CLI plugin (config-only MCP connector)
│   └── chatgpt-custom-gpt/      ChatGPT Custom GPT recipe (Actions + system prompt)
├── docs/
│   ├── architecture.md          Two-tier design, three pillars, MCP surface
│   ├── state-of-play.md         state.md concept reference
│   ├── frontmatter-schema.md    Document schema and versioning reference
│   ├── mcp-tools.md             Full MCP tool reference with examples
│   ├── um-cli.md                `um` CLI subcommand reference
│   └── quickstart.md            Install walkthroughs
└── .github/workflows/           CI smoke tests and release pipeline
```

---

## Upgrading

universal-memory is in active 1.x development and may ship breaking changes between minor versions. Before updating a production install, consult both:

- [MIGRATION.md](MIGRATION.md) — step-by-step upgrade guidance per version transition (v0.3 → v0.4 → v0.5 → v0.6 → v0.7 → v0.8 → v1.0 → v1.1 → v1.2).
- [CHANGELOG.md](CHANGELOG.md) — full per-release notes (Added / Changed / Fixed / Docs).

Pin a release tag rather than tracking `latest` in production.

---

## License

MIT — see [LICENSE](LICENSE).
