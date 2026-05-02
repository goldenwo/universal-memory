/**
 * server/lib/embedding-stamp.mjs — Embedding stamp read/write/compare/verifyDim.
 *
 * The stamp is a single internal doc stored at metadata.id === '_um_embedding_stamp'
 * that records the active embedding provider/model/dim/schema_version. It anchors
 * the R3 startup guard (DE5) and reindex Phase-5 swap (DE11) by giving the system
 * a durable identifier of the vector store's current embedding shape.
 *
 * Spec refs: §6.1 (stamp shape + metadata.id), §6.2 (read/write/compare/dim probe).
 *
 * Public API (5 named exports):
 *   - readStamp({ memory, collection? })          → stamp | null
 *   - writeStamp({ memory, collection?, stamp })  → void
 *   - compareStamp(stamp, expected)               → 'match' | 'mismatch'
 *       Pure shape-vs-shape comparator. Caller (DE5) derives the expected shape
 *       from env+registry+pricing.
 *   - verifyDim({ embedder, dim })                → void  (throws on mismatch)
 *   - createStampClient({ memory, collection? }) → { read, write, verifyDim, compare }
 *       DI-friendly factory: binds memory + collection once so DE5/DE11 inject
 *       a single `stamp` dependency rather than re-passing memory.
 */

import { SYSTEM_METADATA_IDS } from './system-docs.mjs';
import { umAdd } from './add.mjs';

const STAMP_ID = SYSTEM_METADATA_IDS[0];  // '_um_embedding_stamp'
const STAMP_TEXT = 'embedding-stamp';
const DIM_PROBE_TEXT = '_um_dim_probe';

// mem0 OSS requires one of {userId, agentId, runId} on every add()/getAll()
// call (see node_modules/mem0ai/dist/oss/index.mjs ~line 5038). System docs
// (the stamp) aren't user-scoped, so we use a sentinel userId. Filtered out
// of all user-facing read paths by isSystemDoc() in lib/system-docs.mjs.
// Caught by live boot during v0.7 FIN gate (Apr 30 2026); unit tests with
// stub memory clients didn't surface the contract violation.
const SYSTEM_USER_ID = '_um_system';

export async function readStamp({ memory, collection } = {}) {
  if (!memory?.getAll) throw new Error('readStamp: memory.getAll required');
  const items = await memory.getAll({ userId: SYSTEM_USER_ID, collection });
  const list = Array.isArray(items) ? items : (items?.results ?? []);
  for (const item of list) {
    if (item?.metadata?.id === STAMP_ID) {
      return item.metadata.stamp ?? null;
    }
  }
  return null;
}

export async function writeStamp({ memory, collection, stamp, _qdrantClient, _embedProviderOverride } = {}) {
  if (!memory?.config?.vectorStore?.config?.collectionName) {
    throw new Error('writeStamp: memory.config.vectorStore.config required');
  }
  await umAdd({
    memory,
    text: STAMP_TEXT,
    userId: SYSTEM_USER_ID,
    metadata: { id: STAMP_ID, collection, stamp },
    infer: false,
    _qdrantClient,
    _embedProviderOverride,
  });
}

export function compareStamp(stamp, expected) {
  if (!stamp || !expected) return 'mismatch';
  return (
    stamp.provider === expected.provider &&
    stamp.model === expected.model &&
    stamp.dim === expected.dim
  )
    ? 'match'
    : 'mismatch';
}

export async function verifyDim({ embedder, dim } = {}) {
  if (!embedder?.embedQuery) throw new Error('verifyDim: embedder.embedQuery required');
  let probedDim;
  try {
    const vec = await embedder.embedQuery(DIM_PROBE_TEXT);
    probedDim = Array.isArray(vec) ? vec.length : (vec?.length ?? -1);
  } catch (e) {
    throw new Error(`embedding probe failed: ${e?.message ?? e}`, { cause: e });
  }
  if (probedDim !== dim) {
    throw new Error(
      `embedding dim mismatch: expected ${dim}, got ${probedDim} (provider may have substituted a different model)`,
    );
  }
}

export function createStampClient({ memory, collection } = {}) {
  return {
    read: () => readStamp({ memory, collection }),
    write: (stamp) => writeStamp({ memory, collection, stamp }),
    verifyDim: ({ embedder, dim }) => verifyDim({ embedder, dim }),
    compare: (stamp, expected) => compareStamp(stamp, expected),
  };
}
