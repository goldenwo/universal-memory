// server/lib/reaction-attach.mjs — #201 late-arrival attach path: a platform
// reaction (arriving minutes/hours after capture) finds and annotates the
// memory its exchange produced.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record, per the reaction-signal.mjs convention):
//
// • PIPELINE ORDER: resolve → upsert reaction_state (LEDGER FIRST — ground
//   truth commits before any qdrant write) → supersession-follow + UNIVERSAL
//   attachment recording → point-level aggregate recompute → normalized
//   payload projection. The counter emit keys on the ledger transition
//   ('created'), so a total payload-write failure still emits exactly once
//   and a retry ('updated') never re-emits.
//
// • POINT-LEVEL AGGREGATE (anti-clobber): the payload value is always
//   aggregateForPoint(terminal) — the distinct-capture sum — never the
//   calling capture's own numbers. Two exchanges dedup-merged or
//   supersession-funneled onto one point ACCUMULATE; last-writer-wins
//   clobbering is structurally impossible.
//
// • UNIVERSAL ATTACHMENT RECORDING: every processed point ref upserts its
//   (capture, requested) → terminal row — terminal = requested for current
//   points (the common dedup-survivor case). Without this, aggregateForPoint
//   would never see non-superseded refs.
//
// • REINDEX RESILIENCE: a dangling recorded id re-resolves by (userId, hash)
//   payload match — the `hash` payload index in collection-init.mjs backs it —
//   and the found id is PERSISTED back into point_refs so the fallback fires
//   once per reindex, not on every attach. Payload annotations lost in a
//   reindex are restored by the next attach (self-healing from the ledger).
//
// • FLOOR-1 IS PROJECTION-ONLY: a zero aggregate (full removal) skips the
//   payload write — normalizeReactionMetadata drops count < 1 and merge
//   writes cannot delete keys — the payload keeps its last ≥1 value while
//   the ledger records the truth. Recorded contract-v1 limitation.
//
// • FAILURE CONTRACT: this module throws only on LEDGER failure (the route
//   maps that to a retryable 5xx). Per-point qdrant failures are counted in
//   `failed` — the route returns 502 when annotated === 0 && failed > 0,
//   200 otherwise; every attach recomputes all its targets, so partial
//   failures heal on the next call.

import { recordCaptureEvent } from './capture-events.mjs';
import {
  resolveCapture,
  upsertReactionState,
  recordAttachment,
  aggregateForPoint,
  updatePointRef,
  reactionSkewMs,
} from './capture-ledger.mjs';
import {
  normalizeReactionMetadata,
  SIGNAL_EVENTS,
  REACTION_TYPES_MAX_ENTRIES,
  REACTION_TYPE_MAX_CHARS,
} from './reaction-signal.mjs';
import { umReactionRefinerDisagreementTotal } from './metrics.mjs';
import { errorResponse } from './error-envelope.mjs';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';

const MAX_SUPERSEDE_HOPS = 8;

/**
 * Re-resolve a dangling point id by (userId, hash) payload match — reindex
 * re-mints ids but data/hash persist. Returns the found point or null.
 */
async function reResolveByHash({ client, collection, userId, hash }) {
  const res = await client.scroll(collection, {
    filter: {
      must: [
        { key: 'userId', match: { value: userId } },
        { key: 'hash', match: { value: hash } },
      ],
    },
    limit: 2,
    with_payload: true,
  });
  return res?.points?.[0] ?? null;
}

/**
 * Follow a supersession chain to the terminal CURRENT point.
 * @returns {object|null} terminal point, or null on dead end / cycle / hop cap
 */
async function followChain({ client, collection, start, byId }) {
  let point = start;
  const seen = new Set();
  for (let hop = 0; hop < MAX_SUPERSEDE_HOPS; hop++) {
    if (point?.payload?.status !== 'superseded') return point;
    const nextId = point.payload.supersededBy;
    if (!nextId || seen.has(nextId)) return null;
    seen.add(nextId);
    let next = byId.get(nextId);
    if (!next) {
      const fetched = await client.retrieve(collection, { ids: [nextId], with_payload: true });
      next = fetched?.[0] ?? null;
      if (next) byId.set(next.id, next);
    }
    if (!next) return null;
    point = next;
  }
  return null;
}

/**
 * Attach a late-arriving reaction to the memory its exchange produced.
 *
 * @param {object} a
 * @param {string} a.userId        - operator id (route-bound; never client-supplied)
 * @param {string} a.runId         - opaque channel/session key
 * @param {string} a.messageTs     - ISO timestamp of the reacted message
 * @param {string} a.messageId     - opaque platform message id
 * @param {string} [a.messageHash] - optional md5 refiner
 * @param {number} a.count         - ABSOLUTE current reaction count (≥ 0)
 * @param {string[]} [a.types]     - reaction type labels
 * @param {object} a.client        - qdrant client (retrieve/scroll/setPayload)
 * @param {string} a.collection
 * @param {string} a.fallbackSurface - counter surface for unaddressed emits
 * @returns {Promise<{outcome: string, reason?: string, pointIds: string[], annotated: number, failed: number}>}
 */
export async function attachReaction({
  userId, runId, messageTs, messageId, messageHash, count, types,
  client, collection, fallbackSurface,
} = {}) {
  const row = resolveCapture({ userId, runId, messageTs, messageHash });
  if (!row) {
    // Per-call by necessity — no state row exists to key a transition
    // (bounded by the producer's capped backoff; see reaction-signal.mjs
    // vocabulary docstring).
    recordCaptureEvent({
      surface: fallbackSurface,
      event: SIGNAL_EVENTS.REACTION,
      outcome: 'unaddressed',
    });
    return { outcome: 'unaddressed', reason: 'no_capture', pointIds: [], annotated: 0, failed: 0 };
  }

  if (row.refinerDisagreed) {
    try { umReactionRefinerDisagreementTotal.inc(); } catch { /* obs fail-safe */ }
    safeLog(() => getLogger().info({
      component: 'reaction-attach',
      capture_id: row.captureId,
      run_id: runId,
    }, 'message-hash refiner overrode the forward-earliest resolution pick'), 'log:reaction-attach:refiner');
  }

  const transition = upsertReactionState({ captureId: row.captureId, messageId, count, types });
  if (transition === 'cap_exceeded') {
    return {
      outcome: 'cap_exceeded',
      reason: 'messages_per_capture_cap',
      captureId: row.captureId,
      pointIds: [],
      annotated: 0,
      failed: 0,
    };
  }
  if (transition === 'created') {
    recordCaptureEvent({
      surface: row.surface,
      project: row.project ?? undefined,
      event: SIGNAL_EVENTS.REACTION,
      outcome: row.verdict,
    });
  }

  // Batched fetch of every recorded ref (one round-trip); per-point failures
  // from here on are counted, never thrown.
  const refs = row.pointRefs ?? [];
  const byId = new Map();
  let failed = 0;
  if (refs.length > 0) {
    try {
      const fetched = await client.retrieve(collection, {
        ids: refs.map((r) => r.id),
        with_payload: true,
      });
      for (const p of fetched ?? []) byId.set(p.id, p);
    } catch {
      failed += refs.length;
      return { outcome: row.verdict, pointIds: [], annotated: 0, failed };
    }
  }

  const terminals = [];
  const terminalSeen = new Set();
  for (const ref of refs) {
    let point = byId.get(ref.id) ?? null;
    if (!point && ref.hash) {
      try {
        point = await reResolveByHash({ client, collection, userId, hash: ref.hash });
      } catch { point = null; }
      if (point) {
        byId.set(point.id, point);
        updatePointRef({ captureId: row.captureId, oldPointId: ref.id, newPointId: point.id });
      }
    }
    if (!point) continue;
    let terminal;
    try {
      terminal = await followChain({ client, collection, start: point, byId });
    } catch { terminal = null; }
    if (!terminal) continue;
    recordAttachment({
      captureId: row.captureId,
      requestedPointId: ref.id,
      terminalPointId: terminal.id,
    });
    if (!terminalSeen.has(terminal.id)) {
      terminalSeen.add(terminal.id);
      terminals.push(terminal.id);
    }
  }

  if (refs.length > 0 && terminals.length === 0) {
    // Resolution succeeded (the verdict emit above stands) but nothing
    // survives to annotate — dead chains / deleted points.
    return { outcome: 'unaddressed', reason: 'no_surviving_point', pointIds: [], annotated: 0, failed };
  }

  let annotated = 0;
  for (const terminalId of terminals) {
    const agg = aggregateForPoint(terminalId);
    const md = normalizeReactionMetadata({
      reaction_count: agg.count,
      reaction_types: agg.types,
    });
    // Floor-1 projection: a zero aggregate normalizes to no fields — skip.
    if (!Number.isInteger(md.reaction_count)) continue;
    try {
      await client.setPayload(collection, {
        points: [terminalId],
        payload: {
          reaction_count: md.reaction_count,
          ...(md.reaction_types !== undefined ? { reaction_types: md.reaction_types } : {}),
        },
      });
      annotated += 1;
    } catch {
      failed += 1;
    }
  }

  return { outcome: row.verdict, pointIds: terminals, annotated, failed };
}

// ---------------------------------------------------------------------------
// HTTP handler — POST /api/reaction (route block in mem0-mcp-http.mjs is a
// thin JSON-parse + delegate; the wire contract lives HERE and in
// openapi.mjs's pathReaction()).
//
// • VALIDATION: 400 only for caller-malformed input. A future-beyond-skew
//   message_ts is an OUTCOME (`unaddressed` + reason "ts_future"), not a 400 —
//   a Pi boot before NTP sync puts the server clock behind real time; an
//   outcome the producer retries self-heals post-sync, a 400 would silently
//   drop the boot window's reactions. Old timestamps always pass through
//   (reacted ledger rows are retained indefinitely).
// • STATUS MAPPING: cap_exceeded → 400 naming the knob; resolution succeeded
//   but ZERO payload writes landed → 502 UPSTREAM_FAILURE (retryable — the
//   ledger mutation stands and the retry is idempotent); any ledger/attach
//   throw → 502 (same retry contract). Partial success is a 200 with
//   annotated/failed counts.
// ---------------------------------------------------------------------------

function validationError(message) {
  return { message };
}

function validateReactionBody(body) {
  const b = body ?? {};
  if (typeof b.run_id !== 'string' || b.run_id.length === 0 || b.run_id.length > 256) {
    return validationError('run_id is required (string, 1-256 chars)');
  }
  if (typeof b.message_id !== 'string' || b.message_id.length === 0 || b.message_id.length > 128) {
    return validationError('message_id is required (string, 1-128 chars)');
  }
  if (typeof b.message_ts !== 'string' || !Number.isFinite(Date.parse(b.message_ts))) {
    return validationError('message_ts is required (ISO-8601 timestamp)');
  }
  if (!Number.isInteger(b.reaction_count) || b.reaction_count < 0) {
    return validationError('reaction_count is required (integer >= 0; 0 = full removal)');
  }
  if (b.reaction_types !== undefined && !Array.isArray(b.reaction_types)) {
    return validationError('reaction_types must be an array of strings when present');
  }
  if (b.message_hash !== undefined && (typeof b.message_hash !== 'string' || b.message_hash.length > 64)) {
    return validationError('message_hash must be a string (<= 64 chars) when present');
  }
  return null;
}

export async function handleReactionRequest(req, res, ctx) {
  const b = req.body ?? {};
  const invalid = validateReactionBody(b);
  if (invalid) {
    res.status(400).json(errorResponse('INPUT_INVALID', invalid.message));
    return;
  }

  // ts_future posture (see header) — checked before any ledger work.
  if (Date.parse(b.message_ts) > Date.now() + reactionSkewMs()) {
    recordCaptureEvent({
      surface: ctx.surface,
      event: SIGNAL_EVENTS.REACTION,
      outcome: 'unaddressed',
    });
    res.status(200).json({
      ok: true, outcome: 'unaddressed', reason: 'ts_future', point_ids: [], annotated: 0, failed: 0,
    });
    return;
  }

  // Types trimmed normalizer-style (silent, same bounds) — the ledger stores
  // what the producer meant; the payload projection re-normalizes anyway.
  const types = (b.reaction_types ?? [])
    .filter((t) => typeof t === 'string')
    .map((t) => t.slice(0, REACTION_TYPE_MAX_CHARS))
    .slice(0, REACTION_TYPES_MAX_ENTRIES);

  let result;
  try {
    result = await attachReaction({
      userId: ctx.userId,
      runId: b.run_id,
      messageTs: b.message_ts,
      messageId: b.message_id,
      messageHash: b.message_hash,
      count: b.reaction_count,
      types,
      client: ctx.client,
      collection: ctx.collection,
      fallbackSurface: ctx.surface,
    });
  } catch (err) {
    safeLog(() => getLogger().error({
      component: 'reaction-attach',
      endpoint: '/api/reaction',
      err_message: err?.message,
    }, 'handleReactionRequest upstream failure'), 'log:reaction-attach:handler-error');
    res.status(502).json(errorResponse(
      'UPSTREAM_FAILURE',
      'reaction could not be recorded; safe to retry',
    ));
    return;
  }

  if (result.outcome === 'cap_exceeded') {
    res.status(400).json(errorResponse(
      'INPUT_INVALID',
      `distinct reacted messages for capture ${result.captureId} exceed the UM_REACTION_MESSAGES_PER_CAPTURE cap`,
    ));
    return;
  }
  if (result.annotated === 0 && result.failed > 0) {
    res.status(502).json(errorResponse(
      'UPSTREAM_FAILURE',
      'reaction recorded in the ledger but no point annotation succeeded; safe to retry',
    ));
    return;
  }
  res.status(200).json({
    ok: true,
    outcome: result.outcome,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    point_ids: result.pointIds,
    annotated: result.annotated,
    failed: result.failed,
  });
}
