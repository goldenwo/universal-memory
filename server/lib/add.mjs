/**
 * server/lib/add.mjs — umAdd() orchestrator: replaces mem0.add() in production.
 *
 * Pipeline (spec §4.3):
 *   1. infer:true  → facts(text)  → string[]; one embed() per fact; one qdrant upsert per fact.
 *   2. infer:false → embed(text)  → one vector; one qdrant upsert.
 *   3. Each call goes through embed/facts orchestrators which emit
 *      um_provider_* metrics with surface=embed / surface=facts.
 *
 * Return shape mirrors mem0's add():
 *   { results: [{ id, memory, event: 'ADD' }, ...] }
 *
 * Qdrant payload schema (LOAD-BEARING — see spec §4.3, §9 risk row 1):
 *   - camelCase userId, createdAt
 *   - metadata fields FLATTENED to top level (no sub-object)
 *   - getAll/search via mem0 must continue to find these writes
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
import { facts as factsOrchestrator } from './facts.mjs';
import { embed as embedOrchestrator } from './embed.mjs';
import { withRequestContext, currentRequestId } from './request-context.mjs';
import { umFactsExtractedTotal } from './metrics.mjs';
import { getLogger, getRequestLogger } from './logger.mjs';

function md5(s) { return createHash('md5').update(s).digest('hex'); }

async function getRealClient(memory) {
  // mem0ai 2.4.6: host/port/collectionName are under memory.config.vectorStore.config
  const { host, port } = memory.config.vectorStore.config;
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  return new QdrantClient({ host, port });
}

function buildPayload({ userId, text, metadata }) {
  return {
    ...metadata,                       // FLATTENED (mem0 convention) — load-bearing
    userId,                            // CAMELCASE — mem0's createFilter uses raw key
    data: text,
    hash: md5(text),
    createdAt: new Date().toISOString(),  // CAMELCASE — match mem0
  };
}

export async function umAdd({
  memory,
  text,
  userId,
  metadata = {},
  infer = true,
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

  const collection = memory.config.vectorStore.config.collectionName;
  const factsCounter = _factsCounter ?? umFactsExtractedTotal;
  // Bind request_id (from outer ALS store) into the logger child so the
  // facts.empty INFO line carries the trigger context. The project's pino
  // config has no global ALS mixin (logger.mjs:113-126) — operators
  // searching by request_id won't find this line otherwise.
  const reqId = currentRequestId();
  const logger = _logger ?? (reqId ? getRequestLogger(reqId) : getLogger());

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
      const id = randomUUID();
      const point = {
        id,
        vector,
        payload: buildPayload({ userId, text: item, metadata }),
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
