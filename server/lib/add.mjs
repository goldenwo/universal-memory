/**
 * server/lib/add.mjs — umAdd() orchestrator: replaces mem0.add() in production.
 *
 * Pipeline (spec §4.3):
 *   1. infer:true  → facts(text)  → string[]; one embed() per fact; one qdrant upsert per fact.
 *   2. infer:false → embed(text)  → one vector; one qdrant upsert.
 *   3. Each call goes through embed/facts orchestrators which emit
 *      um_provider_* metrics with surface=embed / surface=facts.
 *
 * D1 cross-surface dedup hook (2026-05-09 spec §4 + plan D.1/D.2/D.3):
 *   - Reserved-field guard: assertNoReservedFields runs at entry, OUTSIDE
 *     withRequestContext, so caller-input errors don't acquire a request-id
 *     child logger context.
 *   - Eligibility: dedup runs UNLESS UM_DEDUP_ENABLED='false' (default ON
 *     since v1.1 flag-flip; opt-out only) AND not a system doc AND
 *     _systemMigration !== true. Independent of `infer` per DP6/DP7 —
 *     vault docs (infer:false) CAN duplicate cross-surface and SHOULD merge.
 *   - Per dedup-eligible item: Layer 1 (hash) → Layer 2 (embedding); on hit,
 *     mergeSurface and emit DEDUP_MERGED event instead of upsert.
 *   - Gap-5 P3 (ADR-0007 Option C): a Layer-2 embedding hit that is
 *     supersede-eligible (autosupersede on + partitioned) AND in the
 *     contradiction-overlap band is judged inline; a confirmed contradiction
 *     DEFERS the keep-older merge — the newer fact is upserted as its own
 *     status:current point and the older point is demoted afterwards
 *     (SUPERSEDED_INBAND). Hash hits are exact text → never judged.
 *   - Fail-soft on dedup query error: log+metric, fall through to plain upsert.
 *   - Point-ID: dedup-eligible writes use uuidv5(`${itemHash}:${userId}${suffix}`,
 *     NAMESPACE_UM) for TOCTOU-resistant deterministic IDs. Suffix is empty when
 *     both lane and persona are unset (D2 back-compat — reduces to the legacy
 *     `${hash}:${userId}` shape so pre-D2 dedup-eligible IDs are preserved);
 *     else `:${lane||''}:${persona||''}` so per-(lane, persona) partitions
 *     collide on writes independently. Non-dedup writes use randomUUID().
 *
 * Return shape mirrors mem0's add():
 *   { results: [{ id, memory, event: 'ADD' | 'DEDUP_MERGED' | 'SUPERSEDED_INBAND' }, ...] }
 *   SUPERSEDED_INBAND (Gap-5 P3) additionally carries `supersededId` (the demoted older point).
 *
 * Qdrant payload schema (LOAD-BEARING — see spec §4.3, §9 risk row 1):
 *   - camelCase userId, createdAt
 *   - metadata fields FLATTENED to top level (no sub-object)
 *   - getAll/search via mem0 must continue to find these writes
 *   - D1 additions: surfaces[], projects[], dedupCount, dedupVersion, dedupLastSeenAt
 *
 * The Qdrant client is injected via `_qdrantClient` (test seam) or
 * constructed at call time from the memory's host/port config.
 *
 * Errors propagate raw to the caller (no internal withRetry wrap). Production
 * callers (server/mem0-mcp-http.mjs) wrap umAdd() in withRetry({op:'add'})
 * which surfaces UPSTREAM_FAILURE on exhaustion (§5.2 prefix-class). cli/reindex.mjs
 * Phase 3 has its own retry+checkpoint mechanics. Wrapping qdrant calls inside
 * umAdd as well would multiply attempts (4 outer × 4 inner = 16) and
 * double-emit um_mem0_ops_total{op:'add', status:'fail'} per persistent failure.
 */

import { randomUUID, createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { facts as factsOrchestrator } from './facts.mjs';
import { embed as embedOrchestrator } from './embed.mjs';
import { withRequestContext, currentRequestId } from './request-context.mjs';
import { umFactsExtractedTotal, umInbandSupersedeTotal } from './metrics.mjs';
import { getLogger, getRequestLogger } from './logger.mjs';
import { isSystemDoc } from './system-docs.mjs';
import { assertNoReservedFields, NAMESPACE_UM } from './dedup-constants.mjs';
import { checkContentHashDedup, checkEmbeddingDedup, mergeSurface } from './dedup.mjs';
import { validateLanePersonaSlug } from './default-project.mjs';
import { getRealClient } from './qdrant-client-resolver.mjs';
import { classifyLane as defaultClassifyLane, classifierEnabled as defaultClassifierEnabled } from './lane-classifier.mjs';
import { isAutoSupersedeEnabled, evaluateInBandSupersession, supersedePoint } from './supersede.mjs';

function md5(s) { return createHash('md5').update(s).digest('hex'); }

/**
 * Compute the deterministic uuidv5 point-ID for a dedup-eligible fact write.
 *
 * Encapsulates the `itemHash + seedSuffix + uuidv5(..., NAMESPACE_UM)` derivation
 * that umAdd uses on the plain-upsert path (lines ~261-266) so external consumers
 * (e.g. the D3.2 batch detector's `supersededBy` field) use exactly the same
 * canonical id formula — prevents silent id drift between writer and detector.
 *
 * Contract: only the dedup-eligible branch. When lane/persona are both absent
 * the suffix is '', reducing to the legacy `${hash}:${userId}` seed so pre-D2
 * IDs are preserved. When either is set, suffix is `:${lane||''}:${persona||''}`.
 *
 * @param {{ userId: string, text: string, lane?: string, persona?: string }} opts
 * @returns {string} uuidv5-derived point ID
 */
export function computeFactId({ userId, text, lane, persona }) {
  const itemHash = md5(text);
  const seedSuffix =
    lane !== undefined || persona !== undefined
      ? `:${lane ?? ''}:${persona ?? ''}`
      : '';
  return uuidv5(`${itemHash}:${userId}${seedSuffix}`, NAMESPACE_UM);
}

function buildPayload({ userId, text, metadata, surface, lane, persona }) {
  // Capture metadata.project BEFORE the flatten-spread so we can ALSO seed
  // the `projects` Set field. Both forms (scalar + Set) coexist for backward
  // compat — existing project-scoped readers use the scalar; new readers
  // prefer the Set (D1 spec §4.4, DP2 Option C).
  //
  // D2 §4.1: `metadata` arg here is ALREADY-CLEANED — umAdd's entry strips
  // `lane` and `persona` out of the caller's metadata before invoking
  // buildPayload, then passes the validated values via explicit lane/persona
  // params. The conditional spread below adds them back ONLY when set, so
  // caller `metadata: { lane: null }` produces a payload with NO `lane` key
  // (locks the anti-goal "Omitted lane/persona are stored as absent payload
  // keys, not null/empty/default").
  const projectScalar = metadata?.project;
  const surfaces = surface ? [surface] : undefined;
  const projects = projectScalar ? [projectScalar] : undefined;
  return {
    ...metadata,                       // FLATTENED (mem0 convention) — load-bearing
    userId,                            // CAMELCASE — mem0's createFilter uses raw key
    data: text,
    hash: md5(text),
    createdAt: new Date().toISOString(),  // CAMELCASE — match mem0
    ...(lane !== undefined ? { lane } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(surfaces ? { surfaces } : {}),
    ...(projects ? { projects } : {}),
    dedupCount: 1,
    dedupVersion: 1,
    status: 'current',
  };
}

/**
 * Compute dedup-eligibility per spec §4.5.1 step 2.
 * Independent of `infer` — see DP6/DP7 in spec.
 */
function computeDedupEligible({ metadata, _systemMigration }) {
  // Default ON since v1.1 flag-flip (PR #76 landed the empirical τ=0.84 default;
  // this PR flips the runtime gate from opt-in to opt-out). Setting
  // UM_DEDUP_ENABLED='false' is the only way to disable; any other value
  // (including unset, '', 'true', '1') keeps dedup ON.
  if (process.env.UM_DEDUP_ENABLED?.trim() === 'false') return false;
  if (isSystemDoc({ metadata })) return false;
  if (_systemMigration === true) return false;
  return true;
}

function dedupEmbeddingThreshold() {
  const raw = process.env.UM_DEDUP_EMBEDDING_THRESHOLD;
  const n = Number.parseFloat(raw);
  // Default 0.84 derived from a 50-pair labeled eval against text-embedding-3-small
  // (F_0.5=0.77 at τ=0.84, plateau midpoint of 8-τ band where precision saturates
  // at 1.0). See docs/architecture/dedup.md. Keep in lockstep with
  // server/.env.example UM_DEDUP_EMBEDDING_THRESHOLD and the T2 assertion in
  // server/test/dedup.test.mjs.
  return Number.isFinite(n) ? n : 0.84;
}

export async function umAdd({
  memory,
  text,
  userId,
  metadata = {},
  infer = true,
  surface,                  // D1: caller-provided surface label (e.g., 'claude-code', 'mcp')
  _systemMigration,         // D1: server-internal seam — bulk-import / reindex bypass
  // T12 seams:
  _factsProviderOverride,
  _embedProviderOverride,
  _qdrantClient,
  metrics,
  // T15 seams:
  _factsCounter,
  _logger,
  // Gap-5 P1 seams:
  _classifyLane,
  _laneClassifierEnabled,
  // Gap-5 P3 seams (ADR-0007 Option C):
  _judgeContradiction,
  _supersedePoint,
  _autoSupersedeEnabled,
} = {}) {
  if (!memory?.config?.vectorStore?.config?.collectionName) {
    throw new Error('umAdd: memory.config.vectorStore.config.collectionName required');
  }
  if (!userId) throw new Error('umAdd: userId required');
  if (typeof text !== 'string' || text.length === 0) throw new Error('umAdd: text required');

  // D1 §4.5.1 step 1 — reserved-field guard.
  // Runs OUTSIDE withRequestContext (line below) so caller-input errors don't
  // acquire a request-id child logger context — they're the caller's bug, not
  // a downstream-system error class.
  // trustedServerPath:true on the _systemMigration path exempts the 3 D3.1-managed
  // supersession-state fields (status/supersededBy/supersededAt) so vault-authored
  // docs carrying frontmatter `status:` survive reindex (spec §2 / §3.2 fix).
  assertNoReservedFields(metadata, { trustedServerPath: _systemMigration === true });

  // D2 §4.1 — stage out + validate lane/persona BEFORE any side effect so the
  // metadata-spread in buildPayload doesn't leak null/undefined values into
  // the payload. Validation throws INPUT_INVALID-enveloped errors per spec
  // R5 ("both must validate before either is persisted"). Same caller-input
  // error class as assertNoReservedFields — runs OUTSIDE withRequestContext.
  const {
    lane: _rawLane,
    persona: _rawPersona,
    ...metadataMinusLanePersona
  } = metadata;
  const lane = validateLanePersonaSlug({ value: _rawLane, fieldName: 'lane' });
  const persona = validateLanePersonaSlug({ value: _rawPersona, fieldName: 'persona' });

  const collection = memory.config.vectorStore.config.collectionName;
  const factsCounter = _factsCounter ?? umFactsExtractedTotal;
  // Bind request_id (from outer ALS store) into the logger child so the
  // facts.empty INFO line carries the trigger context. The project's pino
  // config has no global ALS mixin (logger.mjs:113-126) — operators
  // searching by request_id won't find this line otherwise.
  const reqId = currentRequestId();
  const logger = _logger ?? (reqId ? getRequestLogger(reqId) : getLogger());

  // D1 §4.5.1 step 2 — dedup-eligibility short-circuit. Computed once per
  // umAdd call; applies uniformly to all extracted facts (or the single
  // raw-text item when infer:false).
  const dedupEligible = computeDedupEligible({ metadata, _systemMigration });
  const dedupThreshold = dedupEligible ? dedupEmbeddingThreshold() : null;

  // Gap-5 P1: lane-classifier seam (resolved once per call).
  // classifierEngaged = the operator opted IN. Three-state model (spec §3.6,
  // user decision 2026-06-04): env-flag UNSET → fully inert (no classify, no
  // centroid build — the P1 safe default + keeps pre-Gap-5 call sites/tests
  // untouched); flag set but not 'true' → SHADOW; flag 'true' → ACTIVE. A test
  // seam (_classifyLane / _laneClassifierEnabled) also engages the pipeline.
  // NB P4 flip: when the default flips to opt-out this gate must flip in
  // lockstep with classifierEnabled (engaged unless flag === 'false') — see
  // plan P4/T4.1.
  const classifyLaneFn = _classifyLane ?? defaultClassifyLane;
  const laneClassifierEnabled = _laneClassifierEnabled ?? defaultClassifierEnabled();
  const classifierEngaged =
    _classifyLane !== undefined ||
    _laneClassifierEnabled !== undefined ||
    process.env.UM_LANE_CLASSIFIER_ENABLED !== undefined;
  const classifySkip = _systemMigration === true || isSystemDoc({ metadata });

  // Gap-5 P3: write-time in-band supersession seam (ADR-0007 Option C), resolved
  // once per call. The inline judge is left to evaluateInBandSupersession's own
  // default (judgeContradiction) unless a test injects _judgeContradiction.
  const autoSupersedeEnabled = _autoSupersedeEnabled ?? isAutoSupersedeEnabled();
  const supersedeFn = _supersedePoint ?? supersedePoint;

  return withRequestContext({ id: currentRequestId(), userId, collection, infer }, async () => {
    let items;
    if (infer) {
      const factsResult = await factsOrchestrator(text, { _providerOverride: _factsProviderOverride, metrics });
      const extractedFacts = factsResult.facts ?? [];
      factsCounter.inc(
        { provider: factsResult.provider, model: factsResult.model },
        extractedFacts.length,
      );
      if (extractedFacts.length === 0) {
        logger.info({ event: 'facts.empty', userId, collection, textLength: text.length }, 'umAdd: facts() extracted zero');
      }
      items = extractedFacts;
    } else {
      items = [text];
    }

    if (items.length === 0) return { results: [] };

    // Hoist client construction OUT of the per-item loop. infer:true with N
    // extracted facts would otherwise allocate N QdrantClient transports
    // (round-1 PR review Minor #1).
    const client = _qdrantClient ?? await getRealClient(memory);

    const results = [];
    for (const item of items) {
      const { vector } = await embedOrchestrator(item, { _providerOverride: _embedProviderOverride, metrics });

      // Gap-5 P1: per-fact lane auto-classification. Reuses `vector` (no re-embed of
      // the fact); caller-supplied `lane` wins; fail-safe (never fails the write).
      // Engaged only when classifierEngaged (operator opted in): ACTIVE (flag 'true')
      // writes the classified lane; SHADOW (flag set, not 'true') logs the would-be
      // lane without writing. The centroid build threads the SAME embed seam as the
      // fact (same vector space in prod; hermetic under the test embed override).
      let itemLane = lane;
      if (classifierEngaged && itemLane === undefined && !classifySkip) {
        try {
          const { lane: classified, score } = await classifyLaneFn(vector, {
            _logger: logger,
            _embedFn: (t) => embedOrchestrator(t, { _providerOverride: _embedProviderOverride, metrics }),
          });
          if (laneClassifierEnabled) {
            // `null` = classifier's "leave unpartitioned" — normalize to `undefined`
            // so the four sinks treat it as ABSENT (no `lane:null` payload key, the
            // `is_empty` dedup arm, and the legacy point-ID shape). Persisting
            // `lane:null` would break the no-null-payload invariant + dedup + ID determinism.
            itemLane = classified ?? undefined;                                        // active: apply (null→absent)
          } else {
            logger.info({ event: 'lane.shadow', wouldBe: classified ?? null, score }, 'lane classifier shadow'); // observe-only
          }
        } catch (err) {
          // Defense-in-depth: classifyLane is contract-fail-safe, but a classifier
          // fault must NEVER fail the user's write (spec §3.4). Leave itemLane = lane.
          logger.warn({ event: 'lane.classify_seam_error', err: err?.message }, 'lane classify seam error; writing unpartitioned');
        }
      }

      const itemHash = md5(item);
      const itemProject = metadata?.project;

      // D1 dedup hook — Layer 1 (hash) → Layer 2 (embedding). Only runs
      // when dedup-eligible (flag on, not system-doc, not migration).
      // Fail-soft: any dedup-query error logs+metrics inside dedup.mjs's
      // instrumented() wrapper and rethrows; we catch here and fall through
      // to plain upsert per spec §4.6.
      // Gap-5 P3 (ADR-0007 Option C): set iff a supersede-eligible in-band
      // contradiction defers the keep-older merge — the older point id to demote
      // AFTER the newer fact is upserted as status:current below.
      let supersedeOlderId;
      if (dedupEligible) {
        try {
          let hit = await checkContentHashDedup({
            client, collection, userId, hash: itemHash, lane: itemLane, persona,
          });
          // Only a Layer-2 EMBEDDING hit is eligible for in-band supersession: a
          // Layer-1 hash hit is exact text (a true duplicate), never a contradiction.
          let embeddingHit = null;
          if (!hit) {
            embeddingHit = await checkEmbeddingDedup({
              client, collection, userId, vector, threshold: dedupThreshold, lane: itemLane, persona,
            });
            hit = embeddingHit;
          }
          if (hit) {
            // ADR-0007 Option C: a phrasing-similar contradiction can land in the
            // embedding-dedup band. Decide inline whether to DEFER to supersession.
            // The judge fires only for the supersede-eligible in-band slice.
            const decision = embeddingHit
              ? await evaluateInBandSupersession({
                  score: embeddingHit.score,
                  olderText: embeddingHit.payload?.data,
                  newerText: item,
                  lane: itemLane,
                  persona,
                  bandFloor: dedupThreshold,
                  enabled: autoSupersedeEnabled,
                  _judge: _judgeContradiction,
                })
              : { supersede: false, judged: false };
            if (decision.supersede) {
              // Defer the keep-older merge: fall through to upsert the newer fact
              // as its own status:current point; demote the older one post-upsert.
              supersedeOlderId = embeddingHit.id;
            } else {
              if (decision.judged) {
                // Judge was consulted (eligible+in-band) but declined → keep-older.
                try { umInbandSupersedeTotal.inc({ outcome: 'declined' }); } catch { /* obs fail-safe */ }
              }
              const merged = await mergeSurface({
                client, collection, existingPoint: hit, newSurface: surface, newProject: itemProject,
              });
              results.push(merged);
              continue;  // skip upsert — dedup-merge took its place
            }
          }
        } catch (err) {
          // Already logged + metric'd inside dedup.mjs; fall through to upsert.
          // Bound the per-item error count via the existing instrumented() metric.
          // (no rethrow — fail-soft per spec §4.6)
        }
      }

      // Plain upsert path. Point-ID: deterministic uuidv5 if dedup-eligible
      // (TOCTOU-resistant per DP8 / R3), else randomUUID for legacy parity.
      // NB: hash FIRST then ':' then userId. md5 is always 32 hex chars
      // [0-9a-f], so the partition is unambiguous regardless of userId chars
      // (e.g., a userId containing ':' cannot produce a collision because the
      // hash prefix is always exactly 32 hex chars, never overlapping with the
      // userId tail). Closes security-review H1 (forward-compat for any
      // future multi-tenant deployment that may permit ':' in userId).
      //
      // D2 §4.7: extend the seed with `:${lane||''}:${persona||''}` ONLY when
      // at least one of those fields is set, so writes with neither field
      // reduce to the legacy `${hash}:${userId}` shape (preserves dedup-
      // eligible IDs for pre-D2 points). Concurrent identical writes with
      // distinct (lane, persona) values get distinct point IDs — the partition
      // collides on write per-tuple.
      const id = dedupEligible
        ? computeFactId({ userId, text: item, lane: itemLane, persona })
        : randomUUID();
      const point = {
        id,
        vector,
        payload: buildPayload({
          userId,
          text: item,
          metadata: metadataMinusLanePersona,
          surface,
          lane: itemLane,
          persona,
        }),
      };
      // Errors propagate raw — outer call sites (mem0-mcp-http) wrap in
      // withRetry({op:'add'}); reindex Phase 3 wraps via runPhase3Rebuild's
      // own retry+checkpoint mechanics (Adv-4 spec).
      await client.upsert(collection, { points: [point] });

      // Gap-5 P3 (ADR-0007 Option C): the newer fact is now persisted as
      // status:current (the load-bearing invariant). If Option C fired, demote the
      // older contradicted point — AFTER the upsert, so a crash in between leaves
      // TWO current points (the accepted D1 keep-both trade-off), never the
      // "no current fact" recall-loss. Fail-soft: a demotion error must NOT fail
      // the user's write (the newer is already current); the session-end detector
      // can still demote the older point on a later run.
      if (supersedeOlderId) {
        try {
          await supersedeFn({ client, collection, id: supersedeOlderId, supersededBy: id });
          try { umInbandSupersedeTotal.inc({ outcome: 'superseded' }); } catch { /* obs fail-safe */ }
          results.push({ id, memory: item, event: 'SUPERSEDED_INBAND', supersededId: supersedeOlderId });
        } catch (err) {
          try { umInbandSupersedeTotal.inc({ outcome: 'demote_error' }); } catch { /* obs fail-safe */ }
          logger.warn(
            { event: 'inband_supersede.demote_error', olderId: supersedeOlderId, newerId: id, err: err?.message },
            'in-band supersession: newer persisted as current, but demoting the older point failed; left for the session-end detector',
          );
          results.push({ id, memory: item, event: 'ADD' });
        }
      } else {
        results.push({ id, memory: item, event: 'ADD' });
      }
    }
    return { results };
  });
}
