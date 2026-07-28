// server/lib/control-page.mjs — U4a+U4b (#171 Stage B, spec §4/§5/§6): the
// authenticated `/control` document.
//
// A PURE function: a buildStats() payload object in, an HTML string out. No
// env reads, no clock reads, no I/O — the caller (U5, inside the routes'
// authenticated branch) resolves the payload, the per-request nonce and the
// CSRF token and passes all three. That purity is what lets every acceptance
// case in server/test/control-page.test.mjs be a plain object literal, and it
// is what keeps the A1 ordering guarantee auditable: this module cannot read a
// data source even by accident.
//
// SECURITY POSTURE (spec §5 C1 / §6 / A11):
//   • EVERY interpolation — KEY and value alike — goes through `t()`, which is
//     `esc(stripBidiControls(x))`. `capture` is keyed by the untrusted
//     X-UM-Source surface string, so a template that escaped values but
//     interpolated keys raw would still be injectable.
//   • SINK ALLOWLIST: untrusted data reaches ELEMENT TEXT ONLY. Not one
//     attribute value on this page carries payload-derived data (the only
//     interpolated attributes are the server-generated nonce and CSRF token),
//     which is strictly stronger than "escaped into a quoted attribute".
//   • Zero `<script>`, zero `on*=` handlers, zero `style=` attributes (the CSP
//     nonce covers `<style>` BLOCKS, never inline style attributes), zero
//     off-origin references. The only URLs are `/favicon.svg`, `/control` and
//     `/control/logout`.
//   • The inline `<style>` body is a compile-time constant; the ONLY thing
//     interpolated into the head's style element is the caller's nonce.
//
// EMPTY STATES (spec §5 C4): every branch that could render a missing value
// runs BEFORE the escaper — `esc(null)` is `''`, which would make "absent" and
// "zero" look alike, erasing exactly the distinction this page exists to show.
// Absent renders as an em dash; "cannot assess" is grey; a real zero is a zero.
//
// U4a landed the shell, the shared helpers and the freshness tile. U4b adds
// the pipeline, corpus, growth and recall tiles, in the §4 priority order.

import { esc, stripBidiControls } from './escape-html.mjs';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * The brand lockup, defined ONCE (spec §6 / R1 N5 — the arc's one-helper-many-
 * callers posture applies to markup too). Any other server-rendered page that
 * wants the lockup imports it from here rather than pasting a second copy that
 * can drift.
 */
export const BRAND_LOCKUP_SVG = `<svg data-brand="um-lockup" width="34" height="34" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path d="M16 12 v22 a15 15 0 0 0 30 0 v-8 a8 8 0 0 0 -13 -6" stroke="#5b5bd6" stroke-width="6" stroke-linecap="round"/>
      </svg>`;

/**
 * The `.brand`/`.brand-name`/`.brand-sub` trio, single-sourced as a FUNCTION
 * rather than a fixed string (spec §6 / R1 N5 — same one-helper-many-callers
 * posture as the lockup above) because `.brand`'s `margin-bottom` is the one
 * property that legitimately differs between this page (`0.5rem` — tiles
 * need a tighter gap) and `oauth/consent.mjs` (`1rem` — a single-form card).
 * Parameterizing that one value is what lets BOTH pages import the SAME rule
 * text instead of one of them keeping a hand-pasted fork that can silently
 * drift; `.brand-name`/`.brand-sub` never vary and are pinned identical
 * across both pages by a test. `test/consent-snapshot.test.mjs`'s
 * byte-for-byte pin against a pre-extraction golden fixture keeps
 * `brandCss('1rem')`'s call site honest.
 */
export function brandCss(marginBottom = '0.5rem') {
  return `.brand { display: flex; align-items: center; gap: 10px; margin-bottom: ${marginBottom}; }
    .brand-name { font-weight: 650; font-size: 1.15rem; letter-spacing: -0.02em; }
    .brand-sub { color: #656d76; font-weight: 400; }`;
}

/**
 * The freshness threshold used when the payload carries none — the SAME
 * old-server fallback `um-alert.sh`'s python block applies (`:190`). In-process
 * the payload always supplies `capture_freshness_threshold_hours` (buildStats
 * emits it unconditionally), so this is defensive only; it exists so the A12
 * cross-check agrees with the cron script on a threshold-less payload too,
 * rather than silently reddening the tile over a `NaN` comparison.
 */
export const FRESHNESS_FALLBACK_HOURS = 26;

/** Rendered where a value is ABSENT — never an empty cell that reads like 0. */
const EMPTY = '—';

/** The three-valued honesty um-alert.sh encodes, in page colours (spec §5 C4). */
const VERDICT_STATE = Object.freeze({ FRESH: 'green', STALE: 'red', ERROR: 'grey' });

// ---------------------------------------------------------------------------
// Interpolation helpers — the ONLY way payload data enters the template
// ---------------------------------------------------------------------------

/**
 * Strip-then-escape. Order matters: entity escaping does nothing to a bidi
 * override or a C0 control, and those can visually reorder adjacent cells so a
 * stale surface reads fresh (spec §5 C1 / R1 S-N4).
 */
function t(v) {
  return esc(stripBidiControls(v));
}

/** Empty-state-aware text: absent ⇒ em dash, present ⇒ escaped (incl. `0`). */
function cell(v) {
  return v === null || v === undefined ? EMPTY : t(v);
}

/**
 * Python `float()` semantics, for the fields the cron script coerces the same
 * way — the A12 agreement is only as good as this coercion.
 *
 * Returns the value python's `float()` WOULD produce (possibly `Infinity`,
 * `-Infinity` or `NaN` — those are values, not failures), or `null` exactly
 * where python would raise `TypeError`/`ValueError`. Callers that need a
 * displayable/arithmetic number re-check `Number.isFinite`.
 *
 * `Number()` is NOT that function. Every row below is a measured divergence
 * (verified against this repo's python), and each one flips a verdict:
 *
 *   input        python float()   bare Number()   consequence if unfixed
 *   ''           raises           0               a blank field reads FRESH
 *   '0x10'       raises           16              a hex string reads FRESH
 *   '0b101'      raises           5                    ″
 *   '0o17'       raises           15                   ″
 *   'inf'        inf              NaN             cron STALE, page ERROR
 *   'Infinity'   inf              Infinity        (rejected by the old
 *                                                  isFinite guard) same
 *   'nan'/'NaN'  nan              NaN             cron STALE, page ERROR
 *   '1_0'        10.0             NaN             cron FRESH, page ERROR
 *
 * RESIDUAL, deliberately not mirrored: python's `float()` accepts any Unicode
 * decimal digit (category Nd), e.g. the fullwidth `'１'` → 1.0, while JS
 * `Number()` does not. `String.normalize('NFKC')` is NOT a fix — it would also
 * make JS accept `'¹'` (category No), which python REJECTS, i.e. it trades a
 * safe divergence for an unsafe one. The residual therefore stands, and it
 * stands on the SAFE side: the page renders ERROR/grey where cron may compute a
 * real number, so the page can be more alarming than cron, never less. It is
 * also unreachable in-process — `readCounterStats` produces JS numbers, so a
 * STRING freshness value cannot occur on the real payload at all.
 */

// python's float grammar, ASCII subset: digits may carry single underscores
// between digits (PEP 515), the point may lead or trail, and the exponent is
// optional — but at least one digit is required, so a bare '.' is rejected.
const PY_DIGITS = '\\d(?:_?\\d)*';
const PY_NUMBER_RE = new RegExp(
  `^[+-]?(?:${PY_DIGITS}(?:\\.(?:${PY_DIGITS})?)?|\\.${PY_DIGITS})(?:[eE][+-]?${PY_DIGITS})?$`,
);
const PY_SPECIAL_RE = /^([+-]?)(inf(?:inity)?|nan)$/i;

function pyFloat(v) {
  // An actual float never raises in python — float(inf) is inf, float(nan) is
  // nan. JSON cannot carry either, but the mirror must be faithful anyway.
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0; // python bool is an int subclass
  if (typeof v !== 'string') return null;       // null/undefined/object/array
  const s = v.trim();
  const special = PY_SPECIAL_RE.exec(s);
  if (special) {
    if (special[2].toLowerCase() === 'nan') return NaN;
    return special[1] === '-' ? -Infinity : Infinity;
  }
  if (!PY_NUMBER_RE.test(s)) return null;
  return Number(s.replace(/_/g, ''));
}

/**
 * Threshold precedence, mirroring `um-alert.sh`'s python (`:186-193`):
 * absent ⇒ the 26h old-server fallback; malformed ⇒ the same fallback (never a
 * crash, never a NaN comparison); a deliberate `0` survives (`is None`, not
 * truthiness — a `|| 26` here would page the operator permanently).
 */
function resolveThresholdHours(raw) {
  if (raw === null || raw === undefined) return FRESHNESS_FALLBACK_HOURS;
  const n = pyFloat(raw);
  return n === null ? FRESHNESS_FALLBACK_HOURS : n;
}

function verdictResult(verdict, reason, threshold, best = null) {
  return {
    verdict,
    state: VERDICT_STATE[verdict],
    reason,
    threshold,
    surface: best?.surface ?? null,
    hours: best?.hours ?? null,
    lastDaySeen: best?.lastDaySeen ?? null,
  };
}

// ---------------------------------------------------------------------------
// captureVerdict — the aggregate "cron verdict" (spec §4 / A12 / A17)
// ---------------------------------------------------------------------------

/**
 * The page's half of the page↔cron agreement: the SAME `min()` quantifier and
 * the SAME three-verdict taxonomy `um-alert.sh`'s python block computes for a
 * default (no `--surface`) invocation, over the SAME payload fields.
 *
 * PURE and exported precisely so the agreement can be a regression TEST rather
 * than a manual run: server/test/control-page.test.mjs (A12) feeds identical
 * JSON fixtures to this function and to the shipped script, and asserts
 * verdict ≡ exit code for every one.
 *
 * The mapping the cron script defines (`um-alert.sh:195-226`), preserved here
 * branch for branch:
 *   capture null/absent      → ERROR (exit 2) — degraded, cannot assess
 *   capture not an object    → ERROR (exit 2) — unexpected shape
 *   capture {}               → STALE (exit 1) — has never written
 *   min(freshness) ≤ thr     → FRESH (exit 0)
 *   min(freshness) > thr     → STALE (exit 1)
 *   any unusable freshness   → ERROR (exit 2) — python's min(key=float) raises
 *
 * That last row is easy to get wrong by "skipping" the bad surface: the cron
 * script raises on the FIRST unusable value it touches, so a page that quietly
 * ignored it could read green while cron exits 2.
 *
 * `--surface`-scoped cron invocations are explicitly OUT of this contract
 * (spec §4, R2-C-I7); the per-surface rows the tile renders are what a
 * `--surface` operator reconciles against.
 *
 * TIE-BREAK CAVEAT (affects the reported NAME only, never the verdict): python
 * dicts iterate in true insertion order, `Object.keys` does NOT — integer-like
 * keys are hoisted ahead of string keys in ascending numeric order. A surface
 * literally named `'7'` is therefore visited before its neighbours here but
 * not there, so on an EXACT freshness tie the two sides can name different
 * "freshest" surfaces. Both still compare the same minimum against the same
 * threshold, so FRESH/STALE/ERROR — the thing A12 asserts — is unaffected.
 *
 * @param {object|null|undefined} capture - the payload's `capture` section.
 * @param {number|string|null|undefined} threshold - the payload's
 *   `capture_freshness_threshold_hours` (single source; see resolveThresholdHours).
 * @returns {{verdict:'FRESH'|'STALE'|'ERROR', state:'green'|'red'|'grey',
 *   reason:string, threshold:number, surface:string|null, hours:number|null,
 *   lastDaySeen:string|null}}
 */
export function captureVerdict(capture, threshold) {
  const max = resolveThresholdHours(threshold);
  if (capture === null || capture === undefined) return verdictResult('ERROR', 'counters-unavailable', max);
  if (typeof capture !== 'object' || Array.isArray(capture)) return verdictResult('ERROR', 'bad-shape', max);

  const surfaces = Object.keys(capture);
  if (surfaces.length === 0) return verdictResult('STALE', 'never-written', max);

  let best = null;
  for (const name of surfaces) {
    const info = capture[name];
    const hours = info !== null && typeof info === 'object' ? pyFloat(info.freshness_hours) : null;
    if (hours === null) return verdictResult('ERROR', 'bad-freshness', max);
    // Strictly-less keeps the FIRST minimum on a tie, matching CPython's min()
    // (which replaces the incumbent only on a strictly smaller key) — over a
    // key order that can differ, see the TIE-BREAK CAVEAT above. NaN compares
    // false against everything in BOTH languages, so a NaN key behaves
    // identically here and there.
    if (best === null || hours < best.hours) {
      best = { surface: name, hours, lastDaySeen: info.last_day_seen ?? null };
    }
  }
  return best.hours <= max
    ? verdictResult('FRESH', 'within-threshold', max, best)
    : verdictResult('STALE', 'over-threshold', max, best);
}

// ---------------------------------------------------------------------------
// Per-surface colour — STRICTER than the cron verdict, by design
// ---------------------------------------------------------------------------

/**
 * `stored + deduped + superseded` over the 7-day window, or null when the
 * counts are not all readable (in which case the "landing nothing" rule is
 * skipped rather than guessed — an unassessable row must not be reddened).
 *
 * `deduped`/`superseded` COUNT as landing: a dedup hit reached the vault
 * end-to-end and proves the pipeline alive, so `stored === 0` alone would
 * false-alarm an all-dedup week (spec §4 Δ07-28 Δ2 / A23).
 */
function landedCount(outcomes) {
  if (outcomes === null || typeof outcomes !== 'object' || Array.isArray(outcomes)) return null;
  let sum = 0;
  for (const key of ['stored', 'deduped', 'superseded']) {
    const n = pyFloat(outcomes[key]);
    // Non-finite is as unassessable as absent: a NaN would poison the sum into
    // a silent "not zero" and quietly disarm the rule.
    if (n === null || !Number.isFinite(n)) return null;
    sum += n;
  }
  return sum;
}

/**
 * Clock skew (spec §4 / R1 N7): `freshnessHours` clamps negatives to 0, so a
 * future `last_day_seen` renders bright green. Detect it from the payload's own
 * `generated_at` — comparing two `YYYY-MM-DD` prefixes lexicographically, which
 * is correct for ISO dates and keeps this module clock-free.
 */
function isFutureDay(lastDaySeen, generatedAt) {
  if (typeof lastDaySeen !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastDaySeen)) return false;
  if (typeof generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(generatedAt)) return false;
  return lastDaySeen > generatedAt.slice(0, 10);
}

/**
 * The per-surface predicate. STRICTER than captureVerdict on purpose: the cron
 * `min()` cannot see a surface that is active-but-landing-nothing (carry-forward
 * #4), so the page shows what cron would say AND what cron cannot see.
 *
 * Order is load-bearing:
 *   1. writes off  — capture CANNOT land, so a red would be unexplained.
 *   2. unusable freshness — grey, "cannot assess"; never green by default.
 *   3. stale — the original alarm; it OWNS the row so the operator is told the
 *      one thing to fix (a stale surface trivially has nothing landing too).
 *   4. landing nothing — fresh events arriving, none reaching the vault.
 *   5. fresh.
 */
function surfaceStatus(info, thresholdHours, writesEnabled) {
  if (writesEnabled === false) return { state: 'grey', words: 'capture disabled (writes off)' };
  const hours = info !== null && typeof info === 'object' ? pyFloat(info.freshness_hours) : null;
  // NaN is grouped with "unparseable" here, NOT left to fall through: every
  // NaN comparison is false, so `hours > threshold` would be false and the row
  // would slide into the green branch — the one direction this page must never
  // take (cron calls a NaN freshness STALE).
  if (hours === null || Number.isNaN(hours)) {
    return { state: 'grey', words: 'cannot assess — no usable freshness value' };
  }
  // A non-finite threshold (NaN, or +-Infinity) makes the per-surface `>`
  // comparison below just as unreliable as it makes the aggregate's `<=`:
  // `hours > NaN` is ALWAYS false, so without this guard a NaN-thresholded
  // surface would slide straight into "fresh" while captureVerdict's `<=`
  // (also always false against NaN) calls the SAME payload STALE — a green
  // row under a red aggregate banner. Treat any non-finite threshold as
  // cannot-assess instead of guessing a colour the aggregate does not agree
  // with (carried in from U4a's re-review).
  if (!Number.isFinite(thresholdHours)) {
    return { state: 'grey', words: 'cannot assess — the freshness threshold is unusable' };
  }
  if (hours > thresholdHours) return { state: 'red', words: `stale — no capture within ${t(thresholdHours)}h` };
  const landed = landedCount(info.outcomes_7d);
  if (landed === 0) return { state: 'red', words: 'active but landing nothing' };
  return { state: 'green', words: 'fresh' };
}

// ---------------------------------------------------------------------------
// Shape guards — U4b's tiles repeat "is this a plain, non-array object" often
// enough (corpus, points_by_project, recall, latency_since_boot, a surface's
// outcomes_7d…) that a shared helper beats five slightly-different inline
// checks drifting apart. `null`/`undefined`/an array/a primitive all fall to
// `null` — every caller below already treats "malformed" the same as
// "absent" (C4: a defined empty state, never a crash on the wrong shape).
// ---------------------------------------------------------------------------

function asPlainObject(v) {
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatUptime(seconds) {
  const s = pyFloat(seconds);
  // pyFloat may hand back Infinity/NaN (python float() does too) — neither is
  // a duration, and Math.floor(Infinity) would render "Infinityd Infinityh".
  if (s === null || !Number.isFinite(s) || s < 0) return null;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

// STATIC (A24): one sentence, no branch keyed on any surface NAME. A one-shot
// backfill surface goes red and stays red by design; naming the surfaces that
// behave that way would put an operator-specific allowlist in the template.
const ONE_SHOT_LEGEND =
  'One-shot surfaces — backfills, verification runs, anything that captures once and stops — '
  + 'go red here and stay red by design. Per-surface rows are informational; the aggregate cron '
  + 'verdict above is the alarm.';

const VERDICT_QUANTIFIER_NOTE =
  'Aggregate quantifier: min() freshness across every surface — the same predicate the '
  + 'um-alert.sh cron check applies, so this line cannot read green while cron pages you. '
  + 'The per-surface colours below are stricter and are not part of that verdict.';

/**
 * The three ways an ERROR verdict can arise, each with its own DIAGNOSIS.
 * captureVerdict already distinguishes them, and they call for different
 * operator actions — "the counters are unavailable" is factually wrong when
 * the counters are live and one surface reports a garbage number. Keyed here
 * so the aggregate line and the tile banner cannot drift apart.
 */
const ERROR_DIAGNOSIS = Object.freeze({
  'counters-unavailable': {
    line: 'the capture counters are unavailable, so freshness cannot be assessed',
    banner: 'the capture counters are unavailable, so no surface can be checked',
  },
  'bad-shape': {
    line: 'the capture section is malformed (it is not an object), so freshness cannot be assessed',
    banner: 'the capture section is malformed (it is not an object), so no surface can be checked',
  },
  'bad-freshness': {
    line: 'a surface reports an unusable freshness value — see the rows below',
    banner: 'a surface reports an unusable freshness value, so the aggregate cannot be computed',
  },
});

const UNKNOWN_DIAGNOSIS = {
  line: 'freshness cannot be assessed',
  banner: 'freshness cannot be assessed',
};

function errorDiagnosis(reason) {
  return ERROR_DIAGNOSIS[reason] ?? UNKNOWN_DIAGNOSIS;
}

// Returns a STRING THAT IS ALREADY ESCAPED — every payload-derived part goes
// through t()/cell() here, so the caller interpolates it into element text
// without re-escaping (double-escaping would render `&amp;lt;` to the operator).
function verdictLine(v) {
  if (v.verdict === 'ERROR') {
    return `Cron verdict: cannot assess — ${errorDiagnosis(v.reason).line}. um-alert.sh would exit 2.`;
  }
  if (v.reason === 'never-written') {
    return 'Cron verdict: STALE — capture has never written on any surface. um-alert.sh would exit 1.';
  }
  const where = `freshest surface ${t(v.surface)}, last captured ${cell(v.lastDaySeen)} (${t(v.hours)}h ago)`;
  return v.verdict === 'FRESH'
    ? `Cron verdict: FRESH — ${where}, within the ${t(v.threshold)}h threshold. um-alert.sh would exit 0.`
    : `Cron verdict: STALE — no surface captured within ${t(v.threshold)}h; ${where}. um-alert.sh would exit 1.`;
}

function freshnessRows(capture, thresholdHours, writesEnabled, generatedAt) {
  return Object.keys(capture).map((name) => {
    const info = capture[name];
    const status = surfaceStatus(info, thresholdHours, writesEnabled);
    const raw = info !== null && typeof info === 'object' ? info : {};
    // Empty-state BEFORE the escaper: an unusable freshness must not render as
    // a bare "h" that reads like zero hours. A value python WOULD parse but
    // that is not a duration (inf/nan) renders verbatim WITHOUT the unit —
    // "infh" would be nonsense, and hiding it would hide why the row is grey.
    const parsedHours = pyFloat(raw.freshness_hours);
    const hours = parsedHours === null
      ? EMPTY
      : (Number.isFinite(parsedHours) ? `${t(raw.freshness_hours)}h` : t(raw.freshness_hours));
    const skew = isFutureDay(raw.last_day_seen, generatedAt)
      ? ' <span class="note">future timestamp (clock skew?)</span>'
      : '';
    // `status.words` and `hours`/`skew` are built ABOVE from module literals
    // plus already-escaped payload values — the only raw-looking `${}` on this
    // page, and deliberately so. Anything new added to them must go through
    // `t()` at construction, exactly as the threshold does in surfaceStatus.
    return `        <tr>
          <th scope="row">${t(name)}</th>
          <td class="s-${status.state}">${status.words}</td>
          <td>${hours}</td>
          <td>${cell(raw.last_day_seen)}${skew}</td>
          <td>${cell(raw.events_today)}</td>
          <td>${cell(raw.errors_today)}</td>
        </tr>`;
  }).join('\n');
}

function freshnessTile(stats) {
  const capture = stats.capture;
  const thresholdHours = resolveThresholdHours(stats.capture_freshness_threshold_hours);
  const writesEnabled = stats.server?.writes_enabled;
  const v = captureVerdict(capture, stats.capture_freshness_threshold_hours);

  const head = `      <h2>Capture freshness</h2>
      <p class="verdict s-${v.state}">${verdictLine(v)}</p>
      <p class="muted">${VERDICT_QUANTIFIER_NOTE}</p>`;

  // capture: null (or any non-object) — grey, "cannot assess". Distinct from
  // {} on purpose: "we cannot see" is not "nothing is landing". The banner
  // names WHICH failure it is (counters dark vs. a malformed section).
  if (capture === null || capture === undefined || typeof capture !== 'object' || Array.isArray(capture)) {
    return `    <section class="tile">
${head}
      <p class="banner s-grey">Cannot assess: ${errorDiagnosis(v.reason).banner}.</p>
    </section>`;
  }

  const names = Object.keys(capture);
  if (names.length === 0) {
    return `    <section class="tile">
${head}
      <p class="banner s-red">Capture has never written: the counters database is readable but holds no capture rows at all.</p>
    </section>`;
  }

  const disabled = writesEnabled === false
    ? '      <p class="banner s-grey">Capture is disabled (writes off): nothing can land until writes are re-enabled, '
      + 'so the per-surface rows below are reported as disabled rather than stale.</p>\n'
    : '';

  return `    <section class="tile">
${head}
${disabled}      <table>
        <thead>
          <tr>
            <th scope="col">Surface</th>
            <th scope="col">Status</th>
            <th scope="col">Freshness</th>
            <th scope="col">Last day seen (UTC)</th>
            <th scope="col">Events today</th>
            <th scope="col">Errors today</th>
          </tr>
        </thead>
        <tbody>
${freshnessRows(capture, thresholdHours, writesEnabled, stats.generated_at)}
        </tbody>
      </table>
      <p class="legend">${ONE_SHOT_LEGEND}</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Pipeline tile — "classified outcomes (7d)" (spec §4 Pipeline / A20)
// ---------------------------------------------------------------------------

// Fixed order + the five-outcome vocabulary `stats.mjs` always emits (see
// control-page.mjs's freshnessTile header note). NOT the same thing as
// A24's surface-name ban: these are OUTCOME names, module literals, never
// attacker-controlled — no branch here is keyed on a SURFACE name.
const OUTCOME_KEYS = Object.freeze(['stored', 'abstained', 'deduped', 'superseded', 'error']);

// Colour never the sole carrier (spec §6): every cell spells out its outcome
// NAME as text, so `error` is still legible without the red. `error` is the
// ONLY outcome that CAN get the error colour — `abstained` is a routine gate
// outcome (the #185 thin-transcript gate, #190's zero-turn skips), never a
// failure, and renders in the SAME plain/neutral style as stored/deduped/
// superseded. There is deliberately no "good" colour either: this tile has
// no residual to compare counts against (R2-C-I5), so nothing here claims a
// count is healthy, only that it is (or is not) an error.
//
// The red is further gated on the count itself: a HEALTHY deployment (0
// errors) must not render a red "error: 0" block — that would be color
// crying wolf on every render of a fine surface — and a malformed count
// (non-numeric, rendering as the raw text or an em dash) must not be
// error-coloured either, per this module's own empty-state contract
// (absent ⇒ em dash, unusable ⇒ grey "cannot assess" elsewhere, never a false
// red). `pyFloat` (not bare `Number`) so a string count from a hostile or
// out-of-band producer is judged by the SAME coercion rules as every other
// cron-adjacent number in this module.
function outcomeCell(name, value) {
  const text = `${name}: ${cell(value)}`;
  const n = pyFloat(value);
  const isRealError = name === 'error' && Number.isFinite(n) && n > 0;
  return isRealError ? `<td class="s-red">${text}</td>` : `<td>${text}</td>`;
}

function pipelineRows(capture) {
  return Object.keys(capture).map((name) => {
    const info = asPlainObject(capture[name]);
    const outcomes = info === null ? null : asPlainObject(info.outcomes_7d);
    const cells = OUTCOME_KEYS.map((k) => outcomeCell(k, outcomes === null ? undefined : outcomes[k])).join('\n          ');
    return `        <tr>
          <th scope="row">${t(name)}</th>
          ${cells}
        </tr>`;
  }).join('\n');
}

// The same two shape failures captureVerdict distinguishes (null/undefined
// vs. present-but-not-an-object) — deliberately reusing its `reason` values
// and errorDiagnosis() banners rather than a fresh "counters are unavailable"
// string that would be a WRONG diagnosis for a malformed (e.g. array) shape,
// exactly the class of bug fix-round-1 already fixed once for the freshness
// tile's own banner. Returns `null` when the shape is fine to iterate.
function captureShapeReason(capture) {
  if (capture === null || capture === undefined) return 'counters-unavailable';
  if (typeof capture !== 'object' || Array.isArray(capture)) return 'bad-shape';
  return null;
}

/**
 * `outcomes_7d` per surface, labelled "classified outcomes (7d)" — NOT
 * "events (7d)": there is no `events_7d` in the payload (a surface object
 * carries only the 1-day `events_today` scalar and the 7-day `outcomes_7d`
 * sum), so an "unlabelled residual" column would subtract across two
 * different windows and can go negative. No residual is rendered (A20).
 *
 * Shares its `capture` guard shape with freshnessTile (null/malformed ⇒
 * cannot-assess, `{}` ⇒ never-written) because it reads the SAME `capture`
 * section — just a second projection of it, not a second data source.
 */
function pipelineTile(stats) {
  const capture = stats.capture;
  const shapeReason = captureShapeReason(capture);
  if (shapeReason !== null) {
    return `    <section class="tile">
      <h2>Classified outcomes (7d)</h2>
      <p class="banner s-grey">Cannot assess: ${errorDiagnosis(shapeReason).banner}.</p>
    </section>`;
  }
  const names = Object.keys(capture);
  if (names.length === 0) {
    return `    <section class="tile">
      <h2>Classified outcomes (7d)</h2>
      <p class="banner s-red">Capture has never written: there is nothing to classify yet.</p>
    </section>`;
  }
  return `    <section class="tile">
      <h2>Classified outcomes (7d)</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Surface</th>
            <th scope="col">Stored</th>
            <th scope="col">Abstained</th>
            <th scope="col">Deduped</th>
            <th scope="col">Superseded</th>
            <th scope="col">Error</th>
          </tr>
        </thead>
        <tbody>
${pipelineRows(capture)}
        </tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Corpus tile (spec §4 Corpus / §5 C3)
// ---------------------------------------------------------------------------

// Two DIFFERENT ways a corpus tile can end up with nothing to render, and —
// mirroring pipelineTile's captureShapeReason — they get DIFFERENT banners so
// the operator is told the right thing: `corpus-unavailable` means qdrant
// itself could not be read (buildStats' own diagnosis); a null/malformed
// `corpus` section WITHOUT that flag is a shape problem in the payload
// itself (a hand-built or out-of-band producer), not a qdrant outage, and
// blaming qdrant for it would be as wrong as pipelineTile's old single
// "counters are unavailable" banner was for a merely-malformed `capture`.
function corpusBanner(reason) {
  return `    <section class="tile">
      <h2>Corpus</h2>
      <p class="banner s-grey">Cannot assess: ${reason}</p>
    </section>`;
}

/**
 * `degraded` includes `corpus-unavailable` ⇒ points / points_by_project /
 * scan_saturated render "cannot assess" REGARDLESS of their values — a
 * mid-loop throw in buildStats() leaves `points` a non-null number and
 * `points_by_project` a partial map, byte-shape-identical to a complete one,
 * so the FLAG (not a null-check) is the only authoritative signal here
 * (spec §5 C3, mirroring the same "flag over value" posture freshnessTile
 * already applies to `capture`).
 */
function corpusTile(stats) {
  const flags = Array.isArray(stats.degraded) ? stats.degraded : [];
  const unavailable = flags.includes('corpus-unavailable');
  const corpus = asPlainObject(stats.corpus);

  if (unavailable) {
    return corpusBanner('the corpus is unavailable (qdrant could not be read).');
  }
  if (corpus === null) {
    return corpusBanner('the corpus section is malformed (it is not an object), so corpus figures cannot be read.');
  }

  // `points` is NOT raw/unbounded: it saturates at FULL_SCAN_LIMIT. Whether
  // it is showing the true count or a silently-capped one can only be told
  // by the `scan_saturated` FLAG — `points === 10000` is not proof of
  // saturation (a single filtered system doc at the cap yields 9999) and the
  // cap literal is not itself in the payload, so it is never inferred here.
  const pointsCell = corpus.scan_saturated === true ? '≥ 10000 (scan cap)' : cell(corpus.points);

  const projectMap = asPlainObject(corpus.points_by_project);
  const byProject = projectMap === null ? null : Object.keys(projectMap);

  // The `(unknown)` fallback bucket (buildStats' catch-all for a point with
  // no readable `metadata.project`) renders as "unattributed" and visually
  // distinct — every OTHER bucket, including the operator-named `$HOME`
  // catch-all bucket (UM_HOME_PROJECT-configurable — its default value is
  // deliberately not spelled out here, A24), is a REAL project and needs no
  // branch of its own.
  const projectRows = byProject === null
    ? '        <tr><td colspan="2"><span class="s-grey">cannot assess — points_by_project is malformed</span></td></tr>'
    : (byProject.length === 0
      ? '        <tr><td colspan="2">no projects yet</td></tr>'
      : byProject.map((name) => {
        const isUnknown = name === '(unknown)';
        const label = isUnknown ? 'unattributed' : t(name);
        const cls = isUnknown ? ' class="unattributed"' : '';
        return `        <tr><th scope="row"${cls}>${label}</th><td>${cell(projectMap[name])}</td></tr>`;
      }).join('\n'));

  return `    <section class="tile">
      <h2>Corpus</h2>
      <table>
        <tbody>
          <tr><th scope="row">Points</th><td>${pointsCell}</td></tr>
        </tbody>
      </table>
      <table>
        <thead>
          <tr><th scope="col">Project</th><th scope="col">Points</th></tr>
        </thead>
        <tbody>
${projectRows}
        </tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Growth tile — TWO independent 7-day series (spec §4 Growth / §5 C2 / A9)
// ---------------------------------------------------------------------------

const GROWTH_EXTRACTION_ZERO_TEXT = '0 extractions in 7d';
const GROWTH_DOCS_ZERO_TEXT = '0 doc writes in 7d';

/**
 * Both series are zero-filled 7-day maps whenever the counters db is
 * readable, so `null`-only special-casing is NOT enough (a present, all-zero
 * series drew the exact flat line that produced the 2026-07-18 false
 * "nothing is landing" read). Three states, each with its own presentation:
 * `unavailable` (null/malformed ⇒ "cannot assess"), `zero` (present, sums to
 * 0 ⇒ its zero-text, sparkline suppressed), `live` (draws).
 *
 * A non-finite MEMBER value (a garbage day count from a malformed producer)
 * is treated the same as a malformed series as a WHOLE — 'unavailable', never
 * silently coerced to 0. Coercing it to 0 would let one bad day masquerade as
 * a legitimate "0 extractions in 7d" zero-text, which is exactly the
 * confident-false-zero this tile exists to prevent (same principle as the
 * freshness tile's own hours/threshold non-finite guards).
 */
function classifySeries(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'unavailable', days: [], values: [] };
  }
  const days = Object.keys(raw);
  const values = [];
  for (const d of days) {
    const n = Number(raw[d]);
    if (!Number.isFinite(n)) return { state: 'unavailable', days: [], values: [] };
    values.push(n);
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return { state: sum === 0 ? 'zero' : 'live', days, values };
}

// Server-side inline <svg>, NUMBERS ONLY reach it (spec §5 C1 / §6): every
// coordinate is computed here from the series' own numeric values via
// toFixed, never from an untrusted string — day KEYS never enter this
// function at all, only the values classifySeries already coerced to
// numbers. No charting library.
//
// Fewer than 2 points is suppressed, same reasoning as the zero-suppression
// above: a single-vertex "polyline" draws nothing visible while the markup
// still claims a live sparkline was rendered — a quieter false-zero cousin,
// not the honest "cannot assess"/zero-text this tile owes the reader.
function sparklineSvg(values) {
  if (values.length < 2) return '';
  const w = 180;
  const h = 36;
  const max = Math.max(1, ...values);
  const denom = values.length - 1;
  const points = values.map((v, i) => {
    const x = (i / denom) * w;
    const y = h - (Math.max(0, v) / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">
        <polyline points="${points}" fill="none" stroke="#5b5bd6" stroke-width="2"/>
      </svg>`;
}

// Day KEYS render ONLY as escaped text labels here, outside the <svg> above —
// they never reach the sparkline's numeric-only points attribute.
function dayList(days, values) {
  return days.map((d, i) => `<li>${t(d)}: ${t(values[i])}</li>`).join('');
}

function seriesBlock({ title, zeroText, seriesState, provenance }) {
  const heading = `      <h3>${t(title)}</h3>`;
  if (seriesState.state === 'unavailable') {
    return `${heading}
        <p class="s-grey">cannot assess</p>`;
  }
  if (seriesState.state === 'zero') {
    return `${heading}
        <p>${t(zeroText)}</p>`;
  }
  // `derived_from` is rendered verbatim ATTACHED TO THE EXTRACTION SERIES
  // ONLY (`provenance` is only ever passed for that call) — the payload
  // carries ONE provenance string; beside the doc series it would assert
  // false provenance for a checkpoint-derived series, which has its own
  // page label instead.
  const prov = provenance !== undefined ? `\n        <p class="muted">source: ${cell(provenance)}</p>` : '';
  return `${heading}
        ${sparklineSvg(seriesState.values)}
        <ul class="spark-days">${dayList(seriesState.days, seriesState.values)}</ul>${prov}`;
}

/**
 * `growth_7d`/`growth_docs_7d` sit under `corpus` in the payload but this
 * tile is governed by `counters-unavailable`, NOT by corpusTile's
 * `corpus-unavailable` blanking (spec §5 C2/§4 Δ07-28 Δ1): qdrant down with
 * counters healthy must leave both series live, so — unlike corpusTile —
 * nothing here consults `stats.degraded` at all; each series' own
 * null/zero/live state is read straight off the payload.
 */
function growthTile(stats) {
  const corpus = asPlainObject(stats.corpus) ?? {};
  const extraction = classifySeries(corpus.growth_7d);
  const docs = classifySeries(corpus.growth_docs_7d);

  return `    <section class="tile">
      <h2>Growth (7d)</h2>
      <div class="growth-grid">
        <div class="series">
${seriesBlock({
    title: 'Extraction growth (7d)',
    zeroText: GROWTH_EXTRACTION_ZERO_TEXT,
    seriesState: extraction,
    provenance: corpus.derived_from,
  })}
        </div>
        <div class="series">
${seriesBlock({
    title: 'Doc growth (7d) — session summaries/checkpoints',
    zeroText: GROWTH_DOCS_ZERO_TEXT,
    seriesState: docs,
  })}
        </div>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Recall tile (spec §4 Recall)
// ---------------------------------------------------------------------------

/**
 * `searches_today`/`searches_7d`, `p50_ms`/`p95_ms`/`n`, and the `label`
 * string verbatim. `searches_today`/`searches_7d` are `== null` (not
 * `!== 0`-guessed) in counters-degraded mode — rendered as "cannot assess",
 * never a bare 0, while `latency_since_boot` (the in-process ring) stays
 * live and independent of that degraded state.
 */
function recallTile(stats) {
  const recall = asPlainObject(stats.recall) ?? {};
  const latency = asPlainObject(recall.latency_since_boot) ?? {};

  const cannotAssess = '<span class="s-grey">cannot assess</span>';
  const searchesToday = recall.searches_today == null ? cannotAssess : t(recall.searches_today);
  const searches7d = recall.searches_7d == null ? cannotAssess : t(recall.searches_7d);

  // `p50_ms: null` with `n: 0` ⇒ "no searches since boot", never "0ms" — the
  // empty-state branch precedes the escaper, same as everywhere else in this
  // module (R1 S-N3).
  const noSearchesYet = (latency.p50_ms === null || latency.p50_ms === undefined) && latency.n === 0;
  const latencyBlock = noSearchesYet
    ? '      <p>no searches since boot</p>'
    : `      <table>
        <tbody>
          <tr><th scope="row">p50</th><td>${cell(latency.p50_ms)}</td></tr>
          <tr><th scope="row">p95</th><td>${cell(latency.p95_ms)}</td></tr>
          <tr><th scope="row">n</th><td>${cell(latency.n)}</td></tr>
        </tbody>
      </table>`;
  const labelLine = latency.label !== undefined ? `      <p class="muted">${cell(latency.label)}</p>` : '';

  return `    <section class="tile">
      <h2>Recall</h2>
      <table>
        <tbody>
          <tr><th scope="row">Searches today</th><td>${searchesToday}</td></tr>
          <tr><th scope="row">Searches (7d)</th><td>${searches7d}</td></tr>
        </tbody>
      </table>
${latencyBlock}
${labelLine}
    </section>`;
}

function degradedPresentation(degraded) {
  if (degraded === null || degraded === undefined) {
    return '<span class="s-green">healthy — every source reporting</span>';
  }
  if (!Array.isArray(degraded)) {
    return '<span class="s-grey">cannot assess — the degraded field is malformed (expected a list)</span>';
  }
  const flags = degraded.filter((d) => d !== null && d !== undefined);
  return flags.length === 0
    ? '<span class="s-green">healthy — every source reporting</span>'
    : `<span class="s-grey">${flags.map((d) => t(d)).join(', ')}</span>`;
}

function opsRow(stats) {
  const server = stats.server ?? {};
  const uptime = formatUptime(server.uptime_s);
  const writes = server.writes_enabled === true
    ? 'writes enabled'
    : (server.writes_enabled === false ? 'writes disabled' : EMPTY);
  // THREE-way, not two (a `!Array.isArray ? [] : …` would report a payload
  // carrying `degraded: "counters-unavailable"` as HEALTHY — announcing health
  // on the strength of a field it failed to understand is the one thing this
  // row must never do): absent ⇒ healthy, an array ⇒ its flags (empty ⇒
  // healthy), anything else ⇒ malformed, which is a cannot-assess, not a pass.
  const degradedCell = degradedPresentation(stats.degraded);

  // Spec §5 C3: recall's counters go null in counters-degraded mode while the
  // in-process latency ring stays live. The ops row owns that presentation —
  // "cannot assess", never a zero. (The recall TILE itself is U4b.)
  // A WHOLLY MISSING recall section is the same "cannot assess", not silence:
  // `{}.searches_today` is `undefined`, not `null`, so a null-only check would
  // have rendered nothing at all for a payload with no recall section.
  const recall = stats.recall;
  const recallDown = recall === null || typeof recall !== 'object' || Array.isArray(recall)
    || recall.searches_today == null || recall.searches_7d == null;
  const recallRow = recallDown
    ? `        <tr><th scope="row">Recall counters</th><td><span class="s-grey">cannot assess — search counters unavailable</span></td></tr>\n`
    : '';

  return `    <section class="tile">
      <h2>Server</h2>
      <table>
        <tbody>
          <tr><th scope="row">Version</th><td>${cell(server.version)}</td></tr>
          <tr><th scope="row">Uptime</th><td>${uptime === null ? EMPTY : t(uptime)}</td></tr>
          <tr><th scope="row">Writes</th><td>${writes === EMPTY ? EMPTY : t(writes)}</td></tr>
          <tr><th scope="row">Mount mode</th><td>${cell(server.mount_mode)}</td></tr>
          <tr><th scope="row">Stats schema</th><td>${cell(stats.schema_version)}</td></tr>
          <tr><th scope="row">Degraded sources</th><td>${degradedCell}</td></tr>
${recallRow}        </tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

// Compile-time constant, ZERO interpolation (the CSP nonce is an ATTRIBUTE on
// the element, not part of this body). Light-mode only — the repo has no
// prefers-color-scheme anywhere and a second theme is scope this arc skips.
// Wider than the 34rem unlock card: tiles need room.
const STYLE = `
    body { font-family: system-ui, sans-serif; max-width: 62rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; background: #ffffff; }
    ${brandCss('0.5rem')}
    h1 { font-size: 1.3rem; margin: 0 0 1.5rem; }
    h2 { font-size: 1.05rem; margin: 0 0 0.75rem; }
    .tile { border: 1px solid #d0d7de; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.25rem; }
    table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #eaeef2; vertical-align: top; }
    thead th { font-weight: 600; color: #656d76; border-bottom: 1px solid #d0d7de; }
    tbody th { font-weight: 500; overflow-wrap: anywhere; }
    tbody tr:last-child th, tbody tr:last-child td { border-bottom: none; }
    .verdict { font-weight: 600; padding: 0.6rem 0.75rem; border-radius: 6px; margin: 0 0 0.5rem; }
    .banner { padding: 0.6rem 0.75rem; border-radius: 6px; margin: 0 0 0.75rem; }
    .s-green { background: #e6f6ea; color: #14532d; }
    .s-red { background: #fde8e8; color: #9b1c1c; }
    .s-grey { background: #f0f2f4; color: #4b5563; }
    .muted { color: #656d76; font-size: 0.9rem; margin: 0 0 0.75rem; }
    .note { color: #9a6700; font-weight: 500; }
    .legend { color: #656d76; font-size: 0.9rem; margin: 0.75rem 0 0; }
    .foot { display: flex; gap: 1rem; align-items: center; margin-top: 1.5rem; }
    button { padding: 0.4rem 0.9rem; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
    .unattributed { color: #656d76; font-style: italic; }
    .growth-grid { display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .series { flex: 1 1 220px; }
    .spark-days { list-style: none; margin: 0.4rem 0 0; padding: 0; font-size: 0.85rem; color: #656d76; }
    .spark-days li { display: inline-block; margin-right: 0.6rem; }`;

/**
 * Render the authenticated `/control` document.
 *
 * Signature deliberately mirrors U3's `renderStubPage({ nonce, csrf })` with
 * the payload added, so U5's swap is one call-site line:
 *   `sendControlHtml(res, 200, renderControlPage({ stats, nonce, csrf }), nonce)`
 *
 * @param {object} opts
 * @param {object} opts.stats - a buildStats() payload (any degraded shape).
 * @param {string} opts.nonce - the caller's per-request CSP nonce; it is
 *   rendered onto `<style>` here and must be the SAME value the choke point
 *   puts in the header (it cannot mint one after the HTML exists).
 * @param {string} opts.csrf  - the double-submit CSRF token for the sign-out POST.
 * @returns {string} a complete `<!doctype html>` document.
 */
export function renderControlPage({ stats, nonce, csrf }) {
  const s = stats ?? {};
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>universal-memory — control</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style nonce="${t(nonce)}">${STYLE}
  </style>
</head>
<body>
  <main>
    <div class="brand">
      ${BRAND_LOCKUP_SVG}
      <span class="brand-name">um<span class="brand-sub"> · universal memory</span></span>
    </div>
    <h1>Control — operational telemetry</h1>
${freshnessTile(s)}
${pipelineTile(s)}
${corpusTile(s)}
${growthTile(s)}
${recallTile(s)}
${opsRow(s)}
    <div class="foot">
      <a href="/control">Refresh</a>
      <form method="post" action="/control/logout">
        <input type="hidden" name="csrf" value="${t(csrf)}">
        <button type="submit">Sign out</button>
      </form>
    </div>
    <p class="muted">Read-only telemetry, generated at ${cell(s.generated_at)} (UTC). There is no auto-refresh — reload to update.</p>
  </main>
</body>
</html>
`;
}
