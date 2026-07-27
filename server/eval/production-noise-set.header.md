# production-noise-set.jsonl — fixture header (salience arc, 2026-07-27)

Committed sanitized tier of the production-noise fixture: 80 rows (ephemeral 39,
observer-telemetry 16, referent-stripped 13, durable 12), each a 1:1 shape-preserving
paraphrase of a gitignored raw production row (tense, aspect, referent structure, and
telemetry framing kept; all personal/infra/financial content replaced with invented
domains). Sanitization verified by `eval/sanitization-gate.mjs` (pairwise verdict parity ×2,
clause probe ×2 on both tiers, zero shared content-token 5-grams, rare-token scan) — report:
`eval/results/2026-07-27-sanitization-gate.json`.

**Echo-test limitation (spec §2, verbatim):** this fixture measures **re-admission, not
replay** — rows are memory-store text fed to `facts()`, the surface the eval has always
measured; the original transcript-level capture context of the retired hook is not
reproduced.

**Label semantics (A4b — read before touching floors):**

- `expected_verdict` is the DESIGNED label (abstain for the three noise strata, extract for
  durable twins), set at authoring and NEVER overwritten by observation.
- `unstable: true` (2 rows: n18, n59) marks twins whose observed verdict flipped between
  authoring runs — excluded from the CI gate denominators and counted.
- **Known-miss rows: 65** — stable noise twins that the CURRENT shipping prompt extracts
  anyway (observed verdict contradicts the designed label). They stay in the fixture with
  their designed labels; the CI floors in `mq-gate-thresholds.json` are pinned from OBSERVED
  match rates, so the nightly guard is a **regression tripwire around today's measured
  behavior, not proof of calibration fidelity**. The T5 tightening attempt against these
  rows was measured and REJECTED (best draft's improvement sat below the fixture's
  label-noise floor) — see `eval/results/2026-07-27-salience-baseline.md`. 0 durable twins
  are known-misses (all extract correctly).
- `expected_clause` uses the shipping prompt's five DO-NOT clause ids plus `none`; the three
  measured noise categories have no covering clause in the shipping prompt (that gap is the
  fixture's finding), so noise twins are mostly `none`. Durable twins carry `null`.

Provenance: seeded draw (seed 20260727) from the 982 exact-deduped `claude-code-hook` rows;
blind double-labeling (two independent subagent passes, d_all 0.169, d_gated 0.158) with
blind adjudication; durable rows vetted against the audit's fabrication/self-ingestion
failure modes. Raw tier + full label files live only in the operator's gitignored audit dir.
