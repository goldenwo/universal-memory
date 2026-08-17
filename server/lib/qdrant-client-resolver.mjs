/**
 * server/lib/qdrant-client-resolver.mjs — single home for resolving a real
 * @qdrant/js-client-rest client from a mem0 Memory instance.
 *
 * Extracted from add.mjs (rule-of-three: umAdd's write path + memory_checkpoint's
 * detector + the memory_supersede/unsupersede path all resolve a real client off
 * the same mem0 config shape). Pure move — behaviour identical to the prior
 * add.mjs definition (lazy SDK import preserved).
 */

// #231: memoize per Memory instance — the native read adapters
// (lib/mem0-read.mjs) resolve a client on EVERY search/list/stats/health
// call, and each QdrantClient construction fires an unawaited version-
// compatibility probe (an extra round-trip + a raw console.warn per call
// against a version-skewed server). One client per Memory is the correct
// lifetime: host/port are constructor-fixed on the config this key wraps.
const clientCache = new WeakMap();

/**
 * Resolve a real qdrant client from a mem0 Memory instance.
 * mem0ai 2.4.6 AND 3.x: host/port live under memory.config.vectorStore.config
 * (shape re-verified against 3.1.6 in the #231 reconciliation).
 */
export async function getRealClient(memory) {
  const cached = clientCache.get(memory);
  if (cached) return cached;
  const { host, port } = memory.config.vectorStore.config;
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const client = new QdrantClient({ host, port });
  clientCache.set(memory, client);
  return client;
}
