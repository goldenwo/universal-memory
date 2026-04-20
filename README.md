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
- **Cross-surface access** — any MCP client (Claude Code, Claude.ai connector, Claude Desktop) can read and write memory via 10 MCP tools. Work captured in Claude Code is visible from Claude.ai the same day.
- **Authored knowledge that lasts** — structured documents (ADRs, character sheets, hypotheses, goals, strategies) live in plain markdown with frontmatter versioning. Superseded documents are auditable; current ones are surfaced by default.
- **Markdown as source of truth** — no vendor lock-in. If any component (vector store, LLM provider, plugin format) is replaced, your knowledge survives as readable files under git.

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

**vs Claude-mem** — Claude-mem is Claude Code-only. universal-memory is cross-surface: Claude.ai, Claude Desktop, and any MCP client can read and write the same memory store via the server.

**vs Obsidian** — Obsidian is a PKM tool for humans. universal-memory is agent-accessible: the same vault that a human can open in any editor can also be queried by agents at conversation speed via the MCP surface.

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

Captures made from any surface are visible in Claude Code sessions and vice versa.

Surface-specific guides:
- **ChatGPT Desktop:** see [docs/connecting-chatgpt-desktop.md](docs/connecting-chatgpt-desktop.md) for tunnel options, connector setup, and the rubric paste-in.
- **Claude.ai / Claude Desktop:** see [docs/connecting-claude-ai.md](docs/connecting-claude-ai.md) for tunnel options, connector setup (web + desktop app), and the rubric paste-in.
- **ChatGPT Custom GPT (web):** see [plugins/chatgpt-custom-gpt/universal-memory/README.md](plugins/chatgpt-custom-gpt/universal-memory/README.md) for wiring UM's REST surface to a personal Custom GPT via Actions (search / state / add / delete; no MCP-only tools).
- **Codex CLI (OpenAI):** see [plugins/codex/universal-memory/README.md](plugins/codex/universal-memory/README.md) for the config-only plugin + MCP connector setup. **Recall only in v0.3** — Codex sessions can call `memory_search` / `memory_state` / `memory_capture` via MCP, but the automatic raw-capture + summary pipeline stays Claude-Code-only until Codex ships `SessionEnd`, plugin-bundled hooks, and Windows hook support. Background in [docs/codex-integration-notes.md](docs/codex-integration-notes.md).

---

## MCP tool surface

10 tools available to any MCP client:

| Tool | Type | What it does |
|---|---|---|
| `memory_search` | read | Semantic search over indexed documents |
| `memory_list` | read | List all indexed memories |
| `memory_state` | read | Load `state.md` for a project |
| `memory_recent` | read | Recent session summaries, date-sorted |
| `memory_add` | write | Add a fact to the index |
| `memory_capture` | write | Write a new authored document to the vault |
| `memory_checkpoint` | write | Force session summary + state refresh **(stub, v0.3)** |
| `memory_forget` | write | Deprecate a document by ID |
| `memory_supersede` | write | Replace a document; preserves audit chain |
| `memory_delete` | write | Remove a memory from the index |

Write tools require `UM_MCP_WRITE_ENABLED=true` in your `.env`. See [docs/mcp-tools.md](docs/mcp-tools.md) for full schemas and examples.

---

## Repository layout

```
universal-memory/
├── server/                      Self-hostable backend (Qdrant + mem0 + MCP endpoint)
├── plugins/
│   ├── claude-code/             Claude Code plugin (hooks, /um-checkpoint skill)
│   ├── codex/                   Codex CLI plugin (config-only MCP connector, v0.3)
│   └── chatgpt-custom-gpt/      ChatGPT Custom GPT recipe (Actions + system prompt)
├── docs/
│   ├── architecture.md          Two-tier design, three pillars, MCP surface
│   ├── state-of-play.md         state.md concept reference
│   ├── frontmatter-schema.md    Document schema and versioning reference
│   ├── mcp-tools.md             Full MCP tool reference with examples
│   └── quickstart.md            Install walkthroughs
└── .github/workflows/           CI smoke tests and release pipeline
```

---

## License

MIT — see [LICENSE](LICENSE).
