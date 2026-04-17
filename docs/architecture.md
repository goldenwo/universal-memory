# Architecture

## Problem

A useful LLM memory system needs to persist knowledge across sessions, devices, and agents. Existing approaches tend to be one of:

- **Vector-store-centric** (Mem0, most RAG stacks): memories are opaque entries in a vector DB. If the DB is lost, the memory is lost. Vendor lock-in is high.
- **Context-window-centric** (MemGPT / Letta): virtual memory paging at runtime. Solves a different problem — agent runtime state, not durable personal knowledge.
- **Markdown-file-centric** (Obsidian, Zettelkasten): portable and durable, but agents can't query it efficiently at conversation speed.

None of these are robust to tool churn (vendor dies, product pivots, format changes) while also being fast enough for agent use. This project combines the durability of markdown with the query performance of a vector store, explicitly declaring which layer is authoritative.

## Three roles

Inspired by Andrej Karpathy's "LLM wiki" pattern. Each piece of the system plays exactly one of three roles:

### 1. Source — markdown, human/agent-authored, authoritative

- Substrate: plain `.md` files in git repos.
- Writes: humans, or skills explicitly acting on human intent (e.g. `create-adr`).
- Examples:
  - Per-project ADRs in `<repo>/docs/decisions/NNNN-*.md`
  - Per-project captured context in `~/.claude/projects/<project>/memory/*.md`
  - Cross-project atomic notes in `<vault>/raw/*.md`
- **Invariant: if source is lost, data is lost.** Everything else is rebuildable. Back this up.

### 2. Synthesis — markdown, LLM-authored, regenerable

- Substrate: plain `.md` files, written by LLM compile passes.
- Writes: **only LLMs.** Humans do not hand-edit synthesis output.
- Examples:
  - Per-project `MEMORY.md` index (maintained by Claude Code's autoDream)
  - Workspace consolidation (maintained by an equivalent pass)
  - Cross-project topic pages in `<vault>/wiki/by-topic/*.md`
  - ADR timeline and topic indexes
- **Invariant: deleting all synthesis and re-running compile passes must fully reproduce it.**

### 3. Index — non-markdown, machine-only, regenerable

- Substrate: Qdrant vectors (+ optional Kuzu graph for multi-hop relationship queries).
- Writes: ingestion pipeline, reading from source markdown.
- **No fact enters the index that doesn't exist in source.**
- Enriched with bi-temporal metadata (`valid_from`, `invalidated_at`) borrowed from Zep's pattern, so superseded ADRs don't pollute recall.
- **Invariant: `rm -rf` the vector store, re-run ingestion, everything back.**

## The single invariant

**If a fact isn't in a markdown source somewhere, it doesn't really exist.**

This one rule tells you:

- Where to back up: source only.
- What to trust when layers disagree: source wins.
- How to debug "why did the agent think X?": find the source file or accept the fact is orphaned.
- How to migrate off any tool: export source, regenerate the rest.

## Write path (capture)

Every capture writes markdown first, then enqueues ingestion:

```
agent turn
  │
  ├─> hook writes append-only raw capture:
  │       <source>/raw/YYYY-MM-DD.md
  │
  └─> POST to memory server /api/add (index update)
```

If the server is unreachable, the markdown write still succeeds. Ingestion is a retry queue.

## Read path (recall)

Agents hit the index for fast relevance, then chase provenance if needed:

```
session start
  │
  ├─> SessionStart hook queries /api/search for current project
  │     returns atomic facts + source_path metadata
  │
  └─> agent reads source file(s) directly if deeper context needed
```

## Consolidation passes

| Pass | Cadence | Reads | Writes |
|---|---|---|---|
| autoDream (Claude Code built-in) | 24h, per-machine | per-project `raw/` + typed notes | typed notes + `MEMORY.md` |
| workspace-dream | 24h | `<workspace>/raw/` + typed | typed workspace files |
| index hygiene | 24h + gates | index | index (cleaner) |
| cross-project compile | weekly | all source | `<vault>/wiki/by-topic/*.md` |
| ADR topic compile | monthly | all `<repo>/docs/decisions/` | `<vault>/wiki/adrs/` |

Each pass is idempotent: delete output, re-run, same result.

## Trade-offs

**What we accept:**

- Markdown-first capture adds one write per event (tiny cost, one-line hook change).
- Synthesis passes cost LLM tokens on a schedule.
- Sync mechanism (git or Syncthing) is one more moving part.

**What we gain:**

- Any component (vector store, graph, LLM provider, plugin format) can be swapped without data loss.
- Every claim has a diffable history.
- Recovery is one re-ingestion pass.
- Portability tested in CI, not promised in docs.

## Alternatives considered briefly

- **Mem0-centric / vector-DB-as-storage.** Rejected: losing the vector store means losing memory; maximum vendor lock-in.
- **MemGPT / Letta tiered runtime.** Solves agent runtime state, not durable cross-device knowledge. Not the same problem.
- **Cognitive-type partitioning** (episodic / semantic / procedural). Rejected: partitions by *content type* (philosophical) rather than *regenerability* (operational). Ages poorly as foundation models absorb more memory function intrinsically.
- **Microsoft GraphRAG community summaries.** Adopted as a *technique* inside the synthesis layer, not as a replacement frame.
- **Zep / Graphiti bi-temporal graphs.** Adopted as an *enrichment* of the index layer (the `valid_from` / `invalidated_at` borrow above), not as a separate frame.
- **A-Mem Zettelkasten-for-agents** atomic-note discipline. Adopted for source markdown shape.

## References

- [Karpathy's llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Mem0 paper (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [Zep / Graphiti paper (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956) — for bi-temporal edges
- [A-Mem (NeurIPS 2025, arXiv 2502.12110)](https://arxiv.org/abs/2502.12110) — for atomic note discipline
- ["Memory in the Age of AI Agents" survey (arXiv 2512.13564)](https://arxiv.org/abs/2512.13564)
