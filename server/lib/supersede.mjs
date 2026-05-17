/**
 * server/lib/supersede.mjs — D3.1 substrate: point-level supersession primitives.
 *
 * `supersedePoint`   — marks a qdrant point as superseded by another.
 * `unsupersedePoint` — restores a superseded point to current status.
 *
 * These are INERT in D3.1: defined here but not called by any detector or
 * write-path code yet. D3.2 will wire them into the auto-supersession detector.
 * Operator invocation via MCP is handled in later D3.1 tasks.
 *
 * Call signature mirrors mergeSurface() in dedup.mjs (the established
 * setPayload idiom in this codebase):
 *
 *   client.setPayload(collection, { points: [id], payload: { ... } })
 *
 * Real qdrant setPayload is an ADDITIVE partial merge — it updates only the
 * supplied keys; it cannot delete keys. unsupersedePoint therefore clears
 * provenance fields to `null` (not key-delete). Filters in this codebase
 * key on `status` value only, so null provenance is harmless.
 *
 * Spec refs: §3.2 (point lifecycle), §3.7 (supersession schema).
 * Plan refs: D3.1 Task 1.3.
 */

/**
 * Mark a qdrant point as superseded.
 *
 * @param {object} params
 * @param {object} params.client       - Qdrant client with `.setPayload()`
 * @param {string} params.collection   - Collection name
 * @param {string} params.id           - Point id to supersede
 * @param {string} params.supersededBy - Id of the point that supersedes this one
 */
export async function supersedePoint({ client, collection, id, supersededBy }) {
  await client.setPayload(collection, {
    points: [id],
    payload: {
      status: 'superseded',
      supersededBy,
      supersededAt: new Date().toISOString(),
    },
  });
}

/**
 * Restore a superseded point to current status, clearing provenance.
 *
 * Non-cascading: only the single named point is affected.
 * Clears supersededBy / supersededAt to null (setPayload cannot delete keys).
 *
 * @param {object} params
 * @param {object} params.client     - Qdrant client with `.setPayload()`
 * @param {string} params.collection - Collection name
 * @param {string} params.id         - Point id to restore
 */
export async function unsupersedePoint({ client, collection, id }) {
  await client.setPayload(collection, {
    points: [id],
    payload: {
      status: 'current',
      supersededBy: null,
      supersededAt: null,
    },
  });
}
