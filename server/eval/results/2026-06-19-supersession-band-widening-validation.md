# Supersession band-widening — live-judge validation (R2 blocker clearance)

**Date:** 2026-06-19 · **Embedder:** text-embedding-3-small · **Judge:** gpt-4o-mini, temp 0, 2 runs
**Harnesses:** `server/eval/band-ceiling-study.mjs` (cosine coverage), `server/eval/supersession-gate-eval.mjs` (live judge)
**Raw:** `results/2026-06-19-band-ceiling-study.json`, `results/2026-06-19-supersession-gate-eval.json`
**Spec/plan:** `docs/plans/2026-06-15-supersession-ceiling-repin-{spec,plan}.md`

## What this answers

The paired-Opus R2 review (`.claude/reviews/2026-06-19-supersession-ceiling-repin-round2/log.md`)
returned **NEEDS-REVISION** with convergent blockers. The central one (BL3): gates (a) and (b) are
the **same judge under the same prompt with opposed requirements**, and **neither had been run** —
the design was paper. BL1: gate (b) tested the judge on n=1 in-band decline row. This validation
rebuilds both fixtures to real in-band coverage and **runs the live judge**, reporting the JOINT
operating point.

## Pin decision — NO-SKIP (judge the whole dedup band ≥0.84)

Corrected-path step 2: τ≈0.95-vs-0.97 is unresolvable without real write-path cost telemetry (the
study's 0.229 cost proxy is circular — computed over the same dup set used to pin τ, BL4). We
therefore validate the **safest** pin: **no cost-skip — every dedup hit ≥0.84 reaches the judge.**
Note: every in-band fixture cosine is < 0.95, so **no-skip and τ=0.95 are identical for this data**;
the cost-skip would do nothing here regardless.

## Fixtures (rebuilt; coverage proven by band-ceiling-study)

| fixture | rows | in-band (≥0.84) | notes |
|---|---|---|---|
| `held-out-contradiction-set.jsonl` (gate a) | 42 | **27** | 11 single-slot-swap, 8 numeric-swap, **8 multi-clause** — all in-band; **18 are >0.87** (dup-skipped today) |
| `over-supersession-set.jsonl` (gate b) | 18 | **10 decline** + 2 boundary | decline in-band = 5 coexisting-multi-value + 3 additive-superset + 2 restatement |

Side-finding (preserved as documentation rows): **most coexisting multi-value swaps embed *below*
0.84** — Visa/Mastercard 0.806, Spanish/Portuguese 0.791, us-east-1/eu-west-1 0.835, PDF/CSV 0.830.
Distinct-value swaps move the vector enough to fall under the floor → out of band → unreachable by
the in-band judge (strengthens spec F2). The coexist pairs that *do* reach the band are only the
very-near-value ones (two AWS certs, light/dark, iOS/Android, weekdays/weekends) + supersets +
restatements.

## Result — JOINT operating point

`band [0.84, 1.0] (no-skip)` · confusion matrix (in-band): **TP=27 FN=0 | TN=9 FP=1**

### Gate (a) capture — held-out contradictions: **PASS (27/27, fire-rate 1.0)**
| stratum | in-band | fired |
|---|---|---|
| single-slot-swap | 11 | 11 |
| numeric-swap | 8 | 8 |
| multi-clause | 8 | 8 |

**18/18 contradictions that today's 0.87 ceiling dup-skips are now captured** — this is the bug
class (s009 "PostgreSQL→MySQL" @0.8725 lives here). The widening delivers its purpose with zero
misses across all difficulty strata, including the harder multi-clause "B, not A" phrasings.

### Gate (b) over-supersession — decline rows must HOLD: **STRICT-FAIL (1 FP) but WIDENING-CLEAN (0 new FP)**
- **1 false-supersede total: `os003`** ("The app runs on iOS" → "…Android"), confidence 0.9,
  stable across runs. Judge reasoning: *"they cannot both be true simultaneously"* — wrong; a
  cross-platform app runs on both. **But os003's cosine is 0.8484 — inside today's [0.84, 0.87]
  band, so it is already judged in production now.** It is a *pre-existing* judge limitation, not a
  regression the widening introduces.
- **Widening's own new slice (cosine > 0.87): 6 decline rows, all 6 declined correctly** — AWS
  certs (0.909/0.887), weekdays/weekends (0.880), CI/Docker supersets (0.946/0.904), Redis
  restatement (0.908). **The widening adds zero false-supersedes.**
- The judge declined every clear coexist/additive/restatement with explicit coexistence reasoning
  ("holding one certification does not invalidate holding another"; "the app can support both light
  and dark mode"). It is **competent at single-vs-multi-valued from two strings** — `os003` is its
  one lapse, on the most genuinely *ambiguous* row (a platform statement plausibly read as a switch).

### Boundary — version upgrades (scored separately, §5.2)
Both **FIRED**: PG14→16 (0.842) and iOS16→17 (0.911), confidence 0.9. **Measurement note:** the
§5.2 revert intended upgrades to *decline* on the hot path, but the judge fires on single-valued
version upgrades — and §6 forbids changing the judge, so "decline on the hot path" is **not
enforceable**; the realized behavior is upgrades-supersede. This is largely benign (for a genuine
single-valued upgrade the new version *is* the current truth). Crucially, the additive-misread
data-loss that §5.2/BL2 feared **did not materialize** — every additive/coexist decline row held.
Whether to accept upgrade-supersession or add an explicit guard is a product call for the re-review.

### Determinism
Temp-0, 2 runs: no decision flipped between runs (only minor reasoning-text variation). The lone FP
is stable, not jitter.

## The open decision (for re-review + user)

The spec's literal gate (b) — "false-supersede = 0 on in-band decline rows" — **fails (1 FP, rate
0.10)**. But the exposure decomposition shows the failure is **pre-existing and out of scope for
this change**, while the widening's own contribution is **clean (0 new FP) and high-value (18 new
captures)**. Two defensible acceptance bars:

- **(A) Widening-clean** (recommended): the change introduces no new over-supersession; the lone FP
  (os003-class) is a pre-existing judge-precision limitation, documented and tracked separately
  (§6 forbids judge changes here). → proceed to re-review, then implement.
- **(B) Strict-zero-FP**: any in-band FP blocks; conclude the in-band hot path cannot meet the bar
  without a judge change → keep the ceiling / defer to the session-end detector. (Note this leaves
  the s009 bug class — 18 measured contradictions — unfixed.)

## Doc corrections folded in (BL4/BL5/I3)
- **BL5 (arithmetic):** the prior "every one of the 44 measured contradictions reaches the judge" is
  false. No-skip ensures the **in-band** contradictions (≥0.84) are judged, not dup-skipped; the
  sub-floor majority (15/42 held-out, most of d3) is a separate *recall* problem, out of scope.
- **BL4 (cost):** the 0.229 proxy is circular and is **not** a gate. Cost is **unmeasured, pending
  real write-path p99-latency telemetry**. No-skip judges every high-cosine re-ingest — the
  interactive-write cost must be measured at/ before rollout, not policed by the proxy.
- **I3 (title):** the change is "**judge the whole dedup band ≥0.84 (no cost-skip)**," functionally
  close to removing the ceiling — not a narrow re-pin. Safety rests on judge precision, not cosine
  separation (the data shows none).
