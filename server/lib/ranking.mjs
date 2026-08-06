/**
 * ranking.mjs — scoring/re-ranking helpers for universal-memory search results.
 *
 * Exports:
 *   resolveItemDate(r)                          → epoch ms | null
 *   isUsableDate(v)                             → boolean (write-side guard)
 *   applyTemporalDecay(results, halfLifeDays)   → sorted results[]
 *   applyTemporalWindow(results, window, opts)  → sorted results[]
 *   countInWindow(results, window)              → number
 *
 * THE RANKING DATE IS `metadata.valid_from` AND NOTHING ELSE (spec D-h REVISED).
 * `createdAt` / `created_at` are deliberately not consulted — see resolveItemDate
 * for the measurement behind that.
 *
 * The two re-rankers now treat an undated item DIFFERENTLY, deliberately:
 *   - applyTemporalWindow: still leaves it untouched — undated reads as in-window.
 *     A window is query-expressed intent, and demoting an unknown date when the user
 *     asked about a period trades recall for a guess.
 *   - applyTemporalDecay: imputes a flat one e-folding (see UNDATED_FACTOR). Leaving it
 *     at 1.0 stopped being neutral the moment everything else decayed — it became the
 *     top of the range.
 * Their imputations must eventually be chosen JOINTLY: the two are mutually exclusive at
 * the call site, so with both flags on, a query that resolves a window would leave undated
 * points at 1.0 while every other query scales them — flipping their treatment on
 * incidental phrasing rather than on any property of the data.
 *
 * Decay:  score = originalScore * exp(-ageDays / halfLifeDays), anchored at now.
 *         Enabled via UM_TEMPORAL_DECAY=true; timescale UM_DECAY_HALF_LIFE_DAYS
 *         (default 30). NAMING: that variable is an E-FOLDING time, not a
 *         half-life — exp(-age/H) reaches 0.5 at H*ln2 ~= 0.69*H, not at H. The
 *         operator-facing name is kept for compatibility; the misnomer is noted
 *         here so nobody derives a half-life from it.
 * Window: score unchanged inside a resolved window, demoted with a floored
 *         exponential outside it. Enabled via UM_TEMPORAL_QUERY=true. It
 *         SUBSTITUTES for decay rather than stacking — both are wired in
 *         mem0-mcp-http.mjs.
 */

const DAY_MS = 86400000;

/**
 * Imputed age for an undated point, in e-foldings of the decay timescale.
 *
 * WHY THIS EXISTS. `applyTemporalDecay` used to return an undated result with its score
 * untouched, defended as "undated means neutral, never penalised". That was true while
 * nothing decayed. Once every DATED point is multiplied by `exp(-age/H) < 1`, a factor of
 * 1.0 stops being the middle of the range and becomes the TOP of it: undated points became
 * strictly better than every dated one, without anyone choosing that.
 *
 * WHY A FIXED CONSTANT, and not a median of the result set: on the decay path the fetch
 * limit equals the result limit, so the dated sample is typically 1-3 points — the
 * estimator would be noisiest exactly where it runs, would be an ordering no-op at n=1,
 * and one very old point would annihilate the undated cohort. It is applied
 * UNCONDITIONALLY (no "any dated?" short-circuit) because a conditional would make an
 * item's factor depend on the rest of the returned set: the same point would score 1.0x at
 * limit=5 and 0.368x at limit=10.
 *
 * Deliberately NOT an env knob: this module is pure and takes `halfLifeDays` as a
 * parameter. The feature already has a kill switch (UM_TEMPORAL_DECAY), and a knob's only
 * distinct capability would be "decay on, undated at 1.0" — i.e. re-enabling the defect.
 *
 * MAGNITUDE IS AN OPEN CALL. Measured on the live corpus (2026-08-05, 215 dated points):
 * median age 6.3d, median factor 0.811, and ZERO points below exp(-1). So on today's
 * corpus this is a BOUNDED DEMOTION below the whole dated cohort, not neutrality — the
 * change is directionally right at any factor < 1, but the size must be re-decided against
 * a re-measured age distribution before decay is enabled in production. That distribution
 * is currently transient (the write-side stamp is younger than the spread it produced), so
 * calibrating to today's 0.811 would fit doc-rewrite recency rather than corpus age.
 *
 * SCOPE OF THE "DEMOTION" CLAIM: it holds on the positive half-line. A NEGATIVE score
 * would be moved toward zero, i.e. promoted — a property inherited symmetrically from the
 * dated branch's own `(r.score || 1) * factor`, which is left byte-identical here.
 * Unreachable in practice: embedding cosines against real text are positive, and the
 * bouncer's absolute gate already assumes a positive range.
 */
export const UNDATED_EFOLDINGS = 1;
export const UNDATED_FACTOR = Math.exp(-UNDATED_EFOLDINGS);   // 0.36787944117144233

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
 * **`valid_from` ONLY — `createdAt` is deliberately NOT consulted** (spec D-h).
 *
 * MECHANISM CORRECTED 2026-08-05 — the conclusion stands, the old reason did not.
 * This comment used to say "a reindex rebuilds through `umAdd`, so `createdAt` is
 * bulk-arrival time". That is FALSE, and it was measured: of the points carrying both
 * fields, 77 join a pre-reindex archive by hash and their archived `createdAt` matches
 * their `valid_from` EXACTLY — delta 0, 100%, median and p90 both 0.000 days. The
 * 2026-07-28 reindex did not destroy `createdAt`; surviving points kept their originals.
 *
 * The accurate statement:
 *
 *   `createdAt` is genuine WRITE time. It is uninformative precisely where a bulk
 *   operation wrote many points at one instant — which happens to be 164 of the 186
 *   undated points (104 post-purge re-extraction on one day, 60 mem0 imports).
 *
 * Measured on the live corpus 2026-08-05: 401 points, 215 dated, **186 undated (46.4%)**.
 * Grading on `createdAt` would rank nearly half the corpus by which bulk operation it
 * arrived in — strictly worse than not grading on it, which is what this function
 * guarantees by returning null.
 *
 * Why this matters enough to correct rather than leave: a wrong-but-load-bearing
 * rationale is how the next person reaches the wrong conclusion. Someone who believed
 * the reindex destroyed `createdAt` would also believe restoring it is a backfill they
 * could perform. It is not — no event time is recoverable for 164 of those 186 points
 * from any surviving source (a perfect `createdAt` backfill reaches 22/186, 11.8%).
 *
 * "No resolvable date" is NOT the same as "no penalty": applyTemporalDecay imputes a
 * flat factor for such items (UNDATED_FACTOR). That is a decision made downstream of
 * this function; resolveItemDate's only job is to refuse the arrival stamp.
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
 * Is `v` a value the write path may persist as `valid_from`?
 *
 * Deliberately STRICTER than `resolveItemDate`, and the asymmetry is the point:
 *   accept(isUsableDate) ⊆ resolvable(resolveItemDate)
 * Everything the writer preserves is readable; never the reverse.
 *
 * `typeof v === 'string'` is necessary but not sufficient for the OpenAPI
 * contract (`openapi.mjs:174` declares `date-time`, so a parseable non-ISO
 * string like 'March 3, 2026' passes here while still not being a date-time).
 * It excludes the `true` / `1` trap, both of which resolveItemDate WOULD
 * resolve — to 1970-01-01T00:00:00.001Z, a silently wrong real date.
 *
 * Lives here, not in add.mjs, because its entire contract is "what
 * resolveItemDate can resolve"; co-locating them is what stops the two
 * drifting. Pinned by VF-SUB; RC6 and RC7 cover both drift directions.
 *
 * @returns {boolean}
 */
export function isUsableDate(v) {
  return typeof v === 'string' && Number.isFinite(new Date(v).getTime());
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
 * @param {number}        halfLifeDays - Decay timescale in days (an e-folding time, not a half-life).
 * @returns {Array<object>} New array sorted by decayed score descending.
 *                          Input array and its items are NOT mutated.
 */
export function applyTemporalDecay(results, halfLifeDays) {
  const now = Date.now();
  const decayed = results.map((r) => {
    const ms = resolveItemDate(r);
    if (ms === null) {
      // No resolvable date — impute one decay timescale (see UNDATED_FACTOR).
      // GUARD: never MINT a score. `(r.score || 1) * f` would give a score-less item a
      // score and lift it from last place to first, and would turn a genuine `score: 0`
      // into `1 * f` — an item scoring 0.0 outranking one scoring 0.1. Both invert
      // ordering in the exact direction this policy exists to correct. Multiplying a
      // numeric 0 yields 0, which is right.
      if (typeof r.score !== 'number') return { ...r };
      return { ...r, score: r.score * UNDATED_FACTOR };
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
