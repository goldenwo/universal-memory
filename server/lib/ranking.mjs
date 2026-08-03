/**
 * ranking.mjs — scoring/re-ranking helpers for universal-memory search results.
 *
 * Exports:
 *   resolveItemDate(r)                          → epoch ms | null
 *   applyTemporalDecay(results, halfLifeDays)   → sorted results[]
 *   applyTemporalWindow(results, window, opts)  → sorted results[]
 *   countInWindow(results, window)              → number
 *
 * THE RANKING DATE IS `metadata.valid_from` AND NOTHING ELSE (spec D-h REVISED).
 * `createdAt` / `created_at` are deliberately not consulted — see resolveItemDate
 * for the measurement behind that. An item with no resolvable date keeps its
 * original score in both re-rankers: undated means neutral, never penalised.
 *
 * Decay:  score = originalScore * exp(-ageDays / halfLifeDays), anchored at now.
 *         Enabled via UM_TEMPORAL_DECAY=true; half-life UM_DECAY_HALF_LIFE_DAYS
 *         (default 30).
 * Window: score unchanged inside a resolved window, demoted with a floored
 *         exponential outside it. Enabled via UM_TEMPORAL_QUERY=true. It
 *         SUBSTITUTES for decay rather than stacking — both are wired in
 *         mem0-mcp-http.mjs.
 */

const DAY_MS = 86400000;

/**
 * Items dated up to this far past a window's end edge still count as in-window.
 * Absorbs Pi/container clock drift so a just-captured item is not demoted for
 * arriving a few seconds "after now". Spec D-d, pinned rather than left to taste.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Lower bound on the out-of-window multiplier. See windowFalloffDays. */
export const DEMOTION_FLOOR = 0.05;

/**
 * The single ranking-date resolver, shared by decay and the window re-rank.
 *
 * **`valid_from` ONLY — `createdAt` is deliberately NOT consulted** (spec D-h,
 * revised on the F19 measurement). `umAdd` stamps `createdAt` at write time and
 * a reindex rebuilds through `umAdd`, so for the 186 of 353 live points that
 * carry no `valid_from`, `createdAt` is bulk-arrival time: 86.5% of them sit on
 * just two days (a migration and a reindex). Grading on it would rank half the
 * corpus by which import it arrived in — strictly worse than leaving those
 * points neutral, which is what they get today.
 *
 * Note the old `metadata.valid_from || r.created_at` expression was dead on the
 * second operand: mem0ai's search maps results with camelCase `createdAt`, so
 * the snake_case fallback never fired. That deadness was accidentally the safer
 * behavior. The fix is to state the intent, not to switch the fallback on.
 *
 * @returns {number|null} epoch ms, or null when absent / empty / unparseable.
 */
export function resolveItemDate(r) {
  const vf = r?.metadata?.valid_from;
  if (!vf) return null;
  const ms = new Date(vf).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is `r` inside `window`?
 *
 * The clock-skew tolerance applies ONLY when the end edge is `now`
 * (`window.nowAnchored`). A fixed calendar boundary — `yesterday`, `last week`,
 * `on 2026-07-14` — has no drift to absorb: an item three minutes into today is
 * not a clock artifact, it is a different day. Widening those would silently
 * change what the window means, and since one such item can flip
 * `temporalActive`, it could trigger a full re-rank by itself.
 *
 * Unmarked windows default to exact, so a caller that omits the flag gets the
 * strict boundary rather than a silently widened one.
 */
function isInWindow(r, window) {
  const ms = resolveItemDate(r);
  if (ms === null) return false;
  const tolerance = window.nowAnchored === true ? CLOCK_SKEW_TOLERANCE_MS : 0;
  return ms >= window.start && ms <= window.end + tolerance;
}

/**
 * How many candidates fall inside the window.
 *
 * Load-bearing for spec D-b0: `temporalActive` means "a window resolved AND at
 * least one candidate is inside it". Defining it as merely "a window parsed"
 * would put D-b1's skip inside the `if` arm of doSearch's
 * `if (temporal) … else if (decay) …`, silently disabling decay for exactly the
 * zero-in-window queries D-b1 predicts are common.
 */
export function countInWindow(results, window) {
  if (!isUsableWindow(window)) return 0;
  return results.reduce((n, r) => n + (isInWindow(r, window) ? 1 : 0), 0);
}

function isUsableWindow(window) {
  return !!window && Number.isFinite(window.start) && Number.isFinite(window.end)
    && window.end >= window.start;
}

/**
 * Falloff constant for a window, scaled to its own span (spec D-b2).
 *
 * A single fixed constant cannot serve twelve kinds spanning a day to a year:
 * at 14 days, an `in_month` query five months back multiplies by exp(-120/14) ≈
 * 2e-4 — observably a hard filter, which the "never filters" property forbids.
 * Scaling alone is not enough either; it just moves the same annihilation to the
 * short end (`today` ⇒ 1-day falloff ⇒ exp(-7) ≈ 9e-4 a week out), which is why
 * DEMOTION_FLOOR exists.
 */
export function windowFalloffDays(window) {
  const spanDays = (window.end - window.start) / DAY_MS;
  return Math.min(30, Math.max(1, spanDays * 0.5));
}

/**
 * Apply temporal decay re-ranking to a list of search results.
 *
 * @param {Array<object>} results  - Search result objects with optional score
 *                                   and metadata.valid_from.
 * @param {number}        halfLifeDays - Half-life in days for the decay factor.
 * @returns {Array<object>} New array sorted by decayed score descending.
 *                          Input array and its items are NOT mutated.
 */
export function applyTemporalDecay(results, halfLifeDays) {
  const now = Date.now();
  const decayed = results.map((r) => {
    const ms = resolveItemDate(r);
    if (ms === null) {
      // No resolvable date — shallow copy with score unchanged.
      return { ...r };
    }
    const ageDays = (now - ms) / DAY_MS;
    const factor = Math.exp(-ageDays / halfLifeDays);
    return { ...r, score: (r.score || 1) * factor };
  });

  // Sort descending by score; items missing score sort last (treat as 0)
  decayed.sort((a, b) => (b.score || 0) - (a.score || 0));
  return decayed;
}

/**
 * Re-rank results against a resolved time window (spec D-b).
 *
 * Contract mirrors applyTemporalDecay: pure, returns a NEW sorted array, never
 * mutates, and a score is only ever multiplied by a factor ≤ 1 — consumers never
 * see an inflated score.
 *
 *   no usable window        → input returned unchanged  (D-b3)
 *   zero in-window items    → input returned unchanged  (D-b1)
 *   in-window               → score unchanged
 *   out-of-window           → score × max(exp(−dEdge/falloff), DEMOTION_FLOOR)
 *   no resolvable date      → score unchanged
 *
 * Out-of-window items are demoted, never dropped — matching UM's recall-safety
 * house rule and mem0's "additive, never filters out" posture.
 *
 * @param {Array<object>} results
 * @param {{start:number,end:number}} window
 * @param {{falloffDays?:number}} [opts] - `= {}` default is load-bearing: the
 *   production call site passes two arguments and a bare destructure would
 *   throw, which the parser's fail-open wrapper does not cover.
 */
export function applyTemporalWindow(results, window, { falloffDays, inWindowCount } = {}) {
  if (!isUsableWindow(window)) return [...results];
  // D-b1: nothing in the window ⇒ every item would be multiplied by a distance
  // term varying by orders of magnitude, so the exponential would dominate
  // cosine entirely and the result would silently become a date ordering.
  //
  // `inWindowCount` lets a caller that already computed the count (doSearch does,
  // to decide temporalActive) skip a second pass over every candidate. Omitted ⇒
  // computed here, so the guard holds for every other caller — this is an
  // exported pure function and D-b3 makes self-validation its contract.
  const inWindow = Number.isInteger(inWindowCount) ? inWindowCount : countInWindow(results, window);
  if (inWindow === 0) return [...results];

  // D-b3: a degenerate override (0 ⇒ exp(-∞) = 0, a silent hard filter; NaN ⇒
  // NaN scores serialized as null on the wire) falls back to the derived value.
  const falloff = Number.isFinite(falloffDays) && falloffDays > 0
    ? falloffDays
    : windowFalloffDays(window);

  const ranked = results.map((r) => {
    const ms = resolveItemDate(r);
    if (ms === null || isInWindow(r, window)) return { ...r };
    const dEdge = ms < window.start ? window.start - ms : ms - window.end;
    const factor = Math.max(Math.exp(-(dEdge / DAY_MS) / falloff), DEMOTION_FLOOR);
    return { ...r, score: (r.score || 1) * factor };
  });

  ranked.sort((a, b) => (b.score || 0) - (a.score || 0));
  return ranked;
}
