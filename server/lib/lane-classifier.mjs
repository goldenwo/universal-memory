// server/lib/lane-classifier.mjs
// Gap-5: write-time lane auto-classification via embedding nearest-prototype match.
// Each lane is represented by its exemplar VECTORS; a fact is scored against a lane
// by the mean of its top-K nearest exemplar cosines (multi-prototype), reusing the
// fact embedding dedup already computes (add.mjs) — no extra LLM call.
// Spec: docs/plans/2026-06-04-gap5-lane-classifier-spec.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateLanePersonaSlug } from './default-project.mjs';
import { embed } from './embed.mjs';
import { getLogger } from './logger.mjs';
import { umLaneClassifiedTotal } from './metrics.mjs';
// cosineSimilarity lives in ./vector.mjs (shared with the eval harnesses, rule of
// three). classifyByPrototypes below uses the FAIL-SAFE cosineSimilarity — a bad
// vector must never throw on the write path.
import { cosineSimilarity } from './vector.mjs';

const DEFAULT_TAXONOMY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'lane-taxonomy.default.json');

// Mean of the top-K cosines between `vector` and a lane's exemplar vectors.
// Multi-prototype scoring: a lane is matched by its NEAREST few exemplars, not a
// single mean-pooled centroid — so semantically multi-modal lanes (personal:
// health/family/finance/home; research: papers/experiments/stats) are matched by
// the relevant exemplar instead of a washed-out average. K is clamped to the lane's
// exemplar count (and to ≥1). Uses the FAIL-SAFE cosineSimilarity (never throws).
// Eval (re-validated 2026-06-08): top-3-mean over the ENRICHED ~12-exemplar taxonomy
// scores 0.962/0.797 precision/recall on the harder 106-row fixture (de-leaked +
// held-out positives + 20 cross-lane negatives; eval/results/2026-06-08-lane-run{1,2}).
// The gain is JOINT — mechanism × exemplar richness: in the original mechanism-selection
// ablation, top-3-mean on the old 6-exemplar set reached only 0.479 recall, and the
// enriched set under a centroid-like K only 0.333. Neither lever alone suffices;
// top-K-mean over a richer exemplar set recovers the lanes a single mean-pooled
// centroid washes out.
function topKMeanCosine(vector, vectors, topK) {
  if (!vectors || vectors.length === 0) return 0;
  const sims = vectors.map((v) => cosineSimilarity(vector, v)).sort((a, b) => b - a);
  const k = Math.max(1, Math.min(topK, sims.length));
  let sum = 0;
  for (let i = 0; i < k; i++) sum += sims[i];
  return sum / k;
}

// Classify a fact vector by nearest lane prototypes: score each lane by the
// top-K-mean cosine over its exemplar vectors, argmax, then abstain (lane:null)
// when the top score is below `threshold` or within `margin` of the runner-up
// (the ambiguity guard). `laneProtos` = [{ slug, vectors: number[][] }] from
// buildLanePrototypes. Below-threshold / low-margin → omit (no `general` lane).
export function classifyByPrototypes(vector, laneProtos, { threshold, margin = 0, topK = LANE_TOPK_DEFAULT } = {}) {
  if (!laneProtos.length) return { lane: null, score: 0 };
  const scored = laneProtos
    .map(({ slug, vectors }) => ({ slug, score: topKMeanCosine(vector, vectors, topK) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1]?.score ?? -Infinity;
  if (top.score < threshold) return { lane: null, score: top.score };
  if (margin > 0 && top.score - second < margin) return { lane: null, score: top.score };
  return { lane: top.slug, score: top.score };
}

export function loadLaneTaxonomy(env = process.env) {
  const path = env.UM_LANE_TAXONOMY_PATH || DEFAULT_TAXONOMY_PATH;
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return []; } // missing/unreadable taxonomy → inert classifier (fail-safe)
  return (Array.isArray(raw.lanes) ? raw.lanes : [])
    .map(({ slug, exemplars }) => ({
      slug: validateLanePersonaSlug({ value: slug, fieldName: 'lane' }), // throws INPUT_INVALID on bad slug
      exemplars: Array.isArray(exemplars) ? exemplars : [],
    }))
    .filter((l) => l.slug && l.exemplars.length > 0);
}

// Build per-lane exemplar PROTOTYPES: retain every exemplar's vector (not a single
// mean-pooled centroid) so classifyByPrototypes can score by nearest exemplars
// (top-K-mean). embedFn MUST be the same embedder used for facts (same vector
// space) — defaults to the production embed(); injected in tests.
export async function buildLanePrototypes(taxonomy, embedFn = embed) {
  const protos = [];
  for (const { slug, exemplars } of taxonomy) {
    const vectors = await Promise.all(exemplars.map(async (ex) => (await embedFn(ex)).vector));
    protos.push({ slug, vectors });
  }
  return protos;
}

// ---------------------------------------------------------------------------
// Fail-safe entry point + cached prototypes + metric
// ---------------------------------------------------------------------------

let _protosPromise = null;
export function _resetPrototypesForTest() { _protosPromise = null; }

async function getPrototypes(opts) {
  if (opts._prototypes) return opts._prototypes;
  if (!_protosPromise) {
    const taxonomy = opts._taxonomy ?? loadLaneTaxonomy();
    // Don't cache a REJECTED build: a transient embed failure during prototype
    // build must not permanently disable the classifier until process restart.
    // On failure, clear the cache so the next classify retries the build.
    _protosPromise = buildLanePrototypes(taxonomy, opts._embedFn ?? embed)
      .catch((err) => { _protosPromise = null; throw err; });
  }
  return _protosPromise;
}

// Eval-pinned defaults (Gap-5, multi-prototype mechanism; pinned 2026-06-07,
// re-validated 2026-06-08 on the de-leaked + grown fixture). τ_lane=0.30 + margin=0.08
// + topK=3 clears the spec §5 ≥0.95 precision floor at 0.962 precision / 0.797 recall
// on the harder 106-row fixture (64 positives, 42 negatives = 22 noise / 20 cross-lane;
// eval/results/2026-06-08-lane-run{1,2}). The prior 82-row run scored 0.977/0.875;
// de-leaking 2 near-paraphrase exemplars + adding held-out positives and cross-lane
// negatives traded that headline for an honest generalization estimate — the pinned
// cell is unchanged and still the max-recall floor-clearing cell. This supersedes the
// P2 single-centroid pin (0.30/0.06), which fell to 0.479 recall once the negative set
// was grown to be production-representative. topK AND exemplar richness are JOINTLY
// load-bearing (single-centroid reaches the floor only at ~0.50 recall; the enriched
// set under a centroid-like K only ~0.33). Drift-gated in test/lane-classifier.test.mjs
// — update lib + test + server/.env.example UM_LANE_CLASSIFIER_THRESHOLD/_MARGIN/_TOPK together.
export const LANE_THRESHOLD_DEFAULT = 0.30;
export const LANE_MARGIN_DEFAULT = 0.08;
export const LANE_TOPK_DEFAULT = 3;

function laneThreshold(env = process.env) {
  const n = Number.parseFloat(env.UM_LANE_CLASSIFIER_THRESHOLD);
  return Number.isFinite(n) ? n : LANE_THRESHOLD_DEFAULT;
}

function laneMargin(env = process.env) {
  const n = Number.parseFloat(env.UM_LANE_CLASSIFIER_MARGIN);
  return Number.isFinite(n) ? n : LANE_MARGIN_DEFAULT;
}

function laneTopK(env = process.env) {
  const n = Number.parseInt(env.UM_LANE_CLASSIFIER_TOPK, 10);
  return Number.isInteger(n) && n > 0 ? n : LANE_TOPK_DEFAULT;
}

export function classifierEnabled(env = process.env) {
  // P4: opt-out (active by default) — mirrors UM_DEDUP_ENABLED / UM_AUTOSUPERSEDE_ENABLED.
  return env.UM_LANE_CLASSIFIER_ENABLED?.trim() !== 'false';
}

// Fail-safe entry used by umAdd. NEVER throws to the caller — any internal
// error degrades to an unpartitioned write ({ lane: null }). Reuses the
// caller-provided `vector` (the fact embedding) — no extra embed of the fact.
// Future (spec §3.3): this is the LaneClassifier dispatch point. The prototype
// path (getPrototypes) is the DEFAULT impl, not a hardcoded choice — an eval-gated
// LlmClassifier would branch here on UM_LANE_CLASSIFIER_PROVIDER without reworking
// the umAdd seam.
export async function classifyLane(vector, opts = {}) {
  try {
    const protos = await getPrototypes(opts);
    const r = classifyByPrototypes(vector, protos, {
      threshold: opts.threshold ?? laneThreshold(),
      margin: opts.margin ?? laneMargin(),
      topK: opts.topK ?? laneTopK(),
    });
    umLaneClassifiedTotal.inc({ outcome: r.lane ? 'routed' : 'omitted' });
    return r;
  } catch (err) {
    (opts._logger ?? getLogger()).warn(
      { event: 'lane.classify_error', err: err?.message },
      'lane classify failed; writing unpartitioned',
    );
    umLaneClassifiedTotal.inc({ outcome: 'error' });
    return { lane: null, score: 0 };
  }
}
