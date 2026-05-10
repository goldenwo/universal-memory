# D1 cross-surface fact dedup — architecture & threshold defaults

**Status:** v1.1 (eval-derived default; flag still OFF by default)
**Last eval:** 2026-05-09 (`text-embedding-3-small`, 50-pair fixture)
**Current default:** `UM_DEDUP_EMBEDDING_THRESHOLD=0.84`
**Result file (current):** [`server/eval/results/latest.json`](../../server/eval/results/latest.json)

---

## Overview

D1 is a server-side hook in `umAdd()` that prevents the same proposition from being stored multiple times when it arrives via different surfaces (Claude Code, Discord OpenClaw, vault reindex, etc.). Without D1, the same fact written from CC and Discord becomes two separate qdrant points; D1 collapses them to one point with a `surfaces` Set tracking the set of writers.

The hook runs in two layers:

1. **Layer 1 — content-hash dedup.** md5(text) under the caller's userId. Catches byte-identical writes (the classic "user pastes the same fact in two places" case). Cheap (one qdrant scroll). Cannot catch non-byte-identical paraphrases.
2. **Layer 2 — embedding-similarity dedup.** Cosine similarity ≥ `UM_DEDUP_EMBEDDING_THRESHOLD` under the caller's userId. Catches paraphrase pairs the hash layer misses. Cost: one qdrant search per write (when Layer 1 misses).

When either layer hits, the existing point's `surfaces` and `projects` Sets are extended via `setPayload`, and `dedupCount` increments. The original point's text is preserved (no overwrite); the second write is dropped. Failure modes are bounded — if either layer's qdrant call errors, `umAdd()` falls through to a plain upsert, accepting a temporary duplicate rather than dropping the user's data.

The hook is gated by `UM_DEDUP_ENABLED`, default OFF in v1.1. The flag-flip PR is the next step in the v1.1 D1 work; this doc + the empirical default are its prerequisites.

See [PR #75](https://github.com/goldenwo/universal-memory/pull/75) for the full spec/implementation; this doc focuses on the threshold methodology and current default.

---

## Why a threshold matters

`UM_DEDUP_EMBEDDING_THRESHOLD` controls Layer 2. Two cosine-similar embeddings with score ≥ τ collapse to one qdrant point; below τ they coexist as separate points.

The cost of being wrong is asymmetric:

- **False merge (τ too low)** is destructive and irreversible. The merged point keeps text A; text B is dropped. If A and B were genuinely different propositions, the user has lost data they cannot easily recover (the original B text is not stored anywhere).
- **Missed merge (τ too high)** is benign. The user has two near-duplicate facts where one would have sufficed; worst case is mild noise + an extra qdrant point. The user can `/forget` one later, or live with the duplication.

The 5:1 cost ratio above motivates the eval's primary metric: **F-beta with β=0.5**, which weights precision 2× recall.

---

## Methodology

### Fixture composition

The labeled fixture lives at [`server/test/fixtures/dedup-labels.json`](../../server/test/fixtures/dedup-labels.json). 50 hand-authored English pairs:

| Tier | Count | Definition |
|---|---|---|
| `identical` | 10 | Same proposition, trivial surface variation only (whitespace/case/punctuation, synonymous trivial reword) |
| `paraphrase` | 25 (incl. 5 noisy-real) | Same proposition, substantive lexical/syntactic variation |
| `unrelated` | 15 | Propositionally disjoint — different SUBJECT or different PREDICATE |

Source mix: preferences, project facts, procedural, personal events, cross-surface (CC↔OpenClaw), and 5 noisy-real (real surface artifacts: tool-output fragments, Discord markdown remnants, code-fence remnants, interrupted thought, mobile signature noise).

**Bias control:** every pair was authored *before* the eval ran. The empirical seed pair from D1 PR #75 L2 live testing ("I prefer the Rust programming language." vs "My preferred programming language is Rust.", cosine 0.881) is included with explicit `notes` so the eval result can confirm or refute the prior.

**Out of scope for v1.1:** sentiment-flip near-paraphrase ("I love X" vs "I hate X"), cross-project pairs (the `projectContext` field is set to `same-project` on every v1.1 record so post-F1 v1.2 extensions can add cross-project entries without re-reading the existing fixture), and adversarial pairs (typo-flip, entity-swap with sentiment).

### Sweep range + metrics

- **Range:** [0.80, 1.00] step 0.01 (21 thresholds).
- **Per-pair, per-threshold decision:** `merge if cosine(a, b) ≥ τ`.
- **Per-tier rates** with **Wilson 95% CI** on each:
  - `paraphrase_recall` = paraphrase pairs merged / total paraphrase
  - `unrelated_precision` = 1 − (unrelated merged / total unrelated)
  - `identical_recall` = identical merged / total identical (advisory; see §A3 below)
- **Primary elbow metric: F_0.5** = 1.25 × P × R / (0.25 × P + R), where P = unrelated_precision, R = paraphrase_recall. β=0.5 weights precision 2× recall, baking in the 5:1 cost asymmetry.
- **F_0.5 bootstrap CI** via 1000 resamples of the 50 pairs.
- **Auxiliary metrics** reported but not used for elbow selection: combined-score (P × R), paraphrase F1 (β=1), expected_cost (5 × false-merges + 1 × missed-merges).

### Elbow selection

The recommended τ is the τ that maximizes F_0.5 within the **bootstrap-CI overlap band** of the maximum:

1. Find τ_max with highest F_0.5 point estimate.
2. Band = all τ whose F_0.5 CI intersects τ_max's CI. (Statistically indistinguishable thresholds.)
3. **If band ≤ 5 contiguous τ:** pick the highest τ in the band (tie-breaker favors precision per the cost asymmetry).
4. **If band > 5 contiguous τ:** flag plateau, pick the band's midpoint via `floor(length/2)`.

The CI-overlap rule is the methodologically-correct response to a small (n=50) sample: the chosen τ comes from a *band* of indistinguishable thresholds, not a single point estimate.

---

## Current result (2026-05-09, text-embedding-3-small)

| Field | Value |
|---|---|
| Recommended τ | **0.84** |
| F_0.5 at τ | 0.769 |
| F_0.5 95% CI | [0.571, 0.876] |
| Plateau | **true** (8-element band) |
| Band τ values | 0.80, 0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87 |
| Paraphrase recall at τ | 0.40 (10/25) |
| Unrelated precision at τ | **1.00** (15/15) |
| Identical recall at τ | 0.90 (9/10) |
| Hash collision rate (identical tier) | 0.00 |
| Max cosine per tier | identical 0.984, paraphrase 0.915, unrelated **0.758** |
| Repeatability max delta | 0.0017 (well under 0.005 threshold) |
| OpenAI cost (full eval) | $0.0000185 |

**Headline:** the recommended default moves from the seat-of-pants `0.95` to **`0.84`** — a +0.11 expansion of D1's recall envelope.

### Surprising finding: precision saturates at 1.0 across the entire sweep range

For our v1.1 fixture, **every** τ in [0.80, 1.00] produces zero false merges on the 15 unrelated pairs. The model's max cosine on unrelated pairs (0.758) sits comfortably below the lowest τ tested (0.80), so the precision metric never rewards going higher than τ=0.80.

The plateau is therefore not statistical noise — it's a real saturation of one axis. The midpoint heuristic gives τ=0.84 as a moderately-conservative anchor inside that band, but a maintainer could defensibly choose any τ ∈ [0.80, 0.87] without changing precision. Lower τ values capture more paraphrases (recall 0.48 at τ=0.80 vs 0.40 at τ=0.84 vs 0.32 at τ=0.86) at no cost to precision *for this fixture*.

**Why we chose 0.84 (the midpoint, not the recall-maximizing 0.80):** the 50-pair fixture is small enough that precision=1.0 may not extrapolate to a much larger corpus. A future re-run with more aggressive unrelated-tier distractors might surface false merges in the [0.80, 0.83] band that this fixture doesn't catch. Picking the band midpoint is the precision-vs-recall hedge.

### Diagnostic: identical-tier failure at τ=0.84

One identical pair fails to merge at τ=0.84:

| a | b | cosine | source | note |
|---|---|---|---|---|
| `Rust is great.` | `rust is great` | **0.766** | preferences | casing + punctuation only |

`text-embedding-3-small` encodes both casing and trailing punctuation; treating the pair as "identical" was a labeling judgment that the model does not fully share. **This is real model behavior, not a labeling error** — we leave it as `identical` in the fixture so the diagnostic surfaces transparently. The hash layer (Layer 1) catches byte-identical pairs upstream, so this case never reaches Layer 2 in production unless someone deliberately writes the two variants to two surfaces.

A3 (≥ 90% identical recall at chosen τ) passes: 9/10 = 90%.

### Diagnostic: cross-surface paraphrases are the model's weak point

D1's primary use case is cross-surface dedup (CC ↔ Discord OpenClaw). But cross-surface paraphrase pairs (5 in the fixture) score the LOWEST cosines:

| Pair | Cosine |
|---|---|
| Feature request: ... vs `want md export on reports` | 0.516 |
| Status update: ... vs `ingestion migration in review` | 0.595 |
| Reminder: deploy is scheduled... vs `deploy fri 4pm utc` | 0.657 |
| User reported authentication failure... vs `auth bug on login` | 0.697 |
| Bug report: search returns stale... vs `search returns stale data after writes` | 0.733 |

At τ=0.84, **none of these merge.** D1's embedding tier captures procedural and preference paraphrases well, but cross-surface formal-vs-casual variation is too lexically distant for `text-embedding-3-small` at the chosen threshold. The hash layer still catches byte-identical cross-surface duplicates (e.g., user pastes the same status into both surfaces).

**Implication for the flag-flip PR:** D1 at τ=0.84 is most useful for *intra-surface* paraphrase consolidation (e.g., the same fact phrased two ways within CC over time) and byte-identical cross-surface dedup. Pure cross-surface paraphrase consolidation (formal CC vs casual Discord) likely needs either a more robust embedding model (`text-embedding-3-large`?) or a different layer entirely (LLM-as-judge classifier on top of cosine?).

### Repeatability

The eval ran twice with a 60-second gap (CLI `--gap-seconds 60`); the spec's recommended default is 600s. We used 60s for the v1.1 eval based on the empirical observation that text-embedding-3-small is essentially deterministic at short gaps; the per-pair max cosine delta across the two runs was **0.0017**, well below the 0.005 escalation threshold from spec R7. Future re-runs may use the spec default of 600s when stricter assurance is desired.

---

## How to re-run the eval

Default REPEAT mode (recommended for production re-runs):

```bash
# From the project root, with OPENAI_API_KEY in env (or in server/.env).
cd server
set -a && source .env && set +a
node eval/dedup-threshold-sweep.mjs \
  --fixture test/fixtures/dedup-labels.json \
  --out-prefix eval/results/<YYYY-MM-DD>-<model> \
  --gap-seconds 600
```

This produces three files in `eval/results/`:
- `<date>-<model>-run1.json` — first sweep
- `<date>-<model>-run2.json` — second sweep
- `latest.json` — synthesized canonical result with `repeatability` block. The doc here links to `latest.json`; dated files preserve audit history.

Single-shot mode (development sanity checks only — does not satisfy spec R7):

```bash
node eval/dedup-threshold-sweep.mjs \
  --fixture test/fixtures/dedup-labels.json \
  --out eval/results/<YYYY-MM-DD>-<model>-sanity.json \
  --no-repeat
```

### When to re-run

- **Embedding model swap** — e.g., `text-embedding-3-small` → `text-embedding-3-large` or a non-OpenAI provider. Cosine distributions differ by model; the threshold doesn't transfer.
- **F1 schema-shift** — the project-soft-default unification ([handoff candidate #3](../plans/2026-05-08-universality-roadmap.md)) introduces cross-project pairs into the dedup-key. The fixture's `projectContext` field is pre-staged for v1.2 cross-project additions.
- **Suspected false-merge complaint in production** — a real false-merge report is signal that the unrelated tier in the fixture under-represents the problem space; extend the fixture and re-run.
- **≥6 months since last eval** — model retraining surveillance. Even with a pinned model name, OpenAI may silently substitute or retrain.

---

## Implementation pointers

- Layer 1 + Layer 2 helpers: [`server/lib/dedup.mjs`](../../server/lib/dedup.mjs)
- Reserved-field guard + `NAMESPACE_UM`: [`server/lib/dedup-constants.mjs`](../../server/lib/dedup-constants.mjs)
- Hook integration in `umAdd()`: [`server/lib/add.mjs`](../../server/lib/add.mjs)
- Sweep harness: [`server/eval/dedup-threshold-sweep.mjs`](../../server/eval/dedup-threshold-sweep.mjs)
- Smoke test: [`server/test/eval-dedup-threshold-sweep.test.mjs`](../../server/test/eval-dedup-threshold-sweep.test.mjs)

The methodology spec + plan are gitignored maintainer artifacts at `docs/plans/2026-05-09-d1-threshold-eval-{spec,plan}.md`.

---

## Result history

For now this doc is the first eval; subsequent re-runs append rows below or update `latest.json`. The dated run files in `server/eval/results/` are the audit trail.

| Date | Model | Fixture rev | τ | F_0.5 (CI) | Plateau | Repeatability max-delta | Notes |
|---|---|---|---|---|---|---|---|
| 2026-05-09 | text-embedding-3-small | initial | **0.84** | 0.77 [0.57, 0.88] | yes (8-τ band) | 0.0017 | Precision saturates at 1.0 across [0.80, 1.00]; cross-surface paraphrases the model's weak point |
