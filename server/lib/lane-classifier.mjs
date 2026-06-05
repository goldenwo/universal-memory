// server/lib/lane-classifier.mjs
// Gap-5: write-time lane auto-classification via embedding-centroid nearest-match.
// Reuses the fact embedding dedup already computes (add.mjs:231) — no extra LLM call.
// Spec: docs/plans/2026-06-04-gap5-lane-classifier-spec.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateLanePersonaSlug } from './default-project.mjs';
import { embed } from './embed.mjs';
import { getLogger } from './logger.mjs';
import { umLaneClassifiedTotal } from './metrics.mjs';
// cosineSimilarity + meanPool live in ./vector.mjs (shared with the eval
// harnesses, rule of three). classifyByCentroid below uses the FAIL-SAFE
// cosineSimilarity — a bad vector must never throw on the write path.
import { cosineSimilarity, meanPool } from './vector.mjs';

const DEFAULT_TAXONOMY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'lane-taxonomy.default.json');

export function classifyByCentroid(vector, centroids, { threshold, margin = 0 } = {}) {
  if (!centroids.length) return { lane: null, score: 0 };
  const scored = centroids
    .map(({ slug, centroid }) => ({ slug, score: cosineSimilarity(vector, centroid) }))
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

// Build one centroid per lane. embedFn MUST be the same embedder used for facts
// (same vector space) — defaults to the production embed(); injected in tests.
export async function buildCentroids(taxonomy, embedFn = embed) {
  const centroids = [];
  for (const { slug, exemplars } of taxonomy) {
    const vecs = await Promise.all(exemplars.map(async (ex) => (await embedFn(ex)).vector));
    centroids.push({ slug, centroid: meanPool(vecs) });
  }
  return centroids;
}

// ---------------------------------------------------------------------------
// Task 6: fail-safe entry point + cached centroids + metric
// ---------------------------------------------------------------------------

let _centroidsPromise = null;
export function _resetCentroidsForTest() { _centroidsPromise = null; }

async function getCentroids(opts) {
  if (opts._centroids) return opts._centroids;
  if (!_centroidsPromise) {
    const taxonomy = opts._taxonomy ?? loadLaneTaxonomy();
    // Don't cache a REJECTED build: a transient embed failure during centroid
    // build must not permanently disable the classifier until process restart.
    // On failure, clear the cache so the next classify retries the build.
    _centroidsPromise = buildCentroids(taxonomy, opts._embedFn ?? embed)
      .catch((err) => { _centroidsPromise = null; throw err; });
  }
  return _centroidsPromise;
}

// Eval-pinned defaults (Gap-5 P2, 2026-06-05). τ_lane=0.30 + margin=0.06 cleared
// the spec §5 ≥0.95 precision floor at 0.953 precision / 0.854 recall on the
// labelled fixture; the discretized outcomes were identical across two live runs
// (eval/results/2026-06-05-lane-run{1,2}). The margin is LOAD-BEARING: at margin 0
// the floor is only reachable at τ≥0.52, where recall collapses to ≤0.15 — the
// 0.06 margin is what lets τ=0.30 clear the floor at recall 0.854. Drift-gated in
// test/lane-classifier.test.mjs — update lib + test + server/.env.example together.
export const LANE_THRESHOLD_DEFAULT = 0.30;
export const LANE_MARGIN_DEFAULT = 0.06;

function laneThreshold(env = process.env) {
  const n = Number.parseFloat(env.UM_LANE_CLASSIFIER_THRESHOLD);
  return Number.isFinite(n) ? n : LANE_THRESHOLD_DEFAULT;
}

function laneMargin(env = process.env) {
  const n = Number.parseFloat(env.UM_LANE_CLASSIFIER_MARGIN);
  return Number.isFinite(n) ? n : LANE_MARGIN_DEFAULT;
}

export function classifierEnabled(env = process.env) {
  return env.UM_LANE_CLASSIFIER_ENABLED?.trim() === 'true'; // opt-in; flips to opt-out in P4
}

// Fail-safe entry used by umAdd. NEVER throws to the caller — any internal
// error degrades to an unpartitioned write ({ lane: null }). Reuses the
// caller-provided `vector` (the fact embedding) — no extra embed of the fact.
// Future (spec §3.3): this is the LaneClassifier dispatch point. The centroid
// path (getCentroids) is the DEFAULT impl, not a hardcoded choice — an eval-gated
// LlmClassifier would branch here on UM_LANE_CLASSIFIER_PROVIDER without reworking
// the umAdd seam.
export async function classifyLane(vector, opts = {}) {
  try {
    const centroids = await getCentroids(opts);
    const r = classifyByCentroid(vector, centroids, {
      threshold: opts.threshold ?? laneThreshold(),
      margin: opts.margin ?? laneMargin(),
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
