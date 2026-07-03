/**
 * server/lib/recallable.mjs — the ONE read-path status-exclusion predicate.
 *
 * A record is "recallable" unless its metadata marks it superseded /
 * deprecated / rejected / invalidated. Shared by doSearch's
 * include_superseded=false filter (mem0-mcp-http.mjs) and the mem0-compat
 * facade's R3/R4/R5/R10 read paths (lib/mem0-compat.mjs) so the two
 * surfaces can never drift on what "never surfaces on read" means.
 *
 * Input is a raw memory-client record ({metadata?}) OR any object whose
 * status bookkeeping lives under `.metadata` — the projector-agnostic shape
 * both call sites share. Never throws on missing/odd metadata.
 *
 * @param {{metadata?: object}|null|undefined} item
 * @returns {boolean} true when the record may surface on a read path
 */
export function isRecallable(item) {
  const md = item?.metadata || {};
  return !(
    md.status === 'superseded' ||
    md.status === 'deprecated' ||
    md.status === 'rejected' ||
    md.invalidated_at != null
  );
}
