/**
 * server/lib/qdrant-client-resolver.mjs — single home for resolving a real
 * @qdrant/js-client-rest client from a mem0 Memory instance.
 *
 * Extracted from add.mjs (rule-of-three: umAdd's write path + memory_checkpoint's
 * detector + the memory_supersede/unsupersede path all resolve a real client off
 * the same mem0 config shape). Pure move — behaviour identical to the prior
 * add.mjs definition (lazy SDK import preserved).
 */

/**
 * Resolve a real qdrant client from a mem0 Memory instance.
 * mem0ai 2.4.6 AND 3.x: host/port live under memory.config.vectorStore.config
 * (shape re-verified against 3.1.6 in the #231 reconciliation).
 */
export async function getRealClient(memory) {
  const { host, port } = memory.config.vectorStore.config;
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  return new QdrantClient({ host, port });
}
