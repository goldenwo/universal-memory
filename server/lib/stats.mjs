// server/lib/stats.mjs — U1 (#171 Stage A, spec §3): read-only counters
// aggregation + capture-freshness math for GET /api/stats.
//
// Spec pins (2026-07-17-um-control-stage-a-spec.md §3):
//   • READ-ONLY over T5's um-counters.db — better-sqlite3 {readonly: true},
//     opened per call (the stats endpoint is low-traffic; a fresh handle per
//     read avoids caching staleness and never contends with the writer —
//     sync sqlite, no await-spanning locks).
//   • SCOPE FILTER (load-bearing for G2): the `capture` section aggregates
//     ONLY rows with event LIKE 'capture.%' — recall.search rows live in the
//     same table and MUST NOT refresh a surface, or a dead capture pipeline
//     with live searches shows "fresh" (the exact 2026-07-16 incident).
//   • PINNED FRESHNESS FORMULA: hours from the END of last_day_seen
//     (UTC 24:00 of that day) to now, clamped to ≥ 0 — a conservative lower
//     bound that cannot false-alarm the §4 check. Rows today ⇒ 0.
//   • growth_7d: per-day capture.extraction outcome IN (stored, superseded) —
//     an in-band supersession still inserts one new qdrant point.
//   • Degraded mode (A5): missing/unreadable counters db ⇒ null-shaped result
//     (never throws) — the route maps it to capture:null + growth_7d:null +
//     degraded:["counters-unavailable"], HTTP 200.
//   • LANDING-ONLY outcomes_7d (spec §7, 2026-08-15 instrumented-truth fix):
//     outcomes_7d is scoped to LANDING_EVENTS (capture.extraction,
//     capture.checkpoint) only — capture.turn no longer inflates "stored" (the
//     547-stored/7d-vs-growth-0/day contradiction: 2,570 turn-appends emit
//     outcome 'stored' too, and used to dominate the same bucket as real
//     landings). events_today/errors_today/freshness keep their prior ALL
//     capture.% scope unchanged (one semantics change per surface per
//     release — the layers block carries the per-layer truth instead).
//   • Additive turns_7d (per surface): the honest 7-day volume label — the
//     same capture.turn rows that used to masquerade as "stored" landings.
//
// CLOCK SEAM: every time-dependent function takes `now` (epoch ms) as an
// explicit parameter — no Date.now() in this module. The route passes
// Date.now(); tests pass frozen values (spec A2 demands exact-value asserts).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { countersDbPath } from './capture-events.mjs';
import { REACTION_OUTCOME_KEYS, SIGNAL_EVENTS } from './reaction-signal.mjs';
import { ANOMALY_EVENT, ANOMALY_REASON_KEYS, ANOMALY_OTHER } from './anomaly-signal.mjs';

const require = createRequire(import.meta.url);

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS = 7; // today + 6 prior UTC days (spec §3 "_7d" fields)

/** Spec §6 outcome vocabulary — outcomes_7d always carries all six keys. */
const OUTCOME_KEYS = Object.freeze(['stored', 'abstained', 'deduped', 'superseded', 'error', 'failed']);

/**
 * Spec §7 — the events that count as a LANDING (something reached the vault
 * or was durably written to disk). `capture.turn` is deliberately excluded:
 * it is raw append volume, not a pipeline outcome, and is exposed instead via
 * the additive `turns_7d` field. Single-sourced here so the SQL scope and the
 * doc comments above cannot drift apart.
 */
const LANDING_EVENTS = Object.freeze(['capture.extraction', 'capture.checkpoint']);

/** Degraded shape (A5): counters unavailable ⇒ nulls, never a throw. */
function nullShaped() {
  return { available: false, capture: null, growth_7d: null, growth_docs_7d: null, recall: null, anomalies: null };
}

function utcDayString(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function emptyOutcomes() {
  return Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0]));
}

/**
 * Pinned freshness formula (spec §3, R2-corrected): hours from the END of
 * `lastDaySeen` (UTC 24:00 of that day) to `nowMs`, clamped to ≥ 0. Day
 * granularity makes this a conservative lower bound: for a surface last seen
 * D≥1 days ago it equals (D−1)*24 + hours_since_utc_midnight(now); rows today
 * (D=0) put end-of-day in the future ⇒ clamps to 0. 1-decimal precision.
 *
 * @param {string} lastDaySeen - UTC day 'YYYY-MM-DD' (T5's sole day format).
 * @param {number} nowMs       - Clock seam: explicit epoch ms.
 * @returns {number} hours, ≥ 0, rounded to 1 decimal.
 */
export function freshnessHours(lastDaySeen, nowMs) {
  const endOfDayMs = Date.parse(`${lastDaySeen}T00:00:00.000Z`) + MS_PER_DAY;
  const hours = (nowMs - endOfDayMs) / MS_PER_HOUR;
  return hours <= 0 ? 0 : round1(hours);
}

/**
 * Read + aggregate um-counters.db for the spec-§3 counters-derived sections.
 *
 * @param {object} opts
 * @param {number} opts.now      - Clock seam: explicit epoch ms (required —
 *                                 the route passes Date.now(); tests freeze it).
 * @param {string} [opts.dbPath] - Counters db path; defaults to the T5
 *                                 writer's countersDbPath() resolution.
 * @returns {{
 *   available: boolean,
 *   capture: null | Record<string, { last_day_seen: string, freshness_hours: number,
 *     events_today: number, errors_today: number,
 *     outcomes_7d: Record<'stored'|'abstained'|'deduped'|'superseded'|'error'|'failed', number>,
 *     turns_7d: number }>,
 *   growth_7d: null | Record<string, number>,
 *   recall: null | { searches_today: number, searches_7d: number },
 *   anomalies: null | Record<string, { last_day_seen: string, count_7d: number,
 *     reasons_7d: Record<string, number> }>,
 * }} Null-shaped ({available:false}, all sections null) when the counters db
 *    is missing or unreadable — never throws for db-state reasons.
 */
export function readCounterStats({ now, dbPath = countersDbPath() } = {}) {
  if (!Number.isFinite(now)) {
    throw new TypeError('readCounterStats: `now` (epoch ms) is required — clock seam, no implicit Date.now()');
  }
  // Missing file ⇒ degraded, not an error: fresh installs have no db until
  // the first capture (the T5 writer creates it lazily).
  if (!fs.existsSync(dbPath)) return nullShaped();

  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const today = utcDayString(now);
    const windowStart = utcDayString(now - (WINDOW_DAYS - 1) * MS_PER_DAY);

    // last_day_seen deliberately scans ALL history, not just the 7-day
    // window — a surface dead for 30 days must still show its staleness
    // (the whole point of the §4 alert), while the windowed aggregates
    // below zero out for it.
    const lastSeenRows = db.prepare(`
      SELECT surface, MAX(day) AS last_day_seen
      FROM counters
      WHERE event LIKE 'capture.%'
      GROUP BY surface
    `).all();

    const windowRows = db.prepare(`
      SELECT surface, day, outcome, SUM(count) AS n
      FROM counters
      WHERE event LIKE 'capture.%' AND day >= ? AND day <= ?
      GROUP BY surface, day, outcome
    `).all(windowStart, today);

    // Spec §7 — outcomes_7d is LANDING-ONLY: capture.extraction + capture.
    // checkpoint, never capture.turn (a turn-append also emits outcome
    // 'stored', which is exactly how it used to inflate outcomes_7d.stored
    // above windowRows' all-capture.% scope). LANDING_EVENTS is the single
    // source for both this WHERE clause and the doc comments above.
    const landingPlaceholders = LANDING_EVENTS.map(() => '?').join(', ');
    const landingRows = db.prepare(`
      SELECT surface, outcome, SUM(count) AS n
      FROM counters
      WHERE event IN (${landingPlaceholders}) AND day >= ? AND day <= ?
      GROUP BY surface, outcome
    `).all(...LANDING_EVENTS, windowStart, today);

    // Additive turns_7d (spec §7): the honest volume label — the same
    // capture.turn rows outcomes_7d now excludes, summed per surface over the
    // window (no outcome breakdown; turn always emits 'stored').
    const turnRows = db.prepare(`
      SELECT surface, SUM(count) AS n
      FROM counters
      WHERE event = 'capture.turn' AND day >= ? AND day <= ?
      GROUP BY surface
    `).all(windowStart, today);

    const growthRows = db.prepare(`
      SELECT day, SUM(count) AS n
      FROM counters
      WHERE event = 'capture.extraction'
        AND outcome IN ('stored', 'superseded')
        AND day >= ? AND day <= ?
      GROUP BY day
    `).all(windowStart, today);

    // #185: doc-tier growth — session-summary writes were invisible in
    // growth_7d (extraction-only), which is how 121+ fabricated summaries
    // accrued unseen. outcome IN ('stored','error') is deliberate: the
    // checkpoint 'error' emit fires only AFTER the summary + state.md are
    // durably written (retry-exhausted reindex = doc written, index stale),
    // so both outcomes are "a doc landed on disk". 'abstained' wrote nothing.
    const growthDocsRows = db.prepare(`
      SELECT day, SUM(count) AS n
      FROM counters
      WHERE event = 'capture.checkpoint'
        AND outcome IN ('stored', 'error')
        AND day >= ? AND day <= ?
      GROUP BY day
    `).all(windowStart, today);

    const recallRows = db.prepare(`
      SELECT day, SUM(count) AS n
      FROM counters
      WHERE event = 'recall.search' AND day >= ? AND day <= ?
      GROUP BY day
    `).all(windowStart, today);

    // Null-prototype map: `surface` is caller-controlled (X-UM-Source has no
    // charset restriction) — on a plain literal, a surface named '__proto__'
    // hits the prototype setter instead of creating an own key and vanishes
    // from Object.keys / JSON.stringify / the API (v1.8.1 shipped bug).
    const capture = Object.create(null);
    for (const { surface, last_day_seen } of lastSeenRows) {
      capture[surface] = {
        last_day_seen,
        freshness_hours: freshnessHours(last_day_seen, now),
        events_today: 0,
        errors_today: 0,
        outcomes_7d: emptyOutcomes(),
        turns_7d: 0,
      };
    }
    // events_today/errors_today (spec §7: UNCHANGED) — still every capture.%
    // row, today-scoped, exactly as before this fix. outcomes_7d is NO LONGER
    // populated from this loop — see the landingRows loop below.
    for (const { surface, day, outcome, n } of windowRows) {
      const s = capture[surface]; // always present: window rows are a subset of last-seen surfaces
      if (day === today) {
        s.events_today += n;
        if (outcome === 'error') s.errors_today += n;
      }
    }
    // Spec §7: outcomes_7d is landing-only — populated from landingRows
    // (capture.extraction + capture.checkpoint), never capture.turn.
    for (const { surface, outcome, n } of landingRows) {
      const s = capture[surface]; // always present: landing rows are a subset of last-seen surfaces
      // Outcome '' (inapplicable, spec §6) has no outcomes_7d bucket by design.
      if (Object.hasOwn(s.outcomes_7d, outcome)) s.outcomes_7d[outcome] += n;
    }
    for (const { surface, n } of turnRows) {
      const s = capture[surface]; // always present: turn rows are a subset of last-seen surfaces
      s.turns_7d = n;
    }

    // #187 reactions_7d: signal.reaction lives OUTSIDE the capture.* namespace
    // (reaction-signal.mjs invariants), so the queries above never see it —
    // events_today/freshness are isolated by construction and this is the ONLY
    // reaction-aware query. Reader-doesn't-trust-writer: a reaction row whose
    // surface has no capture entry (REACHABLE since #201 — /api/reaction's
    // unaddressed emits use a caller-supplied fallback surface not tied to any
    // prior capture; before #201 it was unreachable from the one writer, which
    // co-emits capture.extraction in the same umAdd call — but the DB is data,
    // not a promise) is SKIPPED, never thrown on: /api/stats must not degrade
    // to counters-unavailable over a stray row.
    const reactionRows = db.prepare(`
      SELECT surface, outcome, SUM(count) AS n
      FROM counters
      WHERE event = ? AND day >= ? AND day <= ?
      GROUP BY surface, outcome
    `).all(SIGNAL_EVENTS.REACTION, windowStart, today);
    for (const { surface, outcome, n } of reactionRows) {
      const s = capture[surface];
      if (!s) continue; // reaction-only surface — skip (see comment above)
      // Vocabulary check BEFORE minting the map: an out-of-vocabulary outcome
      // (e.g. a newer writer's third outcome read by this older server) must
      // not manufacture an all-zero reactions_7d — omit-when-inapplicable.
      if (!REACTION_OUTCOME_KEYS.includes(outcome)) continue;
      s.reactions_7d ??= Object.fromEntries(REACTION_OUTCOME_KEYS.map((k) => [k, 0]));
      s.reactions_7d[outcome] += n;
    }

    // Zero-filled 7-day map (oldest → today) — Stage B's sparkline consumes
    // this directly; gap days must read as 0, not be absent.
    const growth_7d = {};
    const growth_docs_7d = {};
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      growth_7d[utcDayString(now - i * MS_PER_DAY)] = 0;
      growth_docs_7d[utcDayString(now - i * MS_PER_DAY)] = 0;
    }
    for (const { day, n } of growthRows) growth_7d[day] = n;
    for (const { day, n } of growthDocsRows) growth_docs_7d[day] = n;

    let searches_today = 0;
    let searches_7d = 0;
    for (const { day, n } of recallRows) {
      searches_7d += n;
      if (day === today) searches_today = n;
    }

    // #267 anomalies — signal.capture_anomaly, an INDEPENDENT section that
    // deliberately INVERTS the reactions reader's posture on BOTH axes 20
    // lines up (do not "harmonize" them — the divergence is the point):
    //   • Independence, not nesting: a reaction row without a capture
    //     surface is safely skipped; an anomaly row without one is the
    //     broken-from-day-one install — the exact blindness this event
    //     exists to expose — so anomalies NEVER key through the capture map.
    //   • Fold, not skip: an out-of-vocabulary outcome (a NEWER hook's
    //     reason read by this server) counts under 'other' — for an alarm
    //     feed a dropped row is a missed alarm, the inverse of the
    //     annotation-safe reaction skip.
    // Queries are event-EQUALITY (never LIKE): the capture.% boundary stays
    // untouched by construction, and the namespace-isolation test pins the
    // whole output byte-identical modulo this section.
    // FAIL-ISOLATED in its own try (review catch): "independent" must also
    // mean independently degradable — a defect in this newest reader must
    // never dark the capture-freshness sections it exists to protect. On
    // error: anomalies:null alone, which um-alert's signals-null-with-
    // capture-present tripwire reports as a LOUD exit-2 monitor fault.
    let anomalies = null;
    try {
      // Snapshot both reads in one transaction (review catch): the writer
      // shares this WAL DB (and operators are documented running their own
      // in-container sessions), so two bare SELECTs could see a first-ever
      // anomaly surface appear between them.
      const anomalyKeys = Object.freeze([...ANOMALY_REASON_KEYS, ANOMALY_OTHER]);
      const readAnomalies = db.transaction(() => ({
        lastSeen: db.prepare(`
          SELECT surface, MAX(day) AS last_day_seen
          FROM counters
          WHERE event = ?
          GROUP BY surface
        `).all(ANOMALY_EVENT),
        windowRows: db.prepare(`
          SELECT surface, outcome, SUM(count) AS n
          FROM counters
          WHERE event = ? AND day >= ? AND day <= ?
          GROUP BY surface, outcome
        `).all(ANOMALY_EVENT, windowStart, today),
      }));
      const snap = readAnomalies();

      // Null-prototype maps THROUGHOUT — surface AND outcome are writer-
      // controlled (the v1.8.1 '__proto__' hazard; reasons_7d is served to
      // external readers, so it gets the same discipline as the outer map).
      const built = Object.create(null);
      for (const { surface, last_day_seen } of snap.lastSeen) {
        built[surface] = {
          last_day_seen,
          count_7d: 0,
          reasons_7d: Object.assign(Object.create(null), Object.fromEntries(anomalyKeys.map((k) => [k, 0]))),
        };
      }
      for (const { surface, outcome, n } of snap.windowRows) {
        const a = built[surface];
        // Tripwire, unreachable under the transaction (window rows ⊆
        // last-seen within one snapshot): skipping defers the row to the
        // next read — rows are durable — rather than throwing this section
        // dark at the first-ever anomaly.
        if (!a) continue;
        a.count_7d += n;
        const key = Object.hasOwn(a.reasons_7d, outcome) ? outcome : ANOMALY_OTHER;
        a.reasons_7d[key] += n;
      }
      anomalies = built;
    } catch (err) {
      safeLog(() => getLogger().warn({
        component: 'stats',
        err_class: err?.code ?? err?.name ?? 'Error',
        err_message: err?.message ?? String(err),
      }, 'anomaly section unreadable — serving anomalies:null (capture sections stay live)'),
      'log:stats:anomalies-unreadable');
    }

    return { available: true, capture, growth_7d, growth_docs_7d, recall: { searches_today, searches_7d }, anomalies };
  } catch (err) {
    // Unreadable (corrupt/locked-exotic) db ⇒ same degraded shape as missing
    // (spec §3 errors clause: stats must not 500 over the counters file).
    safeLog(() => getLogger().warn({
      component: 'stats',
      err_class: err?.code ?? err?.name ?? 'Error',
      err_message: err?.message ?? String(err),
      db_path: dbPath,
    }, 'counters db unreadable — serving degraded (null-shaped) stats'),
    'log:stats:counters-unreadable');
    return nullShaped();
  } finally {
    try { db?.close?.(); } catch { /* best-effort */ }
  }
}
