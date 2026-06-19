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

`band [0.84, 1.0] (no-skip)` · 5 runs, temp 0, all rows stable · confusion matrix (in-band): **TP=27 FN=0 | TN=9 FP=2**

> **R3 UPDATE (supersedes the initial "widening-clean" finding).** On the R3 reviewers' survivorship
> critique (the in-band coexist sample was the easy, shared-anchor tail), 4 *harder* coexist rows
> were added (non-accumulative predicates). Three fell sub-floor (USD/EUR 0.806, Python/Ruby 0.732,
> Signal/WhatsApp 0.718 — F2 holds), but **`os022` "parking on the north side"→"…south side"
> (cosine 0.9632, in the WIDENED slice) FIRED 5/5** — a real false-supersede the widening introduces.
> **`wideningClean` is now FALSE.** The widening adds a data-loss path on high-cosine multi-value
> coexist facts. See the corrected gate (b) + decision below.

### Gate (a) capture — held-out contradictions: **PASS (27/27, fire-rate 1.0)**
| stratum | in-band | fired |
|---|---|---|
| single-slot-swap | 11 | 11 |
| numeric-swap | 8 | 8 |
| multi-clause | 8 | 8 |

**18/18 contradictions that today's 0.87 ceiling dup-skips are now captured** — this is the bug
class (s009 "PostgreSQL→MySQL" @0.8725 lives here). The widening delivers its purpose with zero
misses across all difficulty strata, including the harder multi-clause "B, not A" phrasings.

### Gate (b) over-supersession — decline rows must HOLD: **STRICT-FAIL (2 FP) and WIDENING-REGRESSION (1 new FP)**
11 in-band decline rows, **2 false-supersedes**, both stable 5/5:
- **`os003`** ("app runs on iOS"→"…Android", cos **0.8484**, *current* band) — pre-existing: 0.8484
  < the current 0.87 ceiling, so it is already judged in production and the widening provably cannot
  enlarge its firing population. Out of scope for this change (the judge's own limitation; §6).
- **`os022`** ("parking on the north side"→"…south side", cos **0.9632**, *widened* slice) — **a NEW
  false-supersede the widening introduces.** The judge: *"directly contradicts … assuming both refer
  to the same time frame"* — wrong; a venue can have parking on both sides. This is a multi-value
  coexist fact wrongly demoted, reachable only because the band was widened past 0.87.
- The judge still declines the *clear* coexist/additive/restatement rows with explicit reasoning
  (AWS certs, light/dark, weekdays/weekends, supersets, restatements). Its failures are on near-value
  multi-value pairs that embed very high (one-word diff in a long sentence → cos >0.95): it reads
  them as single-valued contradictions. **There is no cosine that separates these from real
  contradictions** — coexist-FPs span 0.85 (os003) to 0.96 (os022); held-out contradictions span
  0.85–0.94. Cosine cannot gate it; the judge is the only separator and it has a real error rate here.
- **Mitigation (verified, R3 lens B):** supersede is a recoverable **status-flip, not a delete** —
  the demoted point survives in qdrant as `status:superseded` with provenance and is restorable. So
  the worst realized outcome is a *recoverable* demotion (the fact is invisible to reads until
  restored), not destruction. Combined with the flag + env-knob rollback, the stakes of a false-
  supersede are lower than "permanent loss" — but it is still a real recall regression.

### Boundary — version upgrades (scored separately, §5.2)
Both **FIRED**: PG14→16 (0.842) and iOS16→17 (0.911), confidence 0.9. **Measurement note:** the
§5.2 revert intended upgrades to *decline* on the hot path, but the judge fires on single-valued
version upgrades — and §6 forbids changing the judge, so "decline on the hot path" is **not
enforceable**; the realized behavior is upgrades-supersede. For a genuine single-valued upgrade the
new version *is* the current truth, and the demote is recoverable. The additive/restatement decline
rows all held; the **coexist class did not** (os003, os022) — see gate (b). Whether to accept
upgrade-supersession or add an explicit guard is a product call for the decision below.

### Gate (c) no-false-merge — D1 duplicates must stay merged: **PASS (19/19, 0 false-supersede)**
The merge-positive D1 dedup set (identical + paraphrase pairs) fed through the same live judge:
**19/19 in-band duplicates declined** (stay `DEDUP_MERGED`), zero superseded. The widening does not
convert true duplicates into supersedes — closes review A-G1 (the original gate measured only
cosines).

### Determinism
Temp-0, **5 runs** (R3 A-G3): **every row stable, unstableCount 0** — including both false-supersedes
(os003 5/5, os022 5/5) and all 27 captures. The findings are not jitter; they are the judge's stable
behavior at conf 0.9.

## The decision (the verdict flipped at R3 — re-surface to user)

Gate (a) PASS (27/27, 18 rescued), gate (c) PASS (19/19 dups merge). The blocker is gate (b): the
widening is **NOT clean** — `os022` (cos 0.9632) is a new, stable false-supersede in the widened
slice. The earlier "widening-clean" rested on the easy-tail coexist sample the R3 reviewers flagged;
the harder test falsified it. Net trade, measured:

- **Benefit:** rescues **18/18** contradictions today's 0.87 ceiling silently drops (the s009 class
  → stale-then-lost). This is UM's core currency advantage.
- **Cost:** introduces a false-supersede on **high-cosine multi-value coexist** facts (1 in 7
  widened-slice decline rows here; the dangerous class is near-value pairs like north/south, that
  embed >0.95). **Recoverable** (status-flip, not delete) + flag + env-knob, but a real recall
  regression. No cosine cutoff avoids it (coexist-FPs span the whole band).

Three options (user's call — risk appetite: staleness vs over-supersession):
- **(A) Accept the residual & ship** — currency-first; the demote is recoverable, flag-gated, knob to
  roll back; document os022-class as a known residual. Fixes 18 contradictions now.
- **(B) Don't widen** — data-integrity-first; keep the 0.87 ceiling. Leaves the s009 stale-then-lost
  bug unfixed (the original motivation).
- **(C) Partial widen** (e.g. 0.87→~0.92) — catches most of the s009 class while excluding the very-
  high-cosine zone where near-value coexist lives. Re-opens the τ-pin/cost question (BL4) and is not
  clean (os003-class coexist-FPs sit low in the band too); a compromise, not a fix.

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
