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
//
// CLOCK SEAM: every time-dependent function takes `now` (epoch ms) as an
// explicit parameter — no Date.now() in this module. The route passes
// Date.now(); tests pass frozen values (spec A2 demands exact-value asserts).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { countersDbPath } from './capture-events.mjs';

const require = createRequire(import.meta.url);

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS = 7; // today + 6 prior UTC days (spec §3 "_7d" fields)

/** Spec §6 outcome vocabulary — outcomes_7d always carries all five keys. */
const OUTCOME_KEYS = Object.freeze(['stored', 'abstained', 'deduped', 'superseded', 'error']);

/** Degraded shape (A5): counters unavailable ⇒ nulls, never a throw. */
function nullShaped() {
  return { available: false, capture: null, growth_7d: null, recall: null };
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
 *     outcomes_7d: Record<'stored'|'abstained'|'deduped'|'superseded'|'error', number> }>,
 *   growth_7d: null | Record<string, number>,
 *   recall: null | { searches_today: number, searches_7d: number },
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

    const growthRows = db.prepare(`
      SELECT day, SUM(count) AS n
      FROM counters
      WHERE event = 'capture.extraction'
        AND outcome IN ('stored', 'superseded')
        AND day >= ? AND day <= ?
      GROUP BY day
    `).all(windowStart, today);

    const recallRows = db.prepare(`
      SELECT day, SUM(count) AS n
      FROM counters
      WHERE event = 'recall.search' AND day >= ? AND day <= ?
      GROUP BY day
    `).all(windowStart, today);

    const capture = {};
    for (const { surface, last_day_seen } of lastSeenRows) {
      capture[surface] = {
        last_day_seen,
        freshness_hours: freshnessHours(last_day_seen, now),
        events_today: 0,
        errors_today: 0,
        outcomes_7d: emptyOutcomes(),
      };
    }
    for (const { surface, day, outcome, n } of windowRows) {
      const s = capture[surface]; // always present: window rows are a subset of last-seen surfaces
      if (day === today) {
        s.events_today += n;
        if (outcome === 'error') s.errors_today += n;
      }
      // Outcome '' (inapplicable, spec §6) counts toward events_today but has
      // no outcomes_7d bucket by design.
      if (Object.hasOwn(s.outcomes_7d, outcome)) s.outcomes_7d[outcome] += n;
    }

    // Zero-filled 7-day map (oldest → today) — Stage B's sparkline consumes
    // this directly; gap days must read as 0, not be absent.
    const growth_7d = {};
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      growth_7d[utcDayString(now - i * MS_PER_DAY)] = 0;
    }
    for (const { day, n } of growthRows) growth_7d[day] = n;

    let searches_today = 0;
    let searches_7d = 0;
    for (const { day, n } of recallRows) {
      searches_7d += n;
      if (day === today) searches_today = n;
    }

    return { available: true, capture, growth_7d, recall: { searches_today, searches_7d } };
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
