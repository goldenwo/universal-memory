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
