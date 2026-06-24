# Tier-2 #10 noiseAbstained lever — live baseline STATUS (2026-06-24)

Prompt change: `FACTS_SYSTEM_PROMPT` in `server/lib/provider/openai.mjs` rewritten to abstain on
non-durable noise (greetings/chitchat, non-committed intentions, questions, hedges/tentative)
while preserving every durable fact. Spec/plan: `docs/plans/2026-06-23-extraction-noise-abstention-{spec,plan}.md`.
Eval: `extraction-fidelity-eval.mjs` over `extraction-set.jsonl` (40 rows / 32 fact-bearing /
**49 gold facts** / 8 noise rows). Extraction `gpt-4.1-nano` temp-0; judge `gpt-4o-mini`.

## Result vs the pre-registered gates (spec §4)

| run | recall | noiseAbstained | precision | parseFails | noise miss | recall drop |
|-----|--------|----------------|-----------|------------|------------|-------------|
| 1 | 1.000 | 7/8 | 1.000 | 0 | e11 | — |
| 2 | 1.000 | 7/8 | 1.000 | 0 | e11 | — |
| 3 | 0.980 | 7/8 | 1.000 | 0 | e11 | e14 (judge FN) |
| 4 | 1.000 | 7/8 | 1.000 | 0 | e11 | — |
| 5 | 0.980 | 7/8 | 1.000 | 0 | e11 | e14 (judge FN) |

Committed runs: run1, run2 (clean baselines), run3 (the documented judge-wobble case). Runs 4–5
reproduced the identical pattern (run4 clean; run5 the same e14 judge FN) and are not committed.

**Baseline (pre-change, 2026-06-23):** recall 1.0/1.0, noiseAbstained **4/8**, precision 1.0/0.983.

## Verdict: PASS (extractor meets the bar)

- **noiseAbstained 4/8 → 7/8, stable across 5/5 runs** (gate b floor ≥7/8 + **category coverage**:
  e03 gratitude/chitchat now abstains, e22/e23 hedge/tentative abstain, e06/e08/e32 unchanged —
  every named noise category retains ≥1 abstaining row). Target 8/8 not reached; **e11 is the one
  tolerated miss** (see below), within the floor.
- **recall = 1.000 for the extractor** (gate a). Runs 3 & 5 show 0.980 = 48/49, the single miss
  being **e14, a confirmed gpt-4o-mini judge false-negative**: the extraction
  `"the writer's organization does not deploy on Fridays"` is correct (negation polarity intact),
  verified by a direct 5/5 re-invoke audit (gate f) — the judge intermittently rejects it vs gold
  `"The team does not deploy on Fridays"` ("organization" ≈ "team"). No fact is dropped; this is an
  eval-judge limitation, not an extraction regression.
- **precision = 1.000, parseFails = 0** across all 5 runs (gates c, d).
- **Recall guardrails verified** (gate a per-row audit): negations e14/e15/e38 correct; reported-but-
  durable e25/e26 kept; in-message supersession e38/e39 now correctly drop the stale value (2→1,
  an improvement over baseline); near-hallucination traps e13/e37 respected (no inferred children/bike);
  **e04 daughter relationship restored** — draft v2 dropped "the user's daughter is named Mia" (a real
  recall loss the judge masked); the narrowed person-identity decomposition rule fixed it (3/3, audited).

## Off-fixture held-out probes (spec §7 R6 — generalization, not in the fixture)

Durable-but-soft inputs (recall) all KEPT; novel noise shapes (abstention) all ABSTAINED — abstention
generalizes beyond the 5 fixture noise categories (addresses the overfit/circularity concern):

```
KEEP    "I am switching to Sublime Text on Monday."        -> ["the writer is switching to Sublime Text on Monday"]
KEEP    "We are moving the team to Azure next week."        -> ["the team is moving to Azure next week"]
KEEP    "I prefer dark mode in all my editors."             -> ["the writer prefers dark mode in all their editors"]
KEEP    "If a check fails we roll back automatically."      -> ["if a check fails, we roll back automatically"]
KEEP    "Our new office opens in Austin in May."            -> ["The new office opens in Austin in May"]
ABSTAIN "This sprint is absolutely killing me, ugh."        -> []
ABSTAIN "Ok cool, sounds good - talk soon!"                 -> []
```

## The one tolerated miss — e11

`"Honestly not sure yet - maybe we'll revisit the pricing next quarter."` → extracts
`["the pricing will be revisited next quarter"]`. A hedged future plan the nano model reads as
committed. It is the single miss in all 5 runs; the 7/8 floor + category coverage still pass.
Two general fixes were attempted (draft v3: a hedged-future carve-out + a broad "decompose compound
statements" rule) but the broad decomposition rule regressed e22 (a hedged compound) to 6/8 — a
whack-a-mole the spec's STOP discipline warns against. Reverted to the narrowed person-identity rule
(draft v4). e11 left as the tolerated miss rather than over-tightening; escalating to a stronger
facts model is the documented fallback (its own spec), not taken here.

## Two known, accepted limitations (not regressions)
- **e20** ("We were a Python shop but migrated to Go") keeps the superseded "was a Python shop" as a
  2nd supported fact (2 extracted, gold 1). Pre-existing (baseline also 2); precision-neutral
  (judge-supported); out of this change's scope.
- **Judge (gpt-4o-mini) recall false-negatives** on paraphrase mismatches (e14 "organization"≈"team")
  put ~0.02 of run-to-run noise on the *aggregate recall metric*. The extractor is unaffected.
