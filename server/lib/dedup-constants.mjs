/**
 * server/lib/dedup-constants.mjs — D1-specific constants and reserved-field guard.
 *
 * Owns:
 *   - RESERVED_METADATA_FIELDS: payload field names that callers must NOT pass via
 *     metadata (server reserves them for dedup bookkeeping). Includes `systemMigration`
 *     specifically so untrusted callers cannot smuggle the dedup bypass.
 *   - NAMESPACE_UM: stable UUID v5 namespace for deterministic point IDs in the
 *     hash-layer dedup path. DO NOT regenerate — load-bearing for ID stability
 *     across releases.
 *   - ReservedMetadataFieldError: thrown by assertNoReservedFields.
 *   - assertNoReservedFields(metadata): pre-buildPayload guard that rejects
 *     caller-supplied metadata containing any reserved key. Runs in umAdd's
 *     entry guard order (see spec §4.5.1 step 1).
 *
 * Spec refs: §3.4 (point-ID switch), §4.3 (mergeSurface schema fields),
 *            §4.4 (buildPayload reserved-field guard), §4.5.1 (umAdd entry guard order),
 *            §6 DP8 (deterministic point ID rationale), §8.1 T8/T11b (test contract),
 *            R5 / G11 (caller-trust boundary).
 *
 * Co-located here (not in lib/system-docs.mjs) per spec §5 R2 G10 — keeps
 * system-docs.mjs cohesively scoped to system-doc filtering.
 */

/**
 * Frozen list of metadata field names reserved for D1 server-side bookkeeping.
 * Callers passing metadata.<reserved> will be rejected at umAdd entry by
 * assertNoReservedFields below. The R5 + G11 trust boundary depends on this
 * list including `systemMigration` — see spec §4.5.1.
 */
export const RESERVED_METADATA_FIELDS = Object.freeze([
  'surfaces',
  'projects',
  'dedupCount',
  'dedupVersion',
  'dedupLastSeenAt',
  'systemMigration',
  'status',
  'supersededBy',
  'supersededAt',
]);

/**
 * Stable UUID v5 namespace for deterministic point IDs. Generated once at
 * 2026-05-09 via `crypto.randomUUID()`; baked here permanently. Do NOT
 * regenerate — point-ID stability across releases depends on this constant.
 *
 * uuidv5(`${userId}:${hash}`, NAMESPACE_UM) is used in the hash-layer path
 * (spec DP8 option ii) to make concurrent identical writes collide
 * deterministically rather than producing two near-duplicate qdrant points.
 */
export const NAMESPACE_UM = 'e2de504c-45bb-4531-952f-f33a6f60c945';

/**
 * Thrown when caller-supplied metadata contains a reserved field. Carries the
 * offending field name for diagnostics. Subclassing Error so callers can
 * `instanceof` check.
 */
export class ReservedMetadataFieldError extends Error {
  constructor(field) {
    super(`metadata.${field} is reserved by the server for dedup bookkeeping; pass via the appropriate umAdd argument instead`);
    this.name = 'ReservedMetadataFieldError';
    this.field = field;
  }
}

/**
 * Pre-buildPayload guard. Throws ReservedMetadataFieldError if `metadata`
 * has any own-property whose name is in RESERVED_METADATA_FIELDS.
 *
 * Uses Object.prototype.hasOwnProperty.call to defeat prototype-pollution
 * smuggling (spec R4 A2). Treats null/undefined/non-object metadata as a
 * no-op — those cases never construct a payload anyway.
 *
 * Runs OUTSIDE withRequestContext (spec §4.5.1 + plan D.1) — caller-input
 * errors should not acquire a request-id child logger.
 */
export function assertNoReservedFields(metadata) {
  if (!metadata || typeof metadata !== 'object') return;
  for (const field of RESERVED_METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(metadata, field)) {
      throw new ReservedMetadataFieldError(field);
    }
  }
}
