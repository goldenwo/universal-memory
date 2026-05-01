/**
 * server/lib/system-docs.mjs — System-doc filter — exclude internal docs from user-facing read paths.
 *
 * Spec §6.1: stamp doc must be filtered from every read path. Single helper avoids per-touchpoint
 * re-implementation of the exclusion logic.
 */

/**
 * Frozen list of metadata.id values treated as internal/system docs.
 * Frozen so downstream callers cannot mutate the contract at the module boundary.
 * @type {ReadonlyArray<string>}
 */
export const SYSTEM_METADATA_IDS = Object.freeze(['_um_embedding_stamp']);

/**
 * Returns true when the item is a system/internal doc (matched by metadata.id).
 * Safe against null/undefined/missing-metadata inputs (returns false).
 * @param {{metadata?: {id?: string}} | null | undefined} item
 * @returns {boolean}
 */
export function isSystemDoc(item) {
  const id = item?.metadata?.id;
  return SYSTEM_METADATA_IDS.includes(id);
}

/**
 * Returns a new array with system/internal docs removed.
 * Defensive against non-array input (returns []) so callers can pass through
 * possibly-undefined upstream results without a guard.
 * @param {Array<{metadata?: {id?: string}}> | null | undefined} items
 * @returns {Array<{metadata?: {id?: string}}>}
 */
export function filterSystemDocs(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((i) => !isSystemDoc(i));
}

/**
 * Returns a new array with system/internal docs removed, matching against
 * `id` at the top level of each item (not under `metadata.id`).
 *
 * Used by read paths whose records expose `id` directly — e.g. doRecent,
 * which projects vault files into `{ id, title, snippet }` records before
 * filtering. Centralizing this shape variant keeps the data-shape decision
 * inside system-docs.mjs and prevents per-touchpoint re-implementation.
 *
 * Defensive against non-array input (returns []) and items with `id` that is
 * null/undefined/non-string (treated as non-system).
 * @param {Array<{id?: string}> | null | undefined} items
 * @returns {Array<{id?: string}>}
 */
export function filterSystemDocsByTopLevelId(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((i) => !SYSTEM_METADATA_IDS.includes(i?.id));
}
