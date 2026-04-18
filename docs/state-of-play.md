# State of play — concept reference

## What state.md is

`state.md` is the one authored, curated artifact that represents "where am I?"
Everything else — raw captures, session summaries, ADRs — is supporting material
that `state.md` points into when depth is needed. It is the vessel; everything
else is scaffolding.

It is not assembled from a query. It is not a log. It is a single file, written
(and rewritten) by an LLM on the user's behalf, designed to answer one question:
"If I return to this project tomorrow knowing nothing about what I did today,
what do I need to know?" The answer must fit in approximately 3000 characters.

One `state.md` exists per project. It lives at:

```
$VAULT/state/<project>/state.md
```

---

## Structure

`state.md` uses a fixed set of YAML frontmatter fields and fixed Markdown section
headers. Both are required. The headers must appear verbatim; arbitrary sections
are not recognized by the SessionStart hook or the `memory_state()` tool.

```markdown
---
schema_version: 1
type: state
id: state-<project>
title: State of play — <project>
status: current
valid_from: <ISO-8601 UTC>
project: <project>
---

# State of play — <project>

## Current focus
(1–2 sentences: what am I actively working on right now)

## In flight
(bullets: specific tasks/items mid-completion, with enough specificity that
reading this lets you resume)

## Recent decisions
(last 5–10 decisions with dates — decisions older than that either moved to
ADRs or got summarized)

## Next actions
(sequenced, specific — not "continue development")

## Open questions
(things unresolved or deferred, ideally with what would resolve them)

## Environment
(optional: current branch, running processes, notable files in flight)
```

The seven frontmatter fields above are the required subset from the universal
spine. See `docs/frontmatter-schema.md` for the full spine reference and optional
fields. No domain-specific extensions are defined for `type: state` beyond these.

---

## Who writes it

Three writers produce or update `state.md`:

1. **Catchup** (primary writer) — SessionStart detects unprocessed raw captures
   from the previous session. If any are found, a detached background task
   summarizes them and writes a fresh `state.md`. This is the normal path;
   `state.md` is typically up to date before the user's first message.

2. **SessionEnd** (bonus writer) — When Claude Code terminates cleanly, the
   SessionEnd hook may run the same pipeline. This is a minority path;
   termination is often abrupt and the hook may not fire.

3. **`/um-checkpoint`** (user-triggered) — The user issues this command at any
   point during a session to force a refresh. Useful when a significant decision
   has just been made and the user wants it captured before continuing.

In all three cases the writer is the LLM, not a script. The writer is given the
accumulated raw captures plus the current `state.md` (if it exists) and produces
a new `state.md`. The merge prompt is designed to preserve content the current
session did not materially change (see Human-editing semantics below).

`valid_from` is updated on every LLM refresh to the UTC time of writing.

Size discipline: `state.md` is capped at approximately 3000 characters. When
the file approaches that limit, the oldest entries in `## Recent decisions` are
either promoted to ADRs or summarized in place before the refresh writes new
content.

---

## Who reads it

Two consumers access `state.md` directly:

1. **SessionStart hook** — on each new Claude Code session, the hook reads
   `state.md` from disk and injects the body (frontmatter stripped) as
   `additionalContext`. A staleness prefix is prepended when appropriate.

   Staleness rules:
   - Age ≤ 7 days: inject verbatim, no prefix.
   - Age 7–30 days: inject with prefix
     `# State of play (last active YYYY-MM-DD, may be outdated)`.
   - Age > 30 days: do not inject.
   - File missing: do not inject.

   "Age" is measured from `valid_from` in the frontmatter. If `valid_from` is
   absent or unparseable, the file is treated as missing.

2. **`memory_state(project)` MCP tool** — available to Claude.ai, Claude Desktop,
   and any MCP client that connects to the universal-memory server. The tool
   performs a server-side direct file read of the mounted vault at
   `$VAULT/state/<project>/state.md` and returns the state.md content (or an
   error when the project has no state.md yet). This allows remote clients to
   load project state without a filesystem hook.

`state.md` is **not indexed in mem0**. It is accessed only by direct file read.
There is no vector search path to `state.md`; it is excluded from the recall
pipeline.

---

## How to reset

Delete the file:

```bash
rm $VAULT/state/<project>/state.md
```

The next catchup (or SessionEnd, or `/um-checkpoint`) regenerates `state.md`
from the accumulated raw captures. Nothing is lost; the raw captures remain on
disk. The regenerated file starts from the full capture history rather than
merging with a prior state.

Reset is appropriate when the project has shifted substantially and the prior
state is more misleading than helpful, or when the file has grown stale beyond
the 30-day injection threshold and you want to force a refresh.

---

## Human-editing semantics

Users may open `state.md` in any editor, add or remove bullets, rewrite
sections, or append notes between sessions. The LLM merge prompt (used by all
three writers) is explicitly designed to preserve sections the current session
did not materially engage with.

Concretely: if a user hand-writes an entry in `## Open questions` and the
subsequent session does not address that question, the entry survives the next
LLM refresh unchanged. If the session resolves the question, the LLM is expected
to remove or annotate the entry — the same judgment a human editor would apply.

The merge prompt does not treat `state.md` as LLM-owned territory. Human edits
are first-class input, not noise to be overwritten.

One practical implication: if you want a note to persist across sessions, put it
in `state.md` rather than relying on a raw capture. Raw captures are consumed and
synthesized; `state.md` is the synthesis output.

---

## What state.md is NOT

- **Not a log.** It does not grow over time. Each refresh replaces the previous
  version. Historical state is not recoverable from `state.md` alone; it is
  recoverable from the raw captures and session summaries that informed it.

- **Not indexed in mem0.** Semantic search over mem0 will not surface `state.md`
  content. It is accessed only by direct file read via the SessionStart hook or
  the `memory_state()` MCP tool.

- **Not a replacement for session summaries.** Session summaries (`type:
  session_summary`) are the persistent record of what happened in a session.
  `state.md` is derived from them (and from raw captures); it is the distillation,
  not the archive.

- **Not a replacement for ADRs.** Decisions that warrant permanent, versioned
  records should be written as `type: adr` documents. `state.md` carries only
  the most recent 5–10 decisions; older ones should be promoted to ADRs before
  the size cap forces eviction.
