// server/eval/lib/call-record.mjs — the per-call record the model-migration Phase B harnesses keep
// (docs/plans/2026-10-25-model-migration-phase-b/prereg.md "Roles, inputs and records"): the R1
// fields, ok and failCause, and the call's latency. An invoke-error carries only ok, failCause and
// its latency (there was no response), which the frozen scorer relies on.
import { R1_FIELDS } from '../../lib/provider/call-record.mjs';

export const CALL_FIELDS = Object.freeze(['ok', 'failCause', ...R1_FIELDS, 'ms']);

/** Run `fn` (a thunk returning a promise) and return its resolved object with `ms` added. */
export async function timed(fn) {
  const t0 = performance.now();
  const v = await fn();
  return { ...v, ms: performance.now() - t0 };
}

/** The CALL_FIELDS of a dispatcher verdict, leaving out the ones it does not carry. */
export function callRecord(v) {
  return Object.fromEntries(CALL_FIELDS.filter((k) => v?.[k] !== undefined).map((k) => [k, v[k]]));
}
