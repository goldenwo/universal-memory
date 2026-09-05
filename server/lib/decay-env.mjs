/**
 * server/lib/decay-env.mjs — the ONE owner of the two temporal-decay env reads (#297 spec D25).
 *
 * Lifted out of mem0-mcp-http.mjs on the lib/write-enabled.mjs precedent: doSearch derives the
 * undated factor from `resolveHalfLifeDays()`, and buildStats computes `applied_factor` from the
 * SAME helper, so the operator-facing number on /api/stats cannot drift from what a search
 * actually applies (R8 asserts the equality). An entrypoint→lib import is safe; a lib→entrypoint
 * import is not, which is why this is a lib module and not two copies of the parse.
 *
 * `resolveHalfLifeDays()`: `raw = Number(env)`, then `Number.isFinite(raw) && raw > 0 ? raw : 30`.
 * `Number`, not `parseInt` — '1e3' → 1000, '7.5' → 7.5 — and a negative or zero H can never
 * survive: the previous `parseInt(x || '30', 10) || 30` let −5 through, and `exp(-A_q/-5)` clamps
 * to exactly 1.0, the inflation the undated policy exists to prevent (spec D18 keeps an
 * independent guard inside `undatedFactorFor` on purpose — its fallback differs).
 *
 * NAMING: UM_DECAY_HALF_LIFE_DAYS is an E-FOLDING time, not a half-life (see ranking.mjs's
 * header); the operator-facing name is kept for compatibility.
 */

export const DEFAULT_HALF_LIFE_DAYS = 30;

/** The decay timescale in days for THIS request: a positive finite number, else 30. */
export function resolveHalfLifeDays(env = process.env) {
  const raw = Number(env.UM_DECAY_HALF_LIFE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HALF_LIFE_DAYS;
}

/** Exactly the string 'true' enables temporal decay; anything else is off (the shipped default). */
export function isDecayEnabled(env = process.env) {
  return env.UM_TEMPORAL_DECAY === 'true';
}
