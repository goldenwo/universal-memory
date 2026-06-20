# Memory-systems comparison — results matrix (UM vs mem0 vs the bridge)

**Date:** 2026-06-19 · **Branch:** `eval/memory-quality-baseline` (PR #126) · all arms on scratch qdrant collections, real `memories` untouched (externally verified), every arm 2 runs.

The question the user asked: *"Is UM better than my previous mem0, and what about claude-mem?"* This is the consolidated answer across every feasible arm.

## The matrix

### Recall (does it retrieve the right thing?)

| gold set | metric | **UM** | mem0 `infer:false` | bridge → UM (arm 4) |
|---|---|---|---|---|
| fact-recall (50 atomic facts) | recall@1 / @5 / MRR | 0.98 / 1.00 / 0.99 | 0.98 / 1.00 / 0.99 | — |
| session-recall (30 multi-fact summaries) | recall@1 / @5 / MRR | 0.767 / 1.00 / 0.868 | 0.767 / 1.00 / 0.868 | 0.733 / 1.00 / 0.85 |

**UM ≡ mem0 on recall, on both turfs.** They share the retrieval core (mem0 + qdrant + OpenAI embeddings), so UM's pipeline adds zero recall delta. Identical, run-stable, both shapes.

### Currency (does it stop returning the stale fact after an update?)

| metric | **UM** | mem0 `infer:false` | mem0 `infer:true` |
|---|---|---|---|
| stale-return (lower=better) | **0.056** | 1.000 | 0.111 |
| only-current (ideal) | **0.944** | 0.000 | 0.44–0.56 |
| neither — fact lost entirely | **0.000** | 0.000 | **0.33–0.44** |
| run-to-run stability | identical | identical | **varies (5/18 flip)** |

**UM dominates both mem0 modes on currency.** `infer:false` never forgets the stale fact; `infer:true` gains currency but pays with silent, nondeterministic data loss (its `gpt-4.1-nano` extractor returns zero facts for plain declaratives — probe-confirmed). UM decouples store (verbatim, lossless, deterministic) from currency (targeted lane-scoped supersession), so it's best on both axes.

## The three contrasts (spec §8)

1. **UM vs mem0** — equal on recall (both shapes), UM wins decisively on currency. UM's measurable value over the raw engine = **currency + determinism**, not recall.
2. **{UM, mem0} vs claude-mem** — claude-mem standalone (arm 3) is **DEFERRED**: its search runs only via a Bun Worker + ChromaDB beside the user's 6.3 GB live store (isolated-stack effort vs benefit). claude-mem is semantic (ChromaDB), session-shaped, and **complementary** to UM (atomic-fact currency) rather than a competitor on UM's turf — which is why the one-way bridge exists. The session-recall set gives claude-mem's home shape a fair future test if the standalone arm is built.
3. **UM vs UM+claude-mem (the bridge)** — **the bridge adds coverage, not noise.** Routing claude-mem content through the real bridge translation (`<external-summary>` wrapping + frontmatter) into UM retrieves at parity with direct seeding: recall@5/@10 identical (1.00), @1/@3 within one row, MRR −0.018, **zero misses**. Bridged claude-mem sessions are cleanly recallable through UM.

## Caveats (honest)

- **mem0 `infer:true` loss is model-dependent** (`gpt-4.1-nano`); a heavier extractor would lose less, at higher per-write cost. The comparison reflects mem0:true *as configured in this stack*.
- **claude-mem standalone (arm 3) not measured** — deferred infra. Its numbers are absent from the matrix by design, not omission.
- **Recall arms use `infer:false`** to isolate the retrieval core; mem0's `infer:true` recall on these sets wasn't run (the currency arm characterizes infer:true separately).
- The bridge arm exercises the **real translation + real UM indexing**; the SQLite read + HTTP `/api/reindex` transport + cursor/lock are covered by the bridge's own tests, not re-run here.

## Verdict

**Which is the best memory system?** For UM's purpose — current, deduped, lane-scoped *work-context* facts across vendors/devices — **UM is the strongest of what was measured**: it matches its own engine (mem0) on recall and beats *both* mem0 modes on currency, with full determinism. claude-mem is complementary (session narratives), and the bridge brings its content into UM losslessly.

**How to make UM the best (grounded in the data):**
1. **Close the supersession-ceiling gap** — UM's only currency miss is `s009` (the `(0.87, dedup]` DEDUP_MERGE band: a high-surface-similarity contradiction is merged, not superseded). Fix = "widen the judge window" (`docs/plans/2026-06-15-supersession-ceiling-repin-*`). Takes only-current 0.944 → ~1.0. **The single highest-leverage improvement.**
2. **Optionally complete the matrix** — mem0 `infer:true` recall, and the claude-mem standalone arm (arm 3) if the Bun+Chroma stack is worth standing up — to make "UM is best" airtight on every cell.
3. Maintain UM's structural edge: keep store decoupled from currency (verbatim `infer:false` + targeted supersession) — that decoupling is exactly why UM avoids both mem0 failure modes (stale-retention and silent loss).

## Provenance

Harnesses: `compare-um-mem0.mjs` (fact), `compare-session-recall.mjs` (session), `compare-staleness-um-mem0.mjs` + `compare-staleness-3way.mjs` (currency), `compare-bridge-recall.mjs` (arm 4). Per-arm analyses: `2026-06-19-staleness-compare.md`, `2026-06-19-staleness-3way.md`. Result JSON: `eval/results/2026-06-19-*`.
