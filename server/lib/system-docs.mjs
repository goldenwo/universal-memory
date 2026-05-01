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
