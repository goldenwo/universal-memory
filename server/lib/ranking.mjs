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
 * The undated cohort's factor is now a function of CONFIGURATION ONLY (spec §3, the joint
 * policy): when the window is active and UM_TEMPORAL_DECAY is enabled, applyTemporalWindow
 * imputes the SAME UNDATED_FACTOR decay uses (0.7788) — not an independently-tuned window
 * constant. When decay is disabled the window leaves undated results untouched, today's
 * behaviour, byte-identical. Three call-site paths, one factor per configuration (§4.2):
 *   1. window resolves, ≥1 in-window candidate → window re-rank: 0.7788 (decay on) / 1.0
 *      (decay off);
 *   2. window resolves, 0 in-window → falls through to the decay arm: 0.7788 (decay on) /
 *      1.0, no re-rank (decay off);
 *   3. no window (incl. parser fail-open) → decay arm, same as 2.
 * Phrasing moves a query between rows; pool composition and `limit` move it between rows 1
 * and 2 — none of the three changes the factor anymore (resolves #237). Measured, not
 * inferred — see UNDATED_FACTOR.
 * The window imputes decay's exact constant, not its own: any other value reproduces the
 * per-query factor flip at smaller magnitude — equality is the only fixed point. It imputes
 * conditionally (only when decay is enabled) because an unconditional demotion would spend
 * recall in configurations where no inconsistency exists.
 * The DATED cohort's treatment still diverges between the two paths, unchanged and
 * deliberate (§1.3): in-window dated items keep factor 1.0 under the window re-rank but
 * decay by exp(-age/H) under decay — a window is query-expressed intent and overrides
 * recency; out of scope here.
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
 * limit=5 and 0.779x at limit=10.
 *
 * ⚠ SCOPE OF THAT CLAIM — it is a property of THIS FUNCTION, not of the system, and an
 * earlier version of this comment overstated it. `doSearch` chooses between the two
 * re-rankers on `temporalActive` (a window parsed AND at least one candidate dated-and-
 * in-window), so with UM_TEMPORAL_QUERY also enabled the *choice* is set-dependent even
 * though this function is not. Measured end-to-end with both flags on (2026-08-07, at the
 * pre-retune UNDATED_EFOLDINGS = 1): the same undated point on the same query scored 0.80
 * (factor 1.000) when the pool held a dated in-window candidate and 0.294 (factor 0.368)
 * when it did not — and because the window path widens the fetch, the literal limit=5 vs
 * limit=10 case above reproduces, with the factors the other way round. At that constant, the
 * retune to 0.25 would only have narrowed the flip (1.000 vs 0.779), not removed it — this
 * function alone was set-independent, the pair was not.
 *
 * That cross-pair flip is now resolved (#237): `applyTemporalWindow` imputes this same
 * constant on its own undated branch when decay is enabled — see the module header and its
 * `undatedFactor` opt for the mechanism.
 *
 * Deliberately NOT an env knob: this module is pure and takes `halfLifeDays` as a
 * parameter. The feature already has a kill switch (UM_TEMPORAL_DECAY), and a knob's only
 * distinct capability would be "decay on, undated at 1.0" — i.e. re-enabling the defect.
 *
 * MAGNITUDE — RETUNED 1 → 0.25 (2026-08-07), still re-decided at flip time. Measured on
 * the live corpus (2026-08-05, 215 dated points): median age 6.3d, median factor 0.811,
 * ZERO points below exp(-1) — one e-folding demoted undated points below the WHOLE dated
 * cohort. The before-arm capture (eval/results/2026-08-07-undated-arm-run{1,2}.json) then
 * measured gold headroom at median 2.41x / min 1.42x against exp(-1)'s 2.72x demotion:
 * 16 of 24 undated golds had less headroom than the policy applied, projecting the
 * after-arm gate G2 near 0.33 against a floor near 0.94 — the policy would have failed
 * its own recall-safety gate. E = 0.25 sits above the live median imputed age
 * (−ln(0.811) ≈ 0.21 e-foldings, so undated still ranks below the typical dated point)
 * and below the all-golds-survive bound (ln(1.4247) ≈ 0.354), with margin for the ~1-2%
 * run-to-run score drift the doubled capture showed. The size must STILL be re-decided
 * against a re-measured age distribution before decay is enabled in production (the
 * flip-precondition issue): today's distribution is transient (the write-side stamp is
 * younger than the spread it produced), so any constant chosen now — including this one —
 * is calibrated against doc-rewrite recency, not corpus age.
 *
 * SCOPE OF THE "DEMOTION" CLAIM: it holds on the positive half-line. A NEGATIVE score
 * would be moved toward zero, i.e. promoted — a property inherited symmetrically from the
 * dated branch's own `(r.score || 1) * factor`, which is left byte-identical here.
 * Unreachable in practice: embedding cosines against real text are positive, and the
 * bouncer's absolute gate already assumes a positive range.
 */
export const UNDATED_EFOLDINGS = 0.25;
export const UNDATED_FACTOR = Math.exp(-UNDATED_EFOLDINGS);   // 0.7788007830714049

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
      // No resolvable date — impute a fixed fraction of the decay timescale (see UNDATED_FACTOR).
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
 *   no resolvable date      → unchanged when `undatedFactor` is omitted/1; × undatedFactor
 *                              otherwise (the joint policy — see the module header)
 *
 * Out-of-window items are demoted, never dropped — matching UM's recall-safety
 * house rule and mem0's "additive, never filters out" posture.
 *
 * @param {Array<object>} results
 * @param {{start:number,end:number}} window
 * @param {{falloffDays?:number, inWindowCount?:number, undatedFactor?:number}} [opts] - `= {}`
 *   default is load-bearing: the production call site passes two arguments and a bare
 *   destructure would throw, which the parser's fail-open wrapper does not cover.
 */
export function applyTemporalWindow(results, window, { falloffDays, inWindowCount, undatedFactor } = {}) {
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
  // DJ-4 (D-b3 self-validation, extended): a degenerate undatedFactor must not become a
  // hard filter (0 => silent drop of every undated point) or an inflation (>1 — the #238
  // defect shape). Anything outside (0, 1] falls back to 1, today's behaviour.
  const uf = Number.isFinite(undatedFactor) && undatedFactor > 0 && undatedFactor <= 1
    ? undatedFactor
    : 1;

  const ranked = results.map((r) => {
    const ms = resolveItemDate(r);
    if (ms === null) {
      // Never mint a score (decay policy §4.3 adopted): score-less items stay score-less
      // and sort last; a numeric 0 stays 0. As with UNDATED_FACTOR's own comment, the
      // "demotion" claim is scoped to positive scores — a negative score moves toward
      // zero; unreachable in practice, present in JV1's property domain.
      if (uf === 1 || typeof r.score !== 'number') return { ...r };
      return { ...r, score: r.score * uf };
    }
    // Known, deliberately kept: resolveItemDate runs again inside isInWindow — deferred, not hoisted (spec §4.1).
    if (isInWindow(r, window)) return { ...r };
    const dEdge = ms < window.start ? window.start - ms : ms - window.end;
    const factor = Math.max(Math.exp(-(dEdge / DAY_MS) / falloff), DEMOTION_FLOOR);
    return { ...r, score: (r.score || 1) * factor };
  });

  ranked.sort((a, b) => (b.score || 0) - (a.score || 0));
  return ranked;
}
