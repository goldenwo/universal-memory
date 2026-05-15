/**
 * server/lib/collection-init.mjs — D2 qdrant payload-index seam.
 *
 * D1 introduced lane / persona payload fields (well, D2 did — D1 introduced
 * the dedup hook that D2 cascades through). Filtered queries on those fields
 * would full-scan the collection without a payload-index, which is O(N) on
 * the userId's point count. Index = O(log N).
 *
 * `createPayloadIndex` is supported by `@qdrant/js-client-rest@1.13.0`
 * (verified at `qdrant-client.d.ts:~1232`). D1 shipped zero index sites; D2
 * owns the seam.
 *
 * Invocation contract:
 *   - Call ONCE per server boot, AFTER the warmup loop in mem0-mcp-http.mjs
 *     has succeeded (which lazily creates the collection via mem0's first
 *     `getAll({__warmup__})` call). At that point the collection definitely
 *     exists and the index call returns 200/201.
 *   - 409 (index already exists) is the idempotency-success arm; swallow.
 *   - Any other error WARN-not-throw so the server still boots and degrades
 *     to full-scan on filtered queries.
 *
 * @param {{ createPayloadIndex: Function }} client — qdrant client (or test
 *   double matching the signature)
 * @param {string} collection — collection name (from
 *   `memory.config.vectorStore.config.collectionName`)
 * @param {{ logger?: { warn: Function } }} [opts]
 */
export async function ensurePayloadIndexes(client, collection, { logger } = {}) {
  if (!client?.createPayloadIndex) {
    // Caller error — surfaced as a WARN rather than throw so a misconfigured
    // boot path doesn't brick the whole process. Production callers
    // construct the qdrant client directly; tests can pass an upsert-only
    // mock and this WARN flags the gap.
    logger?.warn?.(
      { event: 'collection_init.skipped', reason: 'client_missing_createPayloadIndex' },
      'ensurePayloadIndexes skipped — client has no createPayloadIndex method',
    );
    return;
  }
  if (!collection || typeof collection !== 'string') {
    logger?.warn?.(
      { event: 'collection_init.skipped', reason: 'collection_missing' },
      'ensurePayloadIndexes skipped — collection name missing',
    );
    return;
  }
  for (const fieldName of ['lane', 'persona']) {
    try {
      await client.createPayloadIndex(collection, {
        field_name: fieldName,
        field_schema: 'keyword',
      });
    } catch (err) {
      // 409 = index already exists → idempotency-success, swallow silently.
      // Other errors → WARN-not-throw per the boot contract above.
      const status = err?.status ?? err?.statusCode ?? null;
      if (status === 409) continue;
      logger?.warn?.(
        {
          event: 'collection_init.failed',
          field: fieldName,
          collection,
          status,
          errorMessage: err?.message,
        },
        `createPayloadIndex(${fieldName}) failed; filtered queries on this field will full-scan until re-created`,
      );
    }
  }
}
