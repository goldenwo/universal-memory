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
 * Subset of RESERVED_METADATA_FIELDS that D3.1 added for server-managed
 * supersession state. These three fields appear legitimately in vault-authored
 * doc frontmatter (e.g. `status: superseded`) and must be accepted by the
 * trusted server reindex/bulk-import path (_systemMigration:true) so that
 * pre-existing authored-doc supersession is not broken.
 *
 * The exemption is scoped ONLY to these 3 fields and ONLY on the trusted path.
 * The original 6 pre-D3.1 fields remain blocked unconditionally (spec R5/G11).
 * See spec §2 ("vault-backed authored-doc supersession … D3.1 does not touch
 * that path") and §3.2 (external callers must not forge supersession state).
 */
export const D3_SERVER_MANAGED_STATUS_FIELDS = Object.freeze([
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
 *
 * Injecting a reserved field is a CALLER input error, not a server fault, so
 * the error self-describes its class via the same envelope convention every
 * sibling validator uses — `code: 'INPUT_INVALID'` (cf. validateLanePersonaSlug
 * in default-project.mjs, bridge-contract.mjs, frontmatter.mjs). The HTTP layer
 * maps this to 400. `retryable: false` opts the error out of withRetry's
 * default-retryable path (retry.mjs) — retrying a malformed request is pointless
 * and would turn a fast 400 into a slow 502.
 */
export class ReservedMetadataFieldError extends Error {
  constructor(field) {
    super(`metadata.${field} is reserved by the server for dedup bookkeeping; pass via the appropriate umAdd argument instead`);
    this.name = 'ReservedMetadataFieldError';
    this.field = field;
    this.code = 'INPUT_INVALID';
    this.retryable = false;
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
 *
 * @param {object|null|undefined} metadata - Caller-supplied metadata to validate.
 * @param {object}  [opts]
 * @param {boolean} [opts.trustedServerPath=false] - When true (set by umAdd on the
 *   _systemMigration:true path), the 3 D3.1-managed supersession-state fields
 *   (`status`, `supersededBy`, `supersededAt`) are exempted from rejection.
 *   These fields appear legitimately in vault-authored doc frontmatter that the
 *   reindex / bulk-import path passes through as server-trusted input. The
 *   original 6 pre-D3.1 reserved fields remain blocked regardless (spec R5/G11).
 *   See D3_SERVER_MANAGED_STATUS_FIELDS and spec §2 / §3.2.
 */
export function assertNoReservedFields(metadata, { trustedServerPath = false } = {}) {
  if (!metadata || typeof metadata !== 'object') return;
  for (const field of RESERVED_METADATA_FIELDS) {
    if (trustedServerPath && D3_SERVER_MANAGED_STATUS_FIELDS.includes(field)) continue;
    if (Object.prototype.hasOwnProperty.call(metadata, field)) {
      throw new ReservedMetadataFieldError(field);
    }
  }
}
