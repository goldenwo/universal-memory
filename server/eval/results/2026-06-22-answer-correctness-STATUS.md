# Answer-correctness grader — implementation + validation record (2026-06-22)

Branch: `feat/answer-correctness-grader`. Spec/plan: `docs/plans/2026-06-22-answer-correctness-grader-{spec,plan}.md` (gitignored). **COMPLETE** (P1–P4); offline suite green; live pins measured + gate floors pinned.

## P1 — grader + provider invoke + counter (offline TDD)
- `lib/answer-grader.mjs` `gradeAnswer(query, memory)` (provider-neutral; `_providerOverride` seam; fail-safe `ok` flag; untrusted-body delimiter).
- `lib/provider/openai.mjs` `answerGradeInvoke` + `ANSWER_GRADER_MAX_TOKENS=256` (temp 0).
- `lib/metrics.mjs` `um_answer_graded_total{outcome}` + the `metrics.test.mjs` registry 19→20 lockstep.
- `.env.example` `UM_ANSWER_GRADER_PROVIDER/MODEL`.

## P2 — Layer-1 reliability + τ_answer pin (LIVE; OpenAI-only, no qdrant)
- `eval/de-leak.mjs` + `eval/no-answer-set.jsonl` (30) harvested from parked `fix/no-answer-precision` (ref-only).
- `eval/build-answer-grader-set.mjs` → `eval/answer-grader-set.jsonl` (50 positives + 30 same-lane hard negatives).
- `eval/answer-grader-eval.mjs` (`computeMetrics`/`sweepThresholds` mirrored; `pickThreshold`/`fbeta` reused).
- **2 IDENTICAL live `gpt-4o-mini` runs** (`results/2026-06-22-answer-grader-run{1,2}.json`): precision **1.000** / recall 0.86 / fp=0 / parseFails 0; deterministic (§4b ✓); clears the 0.90 floor on 30 hard negatives (§4a ✓).
- **`TAU_ANSWER = 0.05`** pinned (precision 1.0 across the whole τ≥0.05 plateau).

## P3 — Layer-2 integration (offline TDD + LIVE-validated)
- `noAnswerPrecision` field `hadHitAboveThreshold`→`topHitAnswered` + new `answerCorrectnessRate`.
- `answerCorrectnessPass` + `--no-answer` flag + result keys `answerCorrectness`/`noAnswer`/`answerGrader`; `formatSummaryTable` line; `um_answer_graded_total` wired.
- `.github/workflows/nightly.yml` `mq-quality-gate` passes `--no-answer eval/no-answer-set.jsonl`.

## P4 — live mq runs + pinned gate floors (qdrant up 2026-06-22 PM)

| run | recall@1 | recall@5 | MRR | staleReturn | fire | answerCorrectness@1 | noAnswerPrecision | parseFails |
|-----|---------:|---------:|----:|------------:|-----:|--------------------:|------------------:|-----------:|
| smoke (recall+no-answer) | 0.980 | 1.000 | 0.990 | — | — | 0.840 | 1.000 | 0 |
| run1 (full) | 0.980 | 1.000 | 0.990 | 0.000 | 18/18 | 0.840 (42/50) | 1.000 (0 leaks/30) | 0 |
| run2 (full) | 0.980 | 1.000 | 0.990 | 0.000 | 18/18 | 0.840 (42/50) | 1.000 (0 leaks/30) | 0 |

Stable across all three (§4c ✓: within ±0.02; parseFails 0 ≪ 2%, no clustering). Baseline recall/staleness **unperturbed** vs v1.5.0 (§4d ✓ — the 6 oblique rows were NOT harvested into the gated corpus).

**Floors pinned** in `eval/mq-gate-thresholds.json` (floor = observed − documented margin; never weaken to green CI):
- `answerCorrectness ≥ 0.78` (observed 0.84; 0.06 margin — breaches at ~3 lost answerable items).
- `noAnswerPrecision ≥ 0.95` (observed 1.0; tolerates 1 grader flip of 30, breaches at 2).

Gate verified: `evaluateGate` PASS on both run1 and run2 (9 floors each). **No version bump** (eval/CI infra only, like #131). Re-pin trigger: a change to the grader model or `text-embedding-3-small`.

## Remaining
- Code-review-before-merge → merge (maintainer). Branch not pushed.
- The read-path **bouncer** (live abstention) stays a SEPARATE future decision — now informed by these numbers (this session built the measurement only).
