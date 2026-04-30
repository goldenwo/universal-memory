/**
 * server/lib/system-docs.mjs — System-doc filter — exclude internal docs from user-facing read paths.
 *
 * Spec §6.1: stamp doc must be filtered from every read path. Single helper avoids per-touchpoint
 * re-implementation of the exclusion logic.
 */

export const SYSTEM_METADATA_IDS = ['_um_embedding_stamp'];

export function isSystemDoc(item) {
  const id = item?.metadata?.id;
  return SYSTEM_METADATA_IDS.includes(id);
}

export function filterSystemDocs(items) {
  return items.filter((i) => !isSystemDoc(i));
}
