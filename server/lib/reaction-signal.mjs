// server/lib/reaction-signal.mjs — Discord-reaction salience signal (#187):
// event constants + metadata normalization for the bot capture surface.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record):
//
// • NAMESPACE BOUNDARY: `signal.reaction` lives OUTSIDE the pinned `capture.*`
//   namespace ON PURPOSE. `event LIKE 'capture.%'` is a LOAD-BEARING FILTER
//   BOUNDARY in stats.mjs (events_today, outcomes_7d, last_day_seen/freshness all
//   derive from it) — NOT a naming style. A reaction row must never advance
//   capture freshness or double-count capture events. Precedent: recall.*
//   (RECALL_EVENTS, recall-telemetry.mjs) — each new event family gets its own
//   namespace + owning module, with recordCaptureEvent as the shared writer.
//
// • DOWNGRADE-INERTNESS: because no pre-v1.12 query matches `signal.%`, a server
//   downgraded below 1.12 reads a counters DB containing reaction rows with NO
//   behavior change. Renaming this event INTO capture.* would corrupt stats on
//   every downgrade (the 2026-07-16 freshness-incident shape in reverse).
//
// • EMIT CONDITIONS (enforced at the umAdd call site): once per umAdd call, ONLY
//   when infer:true (the event records the extraction ADMISSION verdict —
//   outcome 'stored' when ≥1 fact was admitted, 'abstained' when the extractor
//   returned zero; the verbatim infer:false path has no admission verdict AND
//   the mem0-compat R2 verbatim path calls umAdd once PER MESSAGE, which would
//   mint N rows for one reacted exchange), never on _systemMigration, and only
//   when normalized metadata carries a valid reaction_count.
//
// • NORMALIZER CONTRACT: normalizeReactionMetadata never throws and never fails
//   a capture/update; invalid values are dropped (with a once-per-process,
//   per-drop-reason warn — the operator's only signal for a wired-but-buggy
//   bot). Called from BOTH write paths that accept client metadata: umAdd's
//   staging step AND the mem0-compat R6 update sanitizer — the PUT path must
//   not bypass the contract.

import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';

/** Salience-signal event names (own namespace — see header). */
export const SIGNAL_EVENTS = Object.freeze({
  REACTION: 'signal.reaction',
});

/**
 * Fixed outcome vocabulary for signal.reaction rows — the admission-verdict
 * subset. stats.mjs zero-fills reactions_7d from this list; a future arc adding
 * an outcome extends THIS constant and the stats shape follows.
 */
export const REACTION_OUTCOME_KEYS = Object.freeze(['stored', 'abstained']);

/** Bounds (wire contract v1): count clamped, types capped — payload hygiene. */
export const REACTION_COUNT_MAX = 1000;
export const REACTION_TYPES_MAX_ENTRIES = 16;
export const REACTION_TYPE_MAX_CHARS = 64;

const _warnedDropReasons = new Set(); // warn once per process per drop-reason class

function warnDropOnce(reason, detail) {
  if (_warnedDropReasons.has(reason)) return;
  _warnedDropReasons.add(reason);
  safeLog(() => getLogger().warn({
    component: 'reaction-signal',
    drop_reason: reason,
    ...detail,
  }, 'reaction metadata dropped/clamped (warning once per reason class)'),
  'log:reaction-signal:drop');
}

/**
 * Normalize client-supplied reaction metadata in place of trust (per-field
 * independent; see header contract):
 *  - reaction_count not an integer ≥ 1 → BOTH fields removed (count is the
 *    load-bearing signal; types without count is meaningless).
 *  - valid reaction_count clamped to ≤ REACTION_COUNT_MAX.
 *  - reaction_types not an array (count valid) → types removed, count kept.
 *  - within a valid array: non-string entries dropped, entries truncated to
 *    REACTION_TYPE_MAX_CHARS, capped at REACTION_TYPES_MAX_ENTRIES.
 *
 * @param {object|undefined} metadata - caller metadata (NOT mutated)
 * @returns {object} a new metadata object with reaction fields normalized-or-removed
 */
export function normalizeReactionMetadata(metadata) {
  const md = { ...(metadata ?? {}) };
  const hasCount = 'reaction_count' in md;
  const hasTypes = 'reaction_types' in md;
  if (!hasCount && !hasTypes) return md;

  const count = md.reaction_count;
  if (!Number.isInteger(count) || count < 1) {
    delete md.reaction_count;
    delete md.reaction_types;
    warnDropOnce('invalid-count', { got: typeof count });
    return md;
  }
  if (count > REACTION_COUNT_MAX) {
    md.reaction_count = REACTION_COUNT_MAX;
    warnDropOnce('count-clamped', { got: count });
  }

  if (hasTypes) {
    if (!Array.isArray(md.reaction_types)) {
      delete md.reaction_types;
      warnDropOnce('invalid-types', { got: typeof md.reaction_types });
    } else {
      const cleaned = md.reaction_types
        .filter((t) => typeof t === 'string')
        .map((t) => t.slice(0, REACTION_TYPE_MAX_CHARS))
        .slice(0, REACTION_TYPES_MAX_ENTRIES);
      if (cleaned.length !== md.reaction_types.length) {
        warnDropOnce('types-trimmed', { got: md.reaction_types.length, kept: cleaned.length });
      }
      md.reaction_types = cleaned;
    }
  }
  return md;
}

/** Test seam: clear the warn-once dedup set. */
export function _resetReactionSignalForTest() {
  _warnedDropReasons.clear();
}
