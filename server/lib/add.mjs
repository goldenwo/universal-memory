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
 * Errors propagate through existing withRetry({op:'add'}) wrapping at the
 * caller (no new error code introduced — UPSTREAM_FAILURE per spec §6).
 */

import { randomUUID, createHash } from 'node:crypto';
import { facts as factsOrchestrator } from './facts.mjs';
import { embed as embedOrchestrator } from './embed.mjs';
import { withRetry } from './retry.mjs';
import { withRequestContext, currentRequestId } from './request-context.mjs';
import { umFactsExtractedTotal } from './metrics.mjs';
import { getLogger } from './logger.mjs';

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
  // T13 seam:
  _retryOpts,
  // T15 seams (NEW):
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
  const logger = _logger ?? getLogger();

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

    const results = [];
    for (const item of items) {
      const { vector } = await embedOrchestrator(item, { _providerOverride: _embedProviderOverride, metrics });
      const id = randomUUID();
      const point = {
        id,
        vector,
        payload: buildPayload({ userId, text: item, metadata }),
      };
      const client = _qdrantClient ?? await getRealClient(memory);
      await withRetry(
        () => client.upsert(collection, { points: [point] }).catch((e) => {
          // Mark transient errors retryable; let withRetry surface UPSTREAM_FAILURE on exhaustion.
          if (e?.retryable === undefined) e.retryable = true;
          throw e;
        }),
        { op: 'add', ...(_retryOpts ?? {}) },
      );
      results.push({ id, memory: item, event: 'ADD' });
    }
    return { results };
  });
}
