# Salience-calibration baseline (A2) — production-noise fixture, 2026-07-27

Arc: write-path salience calibration (spec + plan `docs/plans/2026-07-26-writepath-salience-calibration-{spec,plan}.md`,
both gitignored; converged 2026-07-26). This doc records the T3 baseline and the fork decision.

**Echo-test limitation (spec §2, carried verbatim per plan):** this fixture measures
**re-admission, not replay** — rows are production-captured text fed to `facts()` as
memory-store input (the surface the eval has always measured); the original transcript-level
capture context of the retired hook is not reproduced.

## Run config (pinned)

- Extractor: `gpt-4.1-nano` (provider default; no `UM_FACTS_MODEL` set), temperature 0 (prod parity).
- Judge: `gpt-4o-mini` (`UM_EXTRACTION_GRADER_MODEL` default) — fires only on the 12 fact-bearing durable rows.
- Fixture: 80 rows (ephemeral 39, observer-telemetry 16, referent-stripped 13, durable 12),
  gitignored raw tier; sha256 `01fe354963534239d336c2dcc99d6c8184f1e5b0c7a7d4bbef9085644c8f9a8e`.
  Provenance: seeded draw (seed 20260727, widened once to 160 in a recorded batch of 40) from the
  982 claude-code-hook rows; near-dup (token-jaccard ≥ 0.8) draw rejections: 0; the 982 are
  already exact-deduped server-side (dedupCount carried per row, not used as a weight).
- Runs: 2 (2026-07-27), results `2026-07-27-salience-baseline-run{1,2}.json`.

## Fixture label instrument (blind double-labeling)

Two independent blind subagent passes over the closed enum {E, T, F, D, U, X}, disagreements
blind-adjudicated by the primary session (candidates unattributed, seeded-random order):

- **d_all = 0.169** (27/160 pre-adjudication disagreements), **d_gated = 0.158**,
  **d_floor = max = 0.169** (the A3 instrument floor). X (unlabelable) = 0.
- Confusion pattern (unordered): E~T 11, E~F 7, D~T 3, D~E 2, D~F 3, F~T 1 — dominated by
  ephemeral-vs-telemetry boundary calls, i.e. WITHIN the gated aggregate.
- Abort threshold (d_all > 0.25): not approached.

**Model-family residual (recorded limitation, verbatim from the plan):** All three labeling
roles are Claude-family models; a correlated model-family bias would still lift the measured
delta and its floor together. This limitation applies to every number in this doc and is
repeated next to the A3 verdict if C3 tightening is measured.

## Baseline results (2 runs, identical aggregates — zero spread)

| stratum | rows | abstained run1 | abstained run2 | abstention rate (both) |
|---|---|---|---|---|
| ephemeral | 39 | 1 | 1 | 0.026 |
| observer-telemetry | 16 | 0 | 0 | 0.000 |
| referent-stripped (measure-only) | 13 | 1 | 1 | 0.077 |
| durable (recall, gold n=14) | 12 | — | — | recall **1.000 / 1.000** |

- Overall noise abstention: **2/68 both runs**. parseFails 0 both runs. Precision 1.000 both
  runs — the noise re-admissions are *supported by* the input (faithful re-emission), which is
  precisely the calibration gap this arc targets: supported-but-worthless.
- **Gated aggregate (ephemeral + telemetry): 54/55 missed, both runs (m = 0.982).**
  Label-unanimous misses (both blind passes independently agreed the row is noise, no
  adjudication involved): **44, both runs.**

## 40-row set re-baseline (T1, metric-definition change)

`extractionFidelity` now excludes empty-gold rows from the precision/recall sums (spec R2-G4).
Re-baseline of `extraction-set.jsonl` post-change, 2 runs: recall **1.000 / 1.000**, precision
1.000 / 0.981 (one judge supported-fact wobble; the documented gpt-4o-mini pattern),
noiseAbstained 7/8 both. **These figures span a metric-definition change — not comparable to
pre-change precision numbers.**

## Fork decision (pre-registered rule, applied mechanically)

Rule (frozen before the baseline ran): C3 fires iff on BOTH runs gated misses ≥ 3 AND ≥ 2 of
those are label-unanimous; and tightening cannot bank if worse-run m ≤ d_floor.

- Run 1: gated misses 54/55, unanimous 44 → predicate TRUE.
- Run 2: gated misses 54/55, unanimous 44 → predicate TRUE.
- Worse-run m = 0.982 > d_floor = 0.169 → not instrument-limited.

**VERDICT: C3 FIRES.** The arc proceeds to the collision slice (T4) and prompt tightening
(T5). A 54/55 miss rate on rows both blind passes called noise cannot be explained as label
noise (unanimous misses 44 ≫ the ~9-row noise ceiling implied by d_gated on 55 rows).

## T5 tightening outcome (A3): REJECTED — prompt edit reverted

Four drafts of DO-NOT-EXTRACT tightening were measured against the pre-registered A3 rule
(B = 54 worse-run gated misses ⇒ accept requires P ≤ 27 and improvement > d_floor·55 ≈ 9.3
rows). Gated misses by draft: **52 → 51 → 47 → 46** (draft 1: category clauses with
transient-vs-settled contrast; draft 2: workstream-bookkeeping re-cut + milestone-identifier
carve; draft 3: consolidated clause with an explicit numbers/identifiers-don't-rescue
override; draft 4: procedural two-question gate). Collision-slice recall stayed 1.000 and the
40-row set stayed recall 1.000 on every measured run; durable stratum held 14/14 (one
recurring judge false-negative on a split conjunction, re-adjudicated per the wobble
protocol).

The best draft closes 8 of 54 gated misses (14.8% vs the required 50%), **below the
fixture's label-noise instrument floor (~9.3 rows)** — a delta that cannot be distinguished
from labeling noise. Per the pre-registered rule this is INCONCLUSIVE/REJECTED, not
bankable; the draft cap was stopped at 4 of 5 rather than iterating the rule into overfit.
The prompt edit was string-reverted before T6; the shipping prompt is unchanged and the arc
falls back to the fixture-is-the-deliverable posture (regression guard around observed
behavior, no behavior-change claim).

Probe-level diagnosis (for the future cross-provider arc): `gpt-4.1-nano` applies the new
clauses to short bare shapes ("the build is green again" → abstains) but the EXTRACT block's
exact-numbers / named-entities pulls override category instructions whenever a row carries
counts, timestamps, paths, or ticket identifiers — which is most of the production corpus.
Closing this gap likely requires a capability step (different extractor model or a
second-stage judge), not prompt wording.

**Model-family residual (repeated at the verdict, verbatim):** All three labeling roles are
Claude-family models; a correlated model-family bias would still lift the measured delta and
its floor together.
