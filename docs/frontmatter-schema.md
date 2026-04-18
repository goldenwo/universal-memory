# Frontmatter schema

Every document managed by universal-memory carries a YAML frontmatter block.
The block is split into two layers: a **universal spine** of fields that apply to
every document regardless of domain, and **domain-specific extensions** that vary
by `type`. This reference covers both layers, the status lifecycle, recall
semantics, and opt-in temporal decay.

---

## Universal spine

All eleven fields below are part of the universal spine. Fields marked optional
may be omitted when not applicable; the system assigns defaults where noted.

```yaml
# Abbreviated — see Examples below for full frontmatter delimiter form.
schema_version: 1
type: <string>              # session_summary | state | adr | note | fact | character | goal | ...
id: <string>                # stable identifier; equals the filename stem (enables O(1) lookup)
title: <string>
status: current|superseded|deprecated|rejected    # default: current
supersedes: [id, id]
superseded_by: id
valid_from: <ISO-8601>
invalidated_at: <ISO-8601>
tags: [string]
project: <string>
```

### Field reference

| Field | Required | Default | Notes |
|---|---|---|---|
| `schema_version` | yes | — | Always `1` for v0.2.x documents. |
| `type` | yes | — | Free string. Drives domain-specific extension fields. |
| `id` | yes | — | Must equal the filename stem (no extension). Enables O(1) lookup. |
| `title` | yes | — | Human-readable title for search results and summaries. |
| `status` | no | `current` | One of `current`, `superseded`, `deprecated`, `rejected`. |
| `supersedes` | no | — | List of `id` values this document replaces. |
| `superseded_by` | no | — | `id` of the document that replaces this one. |
| `valid_from` | no | — | ISO-8601 date/time the document became valid. |
| `invalidated_at` | no | — | ISO-8601 date/time the document stopped being valid. When set, the document is excluded from default recall results. |
| `tags` | no | — | Flat list of strings for faceted filtering. |
| `project` | no | — | Logical project or context name. Useful when a single memory store holds multiple projects. |

---

## Domain-specific extensions (`type` values)

The `type` field is the extension point. Any string is valid; UM defines no
closed enum. Teams and users choose their own vocabulary.

Fields beyond the universal spine are added directly alongside it in the same
frontmatter block. There is no nesting or namespacing requirement; prefix field
names with the type name (e.g., `adr_context`) only if collision risk is a
concern.

Common `type` values and typical extension fields:

| `type` | Typical additional fields |
|---|---|
| `session_summary` | `session_date`, `duration_min`, `next_action` |
| `adr` | `adr_context`, `adr_decision`, `adr_consequences` |
| `note` | (none required) |
| `fact` | `confidence`, `source` |
| `character` | `role`, `arc_stage`, `relationships` |
| `hypothesis` | `experiment_id`, `prediction`, `outcome` |
| `goal` | `target_date`, `metric`, `owner` |
| `strategy` | `horizon`, `quarter`, `owner`, `okr_ref` |
| `state` | `phase`, `blockers` |

This table is illustrative, not exhaustive. Extensions are defined by the author;
UM stores and recalls them without interpreting them.

---

## Status lifecycle

```
                  ┌───────────┐
       create ──► │  current  │
                  └─────┬─────┘
                        │ replaced by newer version
                        ▼
                  ┌─────────────┐
                  │ superseded  │ ◄── superseded_by points to new doc
                  └─────────────┘

       deliberate wind-down ──► deprecated
       never accepted / wrong ──► rejected
```

- **current** — the active, authoritative version. Included in default recall.
- **superseded** — replaced by a newer document. Excluded from default recall unless `?include_superseded=true` is passed. The chain is navigable via `supersedes` / `superseded_by`.
- **deprecated** — still valid but scheduled for removal or no longer recommended. Excluded from default recall. May optionally point to a replacement via `superseded_by`. Usually a terminal state; no further status transitions are required.
- **rejected** — was evaluated and rejected (common for ADRs). Excluded from default recall.

Setting `invalidated_at` to a past timestamp is equivalent to marking a document
out-of-scope for recall, independent of `status`. Both mechanisms can coexist.

---

## Recall semantics

The default recall pipeline filters documents before ranking. The rules are:

1. **Status filter** — documents with `status` of `superseded`, `deprecated`, or
   `rejected` are excluded.
2. **Invalidation filter** — documents with `invalidated_at` set to any non-null
   value are excluded.
3. **Legacy compatibility** — v0.1.x documents that carry no frontmatter are
   treated as `status: current` and pass both filters.
4. **Relaxed filter** — passing `?include_superseded=true` disables both the
   status and invalidation filters, returning the full corpus. Despite the name,
   this parameter relaxes all three exclusion filters: `status=superseded`,
   `status=deprecated`, and non-null `invalidated_at`.
5. **O(1) id lookup** — the `id` field equals the filename stem. A lookup by
   `id` bypasses vector search entirely and resolves in constant time.

The relaxed filter is useful for audit trails, history navigation, and cases
where a user explicitly wants to see what was decided before the current version.

---

## Temporal decay (opt-in)

By default, all documents retain full recall weight indefinitely regardless of
age. Temporal decay is disabled unless explicitly enabled.

To enable:

```bash
UM_TEMPORAL_DECAY=true   # set in environment or .env
```

When enabled, a document's recall score is multiplied by a decay factor derived
from its age. The default half-life is **30 days**: a document 30 days old
receives half the recall weight of a brand-new document; a document 60 days old
receives one quarter.

Decay applies after the status and invalidation filters, so superseded documents
are still excluded even with decay enabled. When `valid_from` is set, the clock
starts from that date rather than from an unstable timestamp such as file
creation time (which varies across clones).

Temporal decay is designed for high-churn note types (`session_summary`, `fact`,
`state`) where recency is a strong relevance signal. It is less appropriate for
stable reference types (`adr`, `character`, `strategy`) where the document's
value is independent of age. Authors can opt individual documents out by omitting
`valid_from`: documents with no `valid_from` field are treated as ageless —
their decay factor is always 1.0.

---

## Examples

Each example shows a realistic frontmatter block plus a short body excerpt.
All five use the same universal spine fields alongside domain-specific extensions.

---

### 1. ADR — architecture decision record (software)

```yaml
---
schema_version: 1
type: adr
id: adr-0012-vector-store-choice
title: "ADR-0012: Choose Qdrant as the vector store"
status: current
supersedes: [adr-0007-pinecone-evaluation]
valid_from: 2025-11-03
tags: [infrastructure, search, vector]
project: universal-memory
adr_context: >
  We evaluated Pinecone, Weaviate, and Qdrant for the semantic recall layer.
  Self-hosting was a hard requirement.
adr_decision: >
  Adopt Qdrant. Runs as a single binary, supports payload filtering natively,
  and has a permissive Apache 2.0 license.
adr_consequences: >
  Operators must provision ~512 MB RAM per 1 M vectors. Pinecone evaluations
  (adr-0007) are superseded and retained for audit.
---
```

**Body excerpt:**

> Qdrant's payload filtering lets us apply the status and invalidation filters
> at the database layer rather than in application code, reducing result-set
> sizes before reranking.

---

### 2. Character sheet — protagonist (fiction writing)

```yaml
---
schema_version: 1
type: character
id: char-mira-okafor
title: "Mira Okafor — protagonist, The Cartographers"
status: current
valid_from: 2025-08-14
tags: [protagonist, cartographers-novel, chapter-1-through-12]
project: cartographers-novel
role: protagonist
arc_stage: midpoint-reversal
relationships:
  - id: char-theo-albrecht
    label: antagonist-turned-ally
  - id: char-senara-voss
    label: mentor-deceased
---
```

**Body excerpt:**

> Mira's defining trait is systematic distrust of inherited maps — literal and
> metaphorical. By the midpoint she has destroyed three cartographic archives she
> believes are falsified. Her arc turns when Theo reveals a fourth archive she
> does not know how to read.

---

### 3. Hypothesis — experiment tracking (research)

```yaml
---
schema_version: 1
type: hypothesis
id: hyp-2025-q3-sleep-cognition
title: "Hypothesis: 7h+ sleep improves next-day working-memory score by ≥10%"
status: superseded
superseded_by: hyp-2025-q4-sleep-cognition-revised
valid_from: 2025-07-01
invalidated_at: 2025-09-30
tags: [sleep, cognition, n-of-1, experiment]
project: personal-research
experiment_id: EXP-047
prediction: "WM score (N-back 2) increases ≥10% on days following ≥7h sleep"
outcome: "Partial support: mean +6.3%, p=0.08. Revised hypothesis tightens sleep definition to include REM ≥90 min."
confidence: 0.55
source: self-tracked, Oura ring + daily N-back battery
---
```

**Body excerpt:**

> Raw data in `data/exp-047-wm-scores.csv`. The effect size trended positive but
> fell short of the pre-registered threshold. Sleep duration alone is likely an
> insufficient proxy; the revised hypothesis (hyp-2025-q4-sleep-cognition-revised)
> adds REM duration as a co-variable.

---

### 4. Goal — personal goal (life)

```yaml
---
schema_version: 1
type: goal
id: goal-learn-portuguese-2026
title: "Reach B1 Portuguese by end of 2026"
status: current
valid_from: 2026-01-01
tags: [language, portuguese, self-development]
project: personal
target_date: 2026-12-31
metric: "Pass CAPLE B1 exam or equivalent self-assessment rubric"
owner: golden
---
```

**Body excerpt:**

> Current level: A2 (conversational with significant gaps). Weekly study plan:
> 30 min Anki + 20 min italki conversation. Milestone check-ins logged as
> `note` documents tagged `[portuguese, milestone]`.

---

### 5. Strategy — quarterly business plan (business)

```yaml
---
schema_version: 1
type: strategy
id: strat-q2-2026-growth
title: "Q2 2026 Growth Strategy — Expand SMB channel"
status: current
supersedes: [strat-q1-2026-growth]
valid_from: 2026-04-01
tags: [strategy, q2-2026, smb, growth]
project: acme-corp
horizon: quarter
quarter: "2026-Q2"
owner: growth-team
okr_ref: OKR-2026-Q2-G1
---
```

**Body excerpt:**

> **Objective:** Sign 40 new SMB accounts in Q2.
>
> Key results: (1) Launch self-serve trial by April 15. (2) Enable partner
> referral programme by May 1. (3) Achieve $280k net new ARR by June 30.
>
> This strategy supersedes `strat-q1-2026-growth`, which targeted enterprise
> accounts exclusively and missed pipeline targets by 22%.
