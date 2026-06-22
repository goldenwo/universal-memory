# Answer-correctness grader — implementation status (2026-06-22)

Branch: `feat/answer-correctness-grader`. Spec/plan: `docs/plans/2026-06-22-answer-correctness-grader-{spec,plan}.md` (gitignored). Offline suite at landing: **1313 tests / 1299 pass / 0 fail / 14 skip**.

## DONE + verified

- **P1 — grader + provider invoke + counter** (offline TDD):
  - `lib/answer-grader.mjs` `gradeAnswer(query, memory)` (provider-neutral; `_providerOverride` seam; fail-safe `ok` flag; untrusted-body delimiter).
  - `lib/provider/openai.mjs` `answerGradeInvoke` + `ANSWER_GRADER_MAX_TOKENS=256` (temp 0).
  - `lib/metrics.mjs` `um_answer_graded_total{outcome}` + the `metrics.test.mjs` registry 19→20 lockstep.
  - `.env.example` `UM_ANSWER_GRADER_PROVIDER/MODEL`.
- **P2 — Layer-1 reliability + τ_answer pin** (LIVE, qdrant NOT required — uses OpenAI directly):
  - `eval/de-leak.mjs` + `eval/no-answer-set.jsonl` (30 rows) harvested from the parked `fix/no-answer-precision` (ref-only).
  - `eval/build-answer-grader-set.mjs` → `eval/answer-grader-set.jsonl` (50 positives + 30 **same-lane hard** negatives; the unanswerable-query pairing makes them guaranteed gold-false + genuinely topical).
  - `eval/answer-grader-eval.mjs` (`computeMetrics`/`sweepThresholds` mirrored; `pickThreshold`/`fbeta` reused).
  - **2 IDENTICAL live `gpt-4o-mini` runs** (`results/2026-06-22-answer-grader-run{1,2}.json`): **precision 1.000 / recall 0.86 / fp=0 / parseFails 0**; deterministic (§4b ✓); clears the 0.90 floor (§4a ✓) on 30 hard negatives (non-vacuous, §4a/T1 ✓).
  - **`TAU_ANSWER` pinned = 0.05** (precision is 1.0 across the whole τ≥0.05 plateau — the answers-boolean carries the precision; confidence gate near-inert at this model). Drift-asserted.
- **P3 (code) — Layer-2 integration** (offline TDD; LIVE run deferred, see below):
  - `noAnswerPrecision` field `hadHitAboveThreshold`→`topHitAnswered` + new `answerCorrectnessRate` (tests updated).
  - `answerCorrectnessPass` + `--no-answer` flag + result keys `answerCorrectness`/`noAnswer`/`answerGrader` + `formatSummaryTable` line; counter wired.
  - `runOnce` lazy/circular imports verified to resolve offline (`runOnce`/`answerCorrectnessPass`/`TAU_ANSWER`/`gradeAnswer` all present).

## DEFERRED — blocked on local Docker (qdrant)

Docker Desktop's WSL2 engine would **not start** this session: the `docker-desktop` distro stayed `Stopped`; `docker desktop start` → "already running" (no-op), `docker desktop restart` hung 240s, and a full process-kill + `wsl --shutdown` + relaunch + ~135s poll left it down. Needs interactive attention / reboot — not resolvable headless.

Per the spec §4e **lockstep** (gate floors land WITH the nightly `--no-answer` wiring, never a floor without its measurement), these two are deferred together so the existing CI is untouched (zero risk):

1. **P3 Task 3.3 — nightly wiring + local smoke.** Add `--no-answer eval/no-answer-set.jsonl` to the `mq-quality-gate` step in `.github/workflows/nightly.yml` (it runs report-only — no floors yet). First validate locally:
   ```
   # from server/, with qdrant up (docker compose up -d qdrant):
   node --env-file=.env eval/memory-quality-eval.mjs \
     --recall eval/recall-set.jsonl --staleness eval/staleness-set.jsonl \
     --no-answer eval/no-answer-set.jsonl --out eval/results/2026-06-22-mq-answercorr-smoke.json
   ```
   Expect the summary to print `Answer-correctness@1` + `No-answer precision` as numbers (not n/a), small `answerGrader.parseFails`.
2. **P4 — pin the gate floors.** Run the full mq eval **twice** (same command, `-run1`/`-run2`). If `answerCorrectness.rate` + `noAnswer.precision` agree within ±0.02 and `parseFails/total < 0.02` (and don't cluster on one category), add to `eval/mq-gate-thresholds.json`:
   ```json
   { "metric": "answerCorrectness", "path": ["answerCorrectness","rate"], "direction": "min", "floor": X },
   { "metric": "noAnswerPrecision", "path": ["noAnswer","precision"], "direction": "min", "floor": Y }
   ```
   (X,Y = min observed − a documented margin.) Then verify a `--gate` run passes and write the validation evidence. If UNSTABLE → ship report-only, document the defer (do NOT pin a flaky floor; do NOT weaken the gate). **No version bump** (eval/CI infra only).

Expectation from P2: Layer 2 should roughly reproduce P2's numbers (answerCorrectness@1 ≈ 0.86, noAnswerPrecision ≈ 1.0), since recall@1 is high so answerable top-1 ≈ the target the grader already scored, and unanswerable top-1 is a topical neighbor the grader rejects.
