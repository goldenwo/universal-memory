// server/lib/control-page.mjs — U4a (#171 Stage B, spec §4/§5/§6): the
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
// U4b extends this module with the corpus / growth / pipeline / recall tiles;
// the shell, the shared helpers and the freshness tile land here.

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
  if (hours > thresholdHours) return { state: 'red', words: `stale — no capture within ${t(thresholdHours)}h` };
  const landed = landedCount(info.outcomes_7d);
  if (landed === 0) return { state: 'red', words: 'active but landing nothing' };
  return { state: 'green', words: 'fresh' };
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
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 0.5rem; }
    .brand-name { font-weight: 650; font-size: 1.15rem; letter-spacing: -0.02em; }
    .brand-sub { color: #656d76; font-weight: 400; }
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
    button { padding: 0.4rem 0.9rem; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }`;

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
