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
 *   - Eligibility: dedup runs ONLY when UM_DEDUP_ENABLED=true AND not a
 *     system doc AND _systemMigration !== true. Independent of `infer` per
 *     DP6/DP7 — vault docs (infer:false) CAN duplicate cross-surface and
 *     SHOULD merge.
 *   - Per dedup-eligible item: Layer 1 (hash) → Layer 2 (embedding); on hit,
 *     mergeSurface and emit DEDUP_MERGED event instead of upsert.
 *   - Fail-soft on dedup query error: log+metric, fall through to plain upsert.
 *   - Point-ID: dedup-eligible writes use uuidv5(`${userId}:${hash}`, NAMESPACE_UM)
 *     for TOCTOU-resistant deterministic IDs; non-dedup writes use randomUUID().
 *
 * Return shape mirrors mem0's add():
 *   { results: [{ id, memory, event: 'ADD' | 'DEDUP_MERGED' }, ...] }
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
import { umFactsExtractedTotal } from './metrics.mjs';
import { getLogger, getRequestLogger } from './logger.mjs';
import { isSystemDoc } from './system-docs.mjs';
import { assertNoReservedFields, NAMESPACE_UM } from './dedup-constants.mjs';
import { checkContentHashDedup, checkEmbeddingDedup, mergeSurface } from './dedup.mjs';

function md5(s) { return createHash('md5').update(s).digest('hex'); }

async function getRealClient(memory) {
  // mem0ai 2.4.6: host/port/collectionName are under memory.config.vectorStore.config
  const { host, port } = memory.config.vectorStore.config;
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  return new QdrantClient({ host, port });
}

function buildPayload({ userId, text, metadata, surface }) {
  // Capture metadata.project BEFORE the flatten-spread so we can ALSO seed
  // the `projects` Set field. Both forms (scalar + Set) coexist for backward
  // compat — existing project-scoped readers use the scalar; new readers
  // prefer the Set (D1 spec §4.4, DP2 Option C).
  const projectScalar = metadata?.project;
  const surfaces = surface ? [surface] : undefined;
  const projects = projectScalar ? [projectScalar] : undefined;
  return {
    ...metadata,                       // FLATTENED (mem0 convention) — load-bearing
    userId,                            // CAMELCASE — mem0's createFilter uses raw key
    data: text,
    hash: md5(text),
    createdAt: new Date().toISOString(),  // CAMELCASE — match mem0
    ...(surfaces ? { surfaces } : {}),
    ...(projects ? { projects } : {}),
    dedupCount: 1,
    dedupVersion: 1,
  };
}

/**
 * Compute dedup-eligibility per spec §4.5.1 step 2.
 * Independent of `infer` — see DP6/DP7 in spec.
 */
function computeDedupEligible({ metadata, _systemMigration }) {
  if (process.env.UM_DEDUP_ENABLED !== 'true') return false;
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
  assertNoReservedFields(metadata);

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
      const itemHash = md5(item);
      const itemProject = metadata?.project;

      // D1 dedup hook — Layer 1 (hash) → Layer 2 (embedding). Only runs
      // when dedup-eligible (flag on, not system-doc, not migration).
      // Fail-soft: any dedup-query error logs+metrics inside dedup.mjs's
      // instrumented() wrapper and rethrows; we catch here and fall through
      // to plain upsert per spec §4.6.
      if (dedupEligible) {
        try {
          let hit = await checkContentHashDedup({ client, collection, userId, hash: itemHash });
          if (!hit) {
            hit = await checkEmbeddingDedup({
              client, collection, userId, vector, threshold: dedupThreshold,
            });
          }
          if (hit) {
            const merged = await mergeSurface({
              client, collection, existingPoint: hit, newSurface: surface, newProject: itemProject,
            });
            results.push(merged);
            continue;  // skip upsert — dedup-merge took its place
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
      const id = dedupEligible
        ? uuidv5(`${itemHash}:${userId}`, NAMESPACE_UM)
        : randomUUID();
      const point = {
        id,
        vector,
        payload: buildPayload({ userId, text: item, metadata, surface }),
      };
      // Errors propagate raw — outer call sites (mem0-mcp-http) wrap in
      // withRetry({op:'add'}); reindex Phase 3 wraps via runPhase3Rebuild's
      // own retry+checkpoint mechanics (Adv-4 spec).
      await client.upsert(collection, { points: [point] });
      results.push({ id, memory: item, event: 'ADD' });
    }
    return { results };
  });
}
