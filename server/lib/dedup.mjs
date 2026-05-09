/**
 * server/lib/dedup.mjs — D1 cross-surface fact dedup hook.
 *
 * Three pure functions + a Set helper, all qdrant-client-injected for testability.
 * Called by umAdd() between embed() and client.upsert() when dedup-eligible
 * (see lib/add.mjs §4.5.1 and spec for the eligibility predicate).
 *
 * Layer contract (spec §4):
 *   1. checkContentHashDedup → existing point or null (exact md5 match under userId)
 *   2. checkEmbeddingDedup   → existing point or null (cosine ≥ threshold under userId)
 *   3. mergeSurface          → setPayload-merge surfaces+projects+dedupCount;
 *                              return DEDUP_MERGED record
 *
 * Failure mode: every qdrant call is wrapped per-call (per spec §4.6 fail-soft).
 * On error: emit um_dedup_total{kind, result:'error', stage} + log warn,
 * then RETHROW so umAdd's caller-wrapping (existing withRetry) sees the error.
 * The fall-through-to-upsert decision lives in add.mjs (caller), not here —
 * this module's contract is "either succeed and return result OR throw".
 *
 * Spec refs: §3.4 (qdrant client surface), §4.1 hash layer, §4.2 embedding layer,
 *            §4.3 mergeSurface schema, §4.6 fail-soft, §9 metrics labels.
 * Plan refs: C.1, C.2, C.3, C.4.
 */

import { umDedupTotal, umDedupCheckDurationSeconds } from './metrics.mjs';
import { getLogger, getRequestLogger } from './logger.mjs';
import { currentRequestId } from './request-context.mjs';

function loggerForRequest() {
  const reqId = currentRequestId();
  return reqId ? getRequestLogger(reqId) : getLogger();
}

/**
 * Per-call instrumentation wrapper. Returns the result of `fn()`; on throw,
 * emits the error metric for `{kind, stage}` and rethrows so the caller can
 * decide whether to fall through (umAdd does).
 */
async function instrumented(kind, stage, fn) {
  const startNs = process.hrtime.bigint();
  try {
    const result = await fn();
    const durSec = Number(process.hrtime.bigint() - startNs) / 1e9;
    try { umDedupCheckDurationSeconds.observe({ kind, stage }, durSec); } catch { /* obs fail-safe */ }
    return result;
  } catch (err) {
    try {
      umDedupTotal.inc({ kind, result: 'error', stage }, 1);
    } catch { /* obs fail-safe */ }
    loggerForRequest().warn(
      { event: 'dedup.error', kind, stage, errorMessage: err?.message },
      `dedup.${kind} ${stage} failed`,
    );
    throw err;
  }
}

/**
 * Layer 1 — exact content-hash dedup (spec §4.1).
 *
 * Returns:
 *   { id, payload } existing point if a point with same userId AND same hash exists; else null.
 *
 * Throws on qdrant transport error; metrics emitted via instrumented(). Caller
 * (umAdd) catches and falls through to plain upsert.
 */
export async function checkContentHashDedup({ client, collection, userId, hash }) {
  if (!client?.scroll) throw new Error('checkContentHashDedup: client.scroll required');
  if (!collection || !userId || !hash) throw new Error('checkContentHashDedup: collection/userId/hash required');

  return instrumented('hash', 'scroll', async () => {
    const res = await client.scroll(collection, {
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          { key: 'hash', match: { value: hash } },
        ],
      },
      limit: 1,
      with_payload: true,
    });
    const points = res?.points ?? [];
    const hit = points.length > 0 ? points[0] : null;
    try {
      umDedupTotal.inc({ kind: 'hash', result: hit ? 'hit' : 'miss', stage: '' }, 1);
    } catch { /* obs fail-safe */ }
    if (hit) {
      loggerForRequest().info(
        { event: 'dedup.hit', kind: 'hash', existingId: hit.id, userId, contentHash: hash },
        'dedup hash hit',
      );
    }
    return hit;
  });
}

/**
 * Layer 2 — embedding-similarity dedup (spec §4.2).
 *
 * Returns:
 *   { id, payload, score } existing point if cosine sim ≥ threshold under same userId; else null.
 *
 * NB: client.search() returns ScoredPoint[] DIRECTLY (per @qdrant/js-client-rest@1.13.0).
 * scroll() returns { points: [...] }. Asymmetry verified at server/test/add-live.test.mjs:99
 * + qdrant openapi schema. (Spec §3.4.)
 */
export async function checkEmbeddingDedup({ client, collection, userId, vector, threshold }) {
  if (!client?.search) throw new Error('checkEmbeddingDedup: client.search required');
  if (!collection || !userId || !Array.isArray(vector) || vector.length === 0) {
    throw new Error('checkEmbeddingDedup: collection/userId/vector required');
  }
  if (typeof threshold !== 'number') throw new Error('checkEmbeddingDedup: threshold (number) required');

  return instrumented('embedding', 'search', async () => {
    const res = await client.search(collection, {
      vector,
      filter: { must: [{ key: 'userId', match: { value: userId } }] },
      limit: 1,
      score_threshold: threshold,
      with_payload: true,
    });
    // ScoredPoint[] direct (NOT { points: [...] })
    const arr = Array.isArray(res) ? res : (res?.points ?? []);
    const hit = arr.length > 0 ? arr[0] : null;
    try {
      umDedupTotal.inc({ kind: 'embedding', result: hit ? 'hit' : 'miss', stage: '' }, 1);
    } catch { /* obs fail-safe */ }
    if (hit) {
      loggerForRequest().info(
        { event: 'dedup.hit', kind: 'embedding', existingId: hit.id, userId, score: hit.score },
        'dedup embedding hit',
      );
    }
    return hit;
  });
}

/**
 * Append-with-uniqueness for Set-typed payload fields.
 * Returns:
 *   - undefined if both existing list and addition are absent (caller omits the field)
 *   - the existing list if addition is falsy (empty/null) and existing is non-empty
 *   - a new array containing the union otherwise
 */
export function mergeSet(existing, addition) {
  const base = Array.isArray(existing) ? existing : [];
  if (!addition) return base.length > 0 ? base : undefined;
  return Array.from(new Set([...base, addition]));
}

/**
 * Layer 3 — surface-of-origin merge (spec §4.3).
 *
 * Updates existing qdrant point's `surfaces` and `projects` Set fields, bumps
 * `dedupCount`, sets `dedupLastSeenAt`. Returns the umAdd result shape with
 * event='DEDUP_MERGED'.
 *
 * NB: setPayload is ADDITIVE on qdrant-side (fields not in payload arg are
 * left unchanged). Do NOT pass empty values intending to clear.
 */
export async function mergeSurface({ client, collection, existingPoint, newSurface, newProject }) {
  if (!client?.setPayload) throw new Error('mergeSurface: client.setPayload required');
  if (!collection || !existingPoint?.id) throw new Error('mergeSurface: collection/existingPoint.id required');

  const existing = existingPoint.payload ?? {};
  const updatedSurfaces = mergeSet(existing.surfaces, newSurface);
  const updatedProjects = mergeSet(existing.projects, newProject);
  const dedupCount = (typeof existing.dedupCount === 'number' ? existing.dedupCount : 1) + 1;
  const dedupLastSeenAt = new Date().toISOString();

  const payloadPatch = {
    ...(updatedSurfaces ? { surfaces: updatedSurfaces } : {}),
    ...(updatedProjects ? { projects: updatedProjects } : {}),
    dedupCount,
    dedupLastSeenAt,
  };

  await instrumented('hash', 'setPayload', async () => {
    await client.setPayload(collection, {
      points: [existingPoint.id],
      payload: payloadPatch,
    });
  });

  return {
    id: existingPoint.id,
    memory: existing.data,
    event: 'DEDUP_MERGED',
  };
}
