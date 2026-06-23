# Read-path bouncer — live gate-pin sweep (2026-06-23)

Pins `BOUNCER_SCORE_GATE` (`server/lib/bouncer.mjs`) from a live `--sweep` run against qdrant +
`text-embedding-3-small` + `gpt-4o-mini` grader. Branch `feat/read-path-bouncer` (PR #133).
Harness: `eval/memory-quality-eval.mjs` `--sweep` (`collectBounceRows` → `sweepBounceGate`).
Fixtures: `eval/recall-set.jsonl` (50 answerable) + `eval/no-answer-set.jsonl` (30 unanswerable).
Scratch collections only; real `memories` untouched (isolation assert passed). τ_answer = 0.05.

## Result — PIN `BOUNCER_SCORE_GATE = 0.60`

Two live runs, **identical** chosen gate. Pin = the LOWEST gate (max skipRate) holding both mq
floors: `answerCorrectness ≥ 0.78` AND `noAnswerPrecision ≥ 0.95`.

| gate | skipRate | answerCorrectness | noAnswerPrecision |
|-----:|---------:|------------------:|------------------:|
| 0.30 | 0.900 | 1.000 | 0.267 |
| 0.35 | 0.775 | 0.980 | 0.467 |
| 0.40 | 0.625 | 0.960 | 0.733 |
| 0.45 | 0.500 | 0.920 | 0.767 |
| 0.50 | 0.300 | 0.880 | 0.833 |
| 0.55 | 0.163 | 0.840–0.860 | 0.900 |
| **0.60** | **0.063** | **0.840–0.860** | **0.967** ✓ |
| 0.65 | 0.000 | 0.840–0.860 | 1.000 |
| 0.70–0.80 | 0.000 | 0.840–0.860 | 1.000 |

Runs: `2026-06-23-bouncer-sweep-run{1,2}.json` (run1's sweep recomputed offline from its cached
live rows — an `await` bug dropped it from the first harness run; fixed in the pin commit; the
80 live grades are intact).

## Determinism (§4e) — PASS
- **skipRate** and **noAnswerPrecision** are **bit-identical** across the two runs (cosine scores
  are deterministic for the same text; the grader is temp 0).
- **answerCorrectness** differs by exactly one borderline answerable item between runs
  (0.860 = 43/50 vs 0.840 = 42/50) — within the documented ±0.02 boundary jitter.
- Chosen gate **0.60 in both runs**. Both floors hold at 0.60 (AC 0.84–0.86 ≥ 0.78; NAP 0.967 ≥ 0.95).

## HEADLINE FINDING — the cost gate saves little (skipRate ≈ 0.063)

**At a recall-safe precision floor, the gate skips only ~6% of searches — so ~94% still pay an
LLM grade.** The score-gated *hybrid* premise ("clearly-strong hits skip the LLM, so most searches
stay free") is **empirically weak** here: answer and non-answer cosine bands overlap heavily
(weakest real answers and topical non-answers both reach ~0.45–0.60 — the *exact* lesson from the
parked no-answer-floor, `no_answer_floor_negative_result`). A precision-safe gate therefore sits
near the top of the distribution, above almost everything.

**Implication for the default-on flip (the user's call):** turning the bouncer on adds an LLM
round-trip to ~94% of `memory_search` calls — real hot-path latency + cost, *not* the cheap
"only the ambiguous band" the brainstorm hoped for. This does not break the bouncer (it is
recall-safe and flags non-answers at NAP 0.967), but it reframes the cost/benefit:
- The realistic cost of the bouncer ≈ always-on grading (the gate's ~6% saving is marginal).
- The `um_bouncer_total{outcome=skipped_high}` rate in prod will be low; `failopen`/`flagged` will
  dominate the signal.
- Pre-flip options to weigh: accept the ~94%-grade cost; add p99 latency telemetry first (R1
  follow-up); or revisit a cheaper shape (e.g. async-advisory, a smaller/cheaper grader, or
  caching grades by (query, top-id)).

## Caveats
- Measured on the 80-row eval fixture; real prod query/score distributions may differ, but the
  underlying answer/non-answer cosine overlap is fundamental (cross-validated by the negative result).
- The gate stays **inert** (`UM_BOUNCER_ENABLED` default off); this pin only takes effect at the flip.
- Re-pin trigger: a grader-model or `text-embedding-3-small` change → re-run `--sweep` (drift-asserted
  in `test/bouncer.test.mjs`).
