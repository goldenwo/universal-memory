# UM vs mem0 `infer:false` vs mem0 `infer:TRUE` — staleness 3-way

**Date:** 2026-06-19 · **Harness:** `server/eval/compare-staleness-3way.mjs` · **Set:** `staleness-set.jsonl` (18 same-lane entity-swap contradictions + neutral queries, annotated with `stale_value`/`current_value`) · **Runs:** 2 · **Isolation:** per-row scratch collection triples (`eval_st3_*`), real `memories` untouched (verified).

## Why this arm

The 2-arm staleness result ([`2026-06-19-staleness-compare.md`](2026-06-19-staleness-compare.md)) compared UM only to raw mem0 with `infer:false` — literal store, **no** currency layer. That's "mem0 with its brain off." mem0's *actual* value-add is `infer:true`: its LLM extracts facts and issues ADD/UPDATE/DELETE against existing memories — mem0's **native currency path**. This arm asks the honest question: **does mem0's own update path match UM's supersession, or is UM only beating a strawman?**

## Method & validation

Per row: seed `original` → seed contradicting `update` → query *neutrally* → does the **stale** value still surface? Because `infer:true` **rephrases** facts (stores LLM-extracted text, not verbatim), exact content-match breaks, so detection is **value-token presence**: each row is annotated with the distinctive `stale_value`/`current_value` entity that survives rephrasing (`Acme`/`Beta`, `PostgreSQL`/`MySQL`, …).

**The detector is validated:** run on the two *verbatim* arms (UM, mem0:false) it reproduces the committed exact-match result **per-row, both runs** (UM stale 0.056, mem0:false stale 1.000) — zero token-vs-exact mismatches. So the `infer:true` numbers are trustworthy. mem0:true's stored memories were also dumped and hand-inspected.

## Result

| metric | UM | mem0 `infer:false` | mem0 `infer:true` |
|---|---|---|---|
| **stale-return** (lower=better) | **0.056** | 1.000 | **0.111** |
| current-return (want ≈1.0) | **0.944** | 1.000 | 0.500–0.611 |
| **only-current** (ideal) | **0.944** | 0.000 | 0.444–0.556 |
| both-returned (ambiguous) | 0.000 | 1.000 | 0.056 |
| **neither — fact lost entirely** | **0.000** | 0.000 | **0.333–0.444** |
| run-to-run stability | identical | identical | **varies (5/18 rows flip)** |

(mem0:true shown as a run1–run2 range; UM and mem0:false are bit-identical across runs.)

## What's actually happening in mem0:true (from the probe)

mem0:true's `infer:true` path has **two** failure modes, both confirmed by inspecting its add-events + stored points:

1. **Silent extraction loss (the big one).** For plain declaratives like *"I live in Boston"* (s002) and *"…account is at Chase"* (s007), mem0's fact-extractor returned **zero facts** — `add()` events `[]`, nothing stored. The fact is silently dropped: neither stale nor current is recoverable. This is **nondeterministic** — s011 (*"I own/rent my apartment"*) stored nothing in the eval run but extracted fine in the probe (`"Owns an apartment"` → updated to `"Renting an apartment"`). Across the two runs, **5/18 rows flip** (s008, s009, s010, s012, s015).
2. **When extraction works, the update path is good** — s001 correctly went `"Works at Acme Corp"` → replaced by `"Works at Beta Industries"` (old gone, stale suppressed). That's why mem0:true's stale-return (0.111) is far below mem0:false (1.000). But retrieval scores on the de-leaked queries are low (~0.39–0.42), so even stored facts are weakly retrieved.

**Root cause:** mem0:true *couples* "what to store" to a per-write LLM extract-and-reconcile step. With the stack's configured extraction model (`UM_FACTS_MODEL=gpt-4.1-nano-2025-04-14` — small/fast), that step is lossy and nondeterministic. A larger model would likely reduce the loss, at higher cost/latency per write.

## Interpretation — UM dominates both mem0 configurations

- **mem0:false** never forgets the stale fact (stale-return 1.000) — no currency at all.
- **mem0:true** *has* currency (stale-return 0.111) but pays for it with **silent, nondeterministic data loss** (neither-rate 0.33–0.44, varying run to run) — it trades "keeps the obsolete fact" for "sometimes forgets the fact entirely."
- **UM** is the only arm good on **both** axes: stale-return 0.056 **and** current-return 0.944, neither-rate **0.000**, fully deterministic. UM **decouples** the two jobs — store verbatim (`infer:false` → lossless, deterministic, no extraction dependency) and supersede surgically (targeted, lane-scoped) — so it gets mem0:true's currency *without* its extraction fragility.

## Caveats

- mem0:true's extraction loss is **model-dependent** (`gpt-4.1-nano`); a stronger extractor would likely lift current-return and reduce variance, at higher per-write cost. The comparison reflects mem0:true *as configured in this stack* — the same model UM has available but does not depend on for storage.
- UM's one residual miss is still `s009` (the `(0.87, dedup]` DEDUP_MERGE band) — the open supersession-ceiling item.

## Headline

The honest `infer:true` comparison **strengthens** the UM conclusion. On currency UM beats **both** mem0 modes: better than `infer:false` (which never forgets the stale fact) **and** better than `infer:true` (which forgets too much, silently and nondeterministically). UM's verbatim-store + targeted-supersession architecture uniquely avoids both failure modes — stale-retention *and* silent loss — at full determinism. "Is UM better than mem0?" → **yes, on the dimension that matters (currency), in either mem0 configuration.**
