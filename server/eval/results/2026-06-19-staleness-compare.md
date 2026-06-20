# UM vs raw mem0 — staleness (currency) head-to-head

**Date:** 2026-06-19 · **Harness:** `server/eval/compare-staleness-um-mem0.mjs` · **Set:** `server/eval/staleness-set.jsonl` (18 same-lane entity-swap contradictions + neutral queries) · **Runs:** 2, identical (run-stable) · **Isolation:** per-row scratch qdrant collection pairs (`eval_stale_*`), dropped immediately; real `memories` untouched (before/after assert passed).

## Why this arm

The recall head-to-head ([`compare-um-mem0.mjs`](compare-um-mem0.mjs), PR #126) found **UM ≡ raw mem0** on distinct-fact recall (recall@1 0.98 / @3–10 1.0 / MRR 0.99, both). They share the retrieval core (mem0 + qdrant + OpenAI embeddings), so UM's pipeline adds **zero recall delta**. That means a distinct-fact recall test cannot show UM's value. UM's edge is **currency**: when a fact is *updated by a contradiction*, does the system stop returning the stale original? This arm measures exactly that. (Currency was scoped out of the recall-only benchmark, spec §4; re-scoped in here as the contrast where UM is designed to win.)

## Method

Per row: seed `original_fact` → seed `updated_fact` (the contradiction) → query *neutrally* (shares no surface words with either fact) → check, by exact normalized content-match (both arms store verbatim under `infer:false` → fair, deterministic, no LLM judge), whether the **stale original** still surfaces in the top-10.

- **UM arm** — `umAdd(orig)` → `umAdd(updated)`. Real production supersession: in-band at write time (`SUPERSEDED_INBAND`) **or** the session-end detector (`detectContradictionsInBatch` → `supersedePoint`) for swaps below the in-band cosine band. Then `doSearch` (filters superseded points). Same functions the mq-eval staleness pass injects — decisions never re-implemented.
- **mem0 arm** — `Memory.add(orig, infer:false)` → `Memory.add(updated, infer:false)` → `Memory.search`. No currency layer.

## Result

| metric | UM | mem0 | reading |
|---|---|---|---|
| **stale-return** (lower=better) | **0.056** | **1.000** | does the obsolete fact come back? |
| current-return (want ≈1.0) | 0.944 | 1.000 | is the right answer present? |
| **only-current** (IDEAL) | **0.944** | **0.000** | *only* the current fact, no stale |
| both-returned (ambiguous) | 0.000 | 1.000 | caller can't tell which is current |
| neither (lost both) | 0.000 | 0.000 | — |
| supersession fire-rate | 0.944 (17/18) | n/a | UM-only mechanism |
| stale-return over fired rows | **0.000** | n/a | reconciles with mq baseline |

## Interpretation

- **This is UM's edge, made visible.** UM returns *only the current fact* on 94.4% of contradictions and **never** returns a stale fact once supersession fires (0.0 over 17 fired rows — matching the mq-alone baseline exactly). Raw mem0 with `infer:false` has **no currency mechanism**: it returns the stale original on **100%** of rows and *only* the current fact on **0%**. Every mem0 answer is ambiguous (both facts present); the caller cannot tell which is current.
- **mem0's "best case" still leaks.** Even where mem0 ranks the update first (e.g. `s009`: updated@1, stale@2), the stale fact is still in the result set — so a top-k reader still sees it. Ranking ≠ currency.
- **UM's one miss is the known dedup-band weakness.** `s009` (`"Our production database is PostgreSQL"` → `"…MySQL"`) is a one-word swap → cosine **0.872**, above the dedup floor → `umAdd` treats the update as a near-duplicate and **DEDUP_MERGEs** it into the original instead of superseding. The update is *lost* and the stale "PostgreSQL" persists (rank 1) — the silent-stale-recall failure tracked for the supersession-ceiling fix (`docs/plans/2026-06-15-supersession-ceiling-repin-*`). It bites specifically on **high-surface-similarity contradictions** (same slot, contradicting value, near-identical wording); lower-similarity entity swaps (Acme→Beta, Boston→Seattle) fire the detector cleanly.

## Headline

On distinct-fact recall UM and raw mem0 are identical — but on **currency**, UM returns *only the current fact* 94% of the time and leaks a stale fact 0% of the time once supersession fires, while raw mem0 (`infer:false`) leaks the stale fact **100%** of the time. UM's measurable edge over the engine it wraps is **currency, not raw recall** — exactly as designed. The one residual gap is high-surface-similarity contradictions landing in the dedup band (1/18), the open supersession-ceiling item.
