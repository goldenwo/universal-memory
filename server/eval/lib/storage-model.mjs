// server/eval/lib/storage-model.mjs
// Pure footprint math for the storage/index-growth eval (#19). No live calls, no qdrant —
// importing this stays fully offline (the harness no-live-calls contract).

export const FLOAT32_BYTES = 4;
export const DEFAULT_INDEXING_THRESHOLD = 20000; // qdrant optimizers_config.indexing_threshold default
export const DEFAULT_HNSW_M = 16;                // qdrant hnsw_config.m default

/** In-RAM float32 vector store cost for n points of dimension dim. */
export function vectorBytes(n, dim) {
  return n * dim * FLOAT32_BYTES;
}

/** Model prediction: qdrant builds the HNSW graph once a segment exceeds the indexing threshold. */
export function indexed(n, threshold = DEFAULT_INDEXING_THRESHOLD) {
  return n >= threshold;
}

import { createHash } from 'node:crypto';

const md5Hex = (s) => createHash('md5').update(s).digest('hex');
// A fixed ISO timestamp keeps payload bytes deterministic across runs (real createdAt is also a
// 24-char ISO string, so the byte cost is identical — only the value differs).
const FIXED_ISO = '2026-01-01T00:00:00.000Z';

/**
 * Production-faithful payload replicating add.mjs buildPayload (server/lib/add.mjs:96-126):
 * userId, data, hash, createdAt, [lane], [persona], [surfaces], [projects], dedupCount,
 * dedupVersion, status. Optional keys use the same conditional-spread as production so the
 * key SET (and thus byte cost) matches. Synthetic seed omits persona/surfaces/projects by
 * default (representative of the common single-lane fact); pass them to include.
 */
export function buildSyntheticPayload({ text, userId, index = 0, lane, persona, surface, project } = {}) {
  const surfaces = surface ? [surface] : undefined;
  const projects = project ? [project] : undefined;
  return {
    userId,
    data: text,
    hash: md5Hex(`${text}:${index}`),
    createdAt: FIXED_ISO,
    ...(lane !== undefined ? { lane } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(surfaces ? { surfaces } : {}),
    ...(projects ? { projects } : {}),
    dedupCount: 1,
    dedupVersion: 1,
    status: 'current',
  };
}

/** UTF-8 byte length of the JSON-serialized payload (what qdrant stores on disk). */
export function payloadBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/** mulberry32 — small deterministic PRNG (no Math.random; the eval forbids it). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic ~unit-norm vector of length dim. Vector CONTENT is irrelevant to storage size
 * (qdrant stores dim·4 bytes regardless), so any finite vector is faithful; we normalize for
 * realism under the Cosine metric. Seeded for reproducibility.
 */
export function makeRandomUnitVector(dim, seed) {
  const rand = mulberry32(seed);
  const v = new Array(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    // Box–Muller → approx-normal components (a realistic embedding-like distribution).
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    v[i] = g;
    sumSq += g * g;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/**
 * HNSW graph RAM estimate: each point holds ~m bidirectional links on layer 0, stored as
 * uint32 ids (FLOAT32_BYTES = 4). ≈ 128 B/point at m=16. Calibration target — refine against
 * the dry run's measured index overhead.
 */
export function hnswGraphBytes(n, m = DEFAULT_HNSW_M) {
  return n * m * 2 * FLOAT32_BYTES;
}

/**
 * Analytical footprint at corpus size n. RAM = in-RAM float32 vectors + HNSW graph (only above
 * the indexing threshold) + an additive process/base term (0 in the per-collection model).
 * Disk = vectors + payload + index (qdrant persists all three). This is the deliverable; the
 * live run calibrates the constants.
 */
export function projectFootprint({
  n, dim, payloadBytesPerPoint,
  hnswM = DEFAULT_HNSW_M, threshold = DEFAULT_INDEXING_THRESHOLD, baseRamBytes = 0,
}) {
  const vectors = vectorBytes(n, dim);
  const hnsw = indexed(n, threshold) ? hnswGraphBytes(n, hnswM) : 0;
  const payload = n * payloadBytesPerPoint;
  return {
    ramBytes: vectors + hnsw + baseRamBytes,
    diskBytes: vectors + hnsw + payload,
    breakdown: { vectors, hnsw, payload, base: baseRamBytes },
  };
}
