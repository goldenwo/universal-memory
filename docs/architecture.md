# Architecture

## The problem universal-memory solves

Claude Code, Claude.ai, and Claude Desktop share no memory by default. Work done in a morning coding session is invisible to an afternoon writing session, invisible to a browser tab, invisible to tomorrow's session. Each surface starts cold.

universal-memory closes that gap. It gives every Claude surface access to the same structured memory store — session state, authored knowledge, and a searchable index — regardless of which surface made the capture.

---

## Two tiers

### Tier 1: Source-of-truth markdown files in the vault

The vault is a directory of plain `.md` files on the user's filesystem. Everything authoritative lives here.

- Authored documents: ADRs, character sheets, hypotheses, goals, strategies, session summaries.
- `state.md` files — one per project — holding current focus, in-flight work, recent decisions, and next actions.
- Raw session captures — append-only daily files written by the Stop hook.

**Invariant: if the vault is lost, data is lost.** Everything outside the vault is rebuildable from it. Back up the vault directory.

Specific paths:

```
$VAULT/authored/<project>/<id>.md   # authored documents
$VAULT/state/<project>/state.md     # state of play (one per project)
$VAULT/raw/<project>/YYYY-MM-DD.md  # append-only raw captures
```

Vault writes are controlled by who makes them. The Claude Code plugin hooks write directly (they run on the user's machine with full filesystem access). The memory server mounts the vault read-only by default; MCP writes go through the server only when `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` are set.

### Tier 2: Vector index (mem0 + Qdrant) over a subset of tier 1

The index is a semantic search cache over authored documents and session summaries. It powers fast relevance recall when there are hundreds of documents.

**What is NOT in tier 2:**

- `state.md` — accessed by direct file read only; never indexed. Indexing would create a stale copy; `state.md` is accessed via the SessionStart hook or the `memory_state` MCP tool, both of which read the file directly.
- Raw captures — consumed during synthesis and discarded from the index; the synthesis outputs (session summaries) are what gets indexed.

**Invariant: drop the vector store, re-run ingestion from vault, everything back.**

---

## Three pillars of v0.2.0

### Pillar 1: Session summaries

Every Claude Code session ends with a raw capture in `$VAULT/raw/<project>/YYYY-MM-DD.md`. The Stop hook appends each session's key events cheaply (no LLM call). At the next session start, a catchup process checks whether unprocessed captures exist and, if so, synthesizes them into a `session_summary` document (type: `session_summary` in frontmatter) and writes it to the vault. The summary is then indexed.

The asymmetry is intentional: **capture is cheap (Stop hook, always runs), synthesis is expensive (LLM call, runs once on next start)**. This means a crashed or force-quit session still captures something, even if synthesis is delayed.

### Pillar 2: state.md

`state.md` is the single file that answers: "If I come back to this project tomorrow knowing nothing about what I did today, what do I need to know?"

One `state.md` per project. It is human-editable, LLM-refreshed, and injected verbatim into every new session via `additionalContext`. It is not indexed; it is read directly. See `docs/state-of-play.md` for the full reference.

Three things can refresh `state.md`:

1. **SessionStart catchup** (primary path) — runs at the start of every session, processes any unprocessed raw captures, writes a new `state.md`. This is the normal path and runs even if the previous session ended abruptly.
2. **SessionEnd** (bonus path) — when Claude Code terminates cleanly, the SessionEnd hook runs the same pipeline. This is a minority path; session ends are often abrupt.
3. **`/um-checkpoint`** (user-triggered) — forces a refresh at any point mid-session. Useful after a significant decision.

**SessionStart catchup is the primary path, not SessionEnd.** The design accepts that SessionEnd is unreliable and treats catchup as the guaranteed fallback. This is sometimes called "catchup-is-primary."

`state.md` is injected with a staleness indicator:
- Age 0–7 days from `valid_from`: injected verbatim.
- Age 7–30 days: injected with a prefix noting the last-active date.
- Age over 30 days: not injected; treated as stale.

`state.md` is never indexed in mem0. It is read only by direct file access: the SessionStart hook reads it from disk, and the `memory_state` MCP tool performs a server-side file read. There is no vector search path to `state.md`.

### Pillar 3: Versioning via frontmatter status

Every document in the vault carries a YAML frontmatter block with a `status` field: `current`, `superseded`, `deprecated`, or `rejected`. When a document is replaced, its status is set to `superseded` and the new document carries `supersedes: [old_id]`. The chain is navigable in either direction.

The vector index respects status: superseded, deprecated, and rejected documents are excluded from default recall. They remain on disk and are recoverable with `?include_superseded=true`.

This gives memory an edit history without losing the ability to say "give me the current picture only." See `docs/frontmatter-schema.md` for the full schema reference.

A concrete versioning sequence: a team is running a quarterly strategy document. At the end of Q1 they call `memory_supersede` with the old ID and new content. The old strategy is marked `status: superseded` on disk and in the index. The new strategy is indexed as `status: current`. Queries for "current strategy" return only Q2. A reviewer who passes `include_superseded: true` can see the full Q1 → Q2 chain.

---

## Trigger model

Session continuity happens through a three-trigger design:

| Trigger | When it runs | What it does | Reliability |
|---|---|---|---|
| **SessionStart catchup** | Every new CC session | Detects unprocessed raw captures; synthesizes summaries; writes `state.md` | High — runs before the user's first message |
| **SessionEnd** | When CC terminates cleanly | Runs the same synthesis pipeline as catchup | Low — abrupt terminations skip it |
| **`/um-checkpoint`** | User command, any time | Forces a `state.md` refresh on demand | User-controlled |

The trigger model is designed so that catchup handles the common case (session ended abruptly, Stop hook fired, but SessionEnd did not). SessionEnd is a bonus that reduces latency when it does fire. `/um-checkpoint` is the escape hatch when the user wants to force state before the next natural catchup.

Raw captures are the durable artifact. As long as the Stop hook ran, synthesis can be deferred to the next session start without data loss.

---

## Write path

```
Claude Code session (hooks run on user's machine)
  │
  ├─ SessionStart hook
  │    Reads state.md → injects as additionalContext
  │    Checks for unprocessed raw captures
  │    If captures found: runs catchup (background)
  │        Synthesizes session summaries
  │        Writes new state.md
  │        Indexes new summaries in mem0
  │
  ├─ During session
  │    /um-checkpoint → forces state.md refresh
  │
  └─ Stop hook
       Appends raw capture to $VAULT/raw/<project>/YYYY-MM-DD.md
       (No LLM call — cheap, always runs)

Claude.ai / Claude Desktop / any MCP client
  │
  └─ Calls memory_capture, memory_supersede, memory_forget
       Server validates UM_MCP_WRITE_ENABLED=true
       Server writes to vault (rw mount)
       Server reindexes changed document
```

---

## Read path

```
Claude Code session start
  ├─ state.md injected via additionalContext (direct file read)
  └─ mem0 search for top-10 relevant facts (vector search over tier 2)

Claude.ai / Desktop / any MCP client
  ├─ memory_state(project) → direct read of state.md
  ├─ memory_search(query) → vector search over tier 2
  └─ memory_recent(project) → session_summary documents, date-sorted
```

---

## MCP tool surface

The memory server exposes 10 tools via JSON-RPC 2.0 at `POST /mcp`. Any MCP client — Claude.ai connector, Claude Desktop, custom agents — can use them without installing the Claude Code plugin.

**Read tools (always available):**

| Tool | What it does |
|---|---|
| `memory_search` | Semantic search over indexed documents |
| `memory_list` | List all indexed memories |
| `memory_state` | Direct read of `state.md` for a project |
| `memory_recent` | Recent session summaries, date-sorted |

**Write tools (require `UM_MCP_WRITE_ENABLED=true`):**

| Tool | What it does |
|---|---|
| `memory_add` | Add a fact to mem0 (extraction pipeline) |
| `memory_capture` | Write a new authored document to the vault and index it |
| `memory_checkpoint` | Force a session summary + state refresh **(stub, v0.3)** |
| `memory_forget` | Deprecate a document by ID |
| `memory_supersede` | Replace a document; old gets `status=superseded`, new is created |
| `memory_delete` | Delete a memory from the index by ID |

Full request/response schemas and curl examples are in `docs/mcp-tools.md`.

---

## Writer ownership invariant

| Surface | Can write vault directly? | How it writes |
|---|---|---|
| Claude Code hooks | Yes — runs on user machine | Direct filesystem write |
| Claude.ai / Desktop / MCP clients | No by default | Via `memory_capture` / `memory_supersede` / `memory_forget` with `UM_MCP_WRITE_ENABLED=true` |
| Humans | Yes | Any text editor, git commit |

The server mounts the vault read-only unless `UM_MOUNT_MODE=rw`. This prevents accidental writes from a misconfigured or compromised server while still allowing intentional MCP-mediated writes when explicitly enabled.

---

## Domain-neutral examples

universal-memory is not a coder-only tool. The frontmatter `type` field is a free string; UM defines no closed enum. Five examples drawn from different domains:

1. **ADR (software)** — `type: adr`. An architecture decision record: context, decision, consequences. Supersedes pattern keeps the decision trail intact. See `docs/frontmatter-schema.md` example 1.

2. **Character sheet (fiction writing)** — `type: character`. Protagonist profile, arc stage, relationships. A novelist running a long project can search "Mira Okafor" from any session or Claude.ai chat and get the current character state. See `docs/frontmatter-schema.md` example 2.

3. **Hypothesis (research)** — `type: hypothesis`. Experiment prediction, outcome, confidence level. When a hypothesis is revised, the old one is superseded; the chain shows the evolution of thinking. See `docs/frontmatter-schema.md` example 3.

4. **Goal (life)** — `type: goal`. A target, a metric, a deadline. A user can capture goals once and have them surfaced in any session where they're relevant. See `docs/frontmatter-schema.md` example 4.

5. **Strategy (business)** — `type: strategy`. Quarterly OKRs, owner, horizon. When Q1 ends, Q2 strategy supersedes Q1. Historical strategies remain auditable. See `docs/frontmatter-schema.md` example 5.

---

## Alternatives and how they relate

- **mem0** — UM uses mem0 as the extraction and vector-search engine in tier 2. mem0 alone has no session continuity mechanism, no `state.md`, no authored-document versioning. UM adds all three and connects them to a cross-surface MCP interface.

- **Claude Code auto-memory** — Claude Code's built-in per-project `MEMORY.md` is per-machine and CC-only. UM's vault is device-synced and accessible to any MCP client.

- **Obsidian / Zettelkasten** — tools for human PKM, not agent-accessible. UM's vault is plain markdown readable by humans in any editor, but it is also queryable by agents at conversation speed via the MCP surface.

- **MemGPT / Letta** — runtime agent memory paging. Solves a different problem (agent working memory during execution) rather than durable cross-session authored knowledge.

---

## What is explicitly out of scope

These are not design goals for universal-memory:

- **Mood or emotional state tracking** — `state.md` captures project focus and decisions, not personal mood logs.
- **Ephemeral thoughts** — raw captures are append-only session events, not a general inbox for fleeting thoughts.
- **Real-time collaboration** — the vault is file-based and sync is near-real-time but not transactional; concurrent writes from two sessions are not safe.
- **Automatic PII redaction** — UM stores what you give it. Users are responsible for what they capture.

UM handles session continuity across Claude surfaces, and structured authored knowledge (decisions, characters, hypotheses, goals, strategies) that accumulates over time.

---

## Stack

| Component | Role |
|---|---|
| Vault (markdown files) | Tier 1 — authoritative source |
| mem0 | Extraction + memory management API (tier 2) |
| Qdrant | Vector store (tier 2) |
| Memory server (Node/Express) | MCP endpoint + write validation + ingestion |
| Claude Code plugin | Hooks (Stop, SessionStart), skills (`/um-checkpoint`) |

The memory server and Qdrant run as Docker containers. The vault is a host directory mounted into the server container. The Claude Code plugin runs on the user's machine as a normal CC plugin — it does not run inside Docker.

The server exposes one port (`6335` by default). MCP clients connect to `http://your-host:6335/mcp`. The CC plugin communicates with the server over HTTP; it does not access Qdrant or mem0 directly.

Two deployment configurations are supported:

- **Single machine** — server, vault, and CC plugin all on the same host. Vault path is a local directory.
- **Self-hosted with cross-device sync** — server on a dedicated host (Pi, VPS, NAS); vault synced to all client machines via Syncthing or git. CC plugin on each client points to the remote server URL. Each client writes raw captures to its local vault sync; the server sees the merged view.

The Cloud mode (mem0.ai hosted) uses the same plugin but routes all reads and writes through the mem0.ai API. The vault is managed by mem0.ai; there is no self-hosted Qdrant or server. Switching between Cloud and self-hosted is a config change in the plugin's `settings.json`.

See `docs/quickstart.md` for installation and `docs/mcp-tools.md` for the full MCP reference.
