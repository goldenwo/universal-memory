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
 * Build the `must` arm for a single partition field (lane or persona).
 * Explicit slug → strict equality. Undefined → `is_empty` matches points
 * where the field is absent (D2 §4.7).
 *
 * D2's `omitEmpty` write pattern guarantees no `null` payload values for
 * lane/persona, so `is_empty` alone covers the absence arm without
 * needing the complementary `is_null` predicate.
 */
function partitionArm(key, value) {
  return value !== undefined
    ? { key, match: { value } }
    : { is_empty: { key } };
}

/**
 * Layer 1 — exact content-hash dedup (spec §4.1; D2 §4.7 cascade).
 *
 * Returns:
 *   { id, payload } existing point if a point with same userId AND same hash
 *   AND same (lane, persona) partition exists; else null.
 *
 * D2 extends the filter with `lane` and `persona` arms so two writes that
 * are textually identical but partitioned differently (e.g. lane=work vs
 * lane=personal) do NOT dedup-merge. Absence is matched via `is_empty` so
 * legacy points (no lane / persona keys) only merge with new writes that
 * also omit those fields — symmetric back-compat.
 *
 * Throws on qdrant transport error; metrics emitted via instrumented(). Caller
 * (umAdd) catches and falls through to plain upsert.
 */
export async function checkContentHashDedup({ client, collection, userId, hash, lane, persona }) {
  if (!client?.scroll) throw new Error('checkContentHashDedup: client.scroll required');
  if (!collection || !userId || !hash) throw new Error('checkContentHashDedup: collection/userId/hash required');

  return instrumented('hash', 'scroll', async () => {
    const res = await client.scroll(collection, {
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          { key: 'hash', match: { value: hash } },
          partitionArm('lane', lane),
          partitionArm('persona', persona),
        ],
        // D3.1 §4.1 — exclude superseded tombstones so a re-assert of a
        // superseded fact creates a fresh point rather than merging into the
        // dead one. Expressed as must_not (not must status==current) so that
        // pre-D3 points with NO status key are correctly treated as current
        // and still match (absence-tolerance invariant).
        must_not: [{ key: 'status', match: { value: 'superseded' } }],
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
export async function checkEmbeddingDedup({ client, collection, userId, vector, threshold, lane, persona }) {
  if (!client?.search) throw new Error('checkEmbeddingDedup: client.search required');
  if (!collection || !userId || !Array.isArray(vector) || vector.length === 0) {
    throw new Error('checkEmbeddingDedup: collection/userId/vector required');
  }
  if (typeof threshold !== 'number') throw new Error('checkEmbeddingDedup: threshold (number) required');

  return instrumented('embedding', 'search', async () => {
    // D2 §4.7 cascade — extends the must filter with lane + persona arms
    // (NO hash arm — Layer 2 is the near-similar path; hash equality would
    // defeat its purpose). Absence arm via is_empty per the same rationale
    // as Layer 1.
    const res = await client.search(collection, {
      vector,
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          partitionArm('lane', lane),
          partitionArm('persona', persona),
        ],
        // D3.1 §4.2 — same superseded-exclusion as Layer 1. must_not so that
        // pre-D3 points without a status key are still valid dedup candidates
        // (absence-tolerance invariant: must_not superseded ≠ must current).
        must_not: [{ key: 'status', match: { value: 'superseded' } }],
      },
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
 * D3.2 — Read-side K-nearest-current-candidates primitive.
 *
 * Returns the top-K current (non-superseded) points in the given
 * lane/persona partition that score ≥ threshold against `vector`.
 * Pure read — no mutations.
 *
 * Shape: ScoredPoint[] where each element is { id, payload, score, ... }.
 * Empty array if no candidates qualify.
 *
 * Mirrors checkEmbeddingDedup's filter exactly:
 *   - same partitionArm(lane) + partitionArm(persona) must arms
 *   - same must_not status==superseded exclusion (absence-tolerant)
 *   - same score_threshold + with_payload options
 * Differences: `limit` param (default 10); returns the ARRAY (not a single
 * dedup decision).
 *
 * Spec refs: D3.2 Task 2.1; D3.1 §4.1/§4.2 absence-tolerance invariant.
 */
export async function findEmbeddingSimilarCandidates({
  client,
  collection,
  userId,
  vector,
  threshold,
  lane,
  persona,
  limit = 10,
}) {
  if (!client?.search) throw new Error('findEmbeddingSimilarCandidates: client.search required');
  if (!collection || !userId || !Array.isArray(vector) || vector.length === 0) {
    throw new Error('findEmbeddingSimilarCandidates: collection/userId/vector required');
  }
  if (typeof threshold !== 'number') throw new Error('findEmbeddingSimilarCandidates: threshold (number) required');

  return instrumented('embedding', 'search', async () => {
    const res = await client.search(collection, {
      vector,
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          partitionArm('lane', lane),
          partitionArm('persona', persona),
        ],
        // D3.1 absence-tolerance invariant: must_not superseded (not must current)
        // so pre-D3 points with NO status key are still returned as candidates.
        must_not: [{ key: 'status', match: { value: 'superseded' } }],
      },
      limit,
      score_threshold: threshold,
      with_payload: true,
    });
    // ScoredPoint[] direct (NOT { points: [...] }) per @qdrant/js-client-rest@1.13.0.
    return Array.isArray(res) ? res : (res?.points ?? []);
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

  // Keep-older: the surviving record is the EXISTING point's text; the incoming
  // text is dropped (no provenance is retained). For phrasing-similar CONTRADICTIONS
  // in the [0.84, 0.87] cosine overlap band this pre-empts D3 auto-supersession
  // (which would instead keep the NEWER fact, by demoting the older point) — a
  // known, accepted interaction while D3 is inert. Do NOT
  // change this polarity in isolation; the reconciliation is a Gap-5 dependency.
  // See docs/decisions/0007-d1-dedup-vs-d3-supersession-interaction.md.
  return {
    id: existingPoint.id,
    memory: existing.data,
    event: 'DEDUP_MERGED',
  };
}
