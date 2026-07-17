// server/lib/capture-events.mjs — T5 (#159 arc, spec §6 / #171 day-one):
// capture.* event emission — structured pino events + durable per-day counters.
//
// Spec §6 pins (2026-07-16-cc-plugin-remote-spec.md):
//   • Pino event names (PINNED): capture.turn, capture.checkpoint,
//     capture.extraction — carrying { surface, project, outcome }.
//   • Outcome vocabulary: stored | abstained | deduped | superseded | error,
//     with '' persisted where inapplicable.
//   • Durable counters: (day, surface, project, event, outcome, count) upserts
//     into a NEW, UM-OWNED SQLite file (um-counters.db) — never mem0's history
//     DB (mem0ai-internal; co-tenanting a library's private DB invites lock
//     contention and schema collisions).
//   • Schema versioning: PRAGMA user_version stamped at create; evolution is
//     ADDITIVE-COLUMN-ONLY (a fire-and-forget writer must never require a
//     destructive migration).
//   • busy_timeout pragma + a SINGLE retry on SQLITE_BUSY.
//   • Fire-and-forget: a counter failure must NEVER fail the capture path —
//     recordCaptureEvent never throws (mirrors the append-turn reindex
//     best-effort pattern).
//   • Surface attribution: X-UM-Source header (X-Mem0-Source accepted as an
//     alias); absent ⇒ 'unknown'.
//
// Driver: better-sqlite3 (plan T5 resolution — the Docker image is
// node:20-alpine, which does not ship node:sqlite; better-sqlite3 is already
// in the image as a mem0ai transitive dep and is now a pinned DIRECT dep).
// better-sqlite3 is synchronous — the upsert is microseconds and the caller
// is never blocked beyond it.
//
// Path: UM_COUNTERS_DB_PATH, defaulting NEXT TO the history DB's configured
// location so an existing history-DB bind mount covers both files. When only
// ephemeral storage exists the counters still function (best-effort
// durability — documented in docker-compose.yml / .env.example).

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';

const require = createRequire(import.meta.url);

/** Spec §6 pinned pino event names. */
export const CAPTURE_EVENTS = Object.freeze({
  TURN: 'capture.turn',
  CHECKPOINT: 'capture.checkpoint',
  EXTRACTION: 'capture.extraction',
});

const COUNTERS_USER_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;

// Column order pinned by spec §6: (day, surface, project, event, outcome, count).
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS counters (
    day     TEXT    NOT NULL,
    surface TEXT    NOT NULL,
    project TEXT    NOT NULL,
    event   TEXT    NOT NULL,
    outcome TEXT    NOT NULL,
    count   INTEGER NOT NULL,
    PRIMARY KEY (day, surface, project, event, outcome)
  )
`;

const UPSERT_SQL = `
  INSERT INTO counters (day, surface, project, event, outcome, count)
  VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT (day, surface, project, event, outcome)
  DO UPDATE SET count = count + 1
`;

// Lazy-open singleton — the DB (and its file) is created on first emit, not
// at module load, so read-only deployments that never capture pay nothing.
let _db = null;
let _upsertStmt = null;
let _dbFactory = null;             // test seam — replaces openDb entirely
const _warnedErrorClasses = new Set(); // warn once per process per error class

/**
 * Resolve the counters DB path (spec §6): UM_COUNTERS_DB_PATH wins; else
 * um-counters.db NEXT TO the configured mem0 history DB location, so the
 * same durable bind mount covers both.
 */
export function countersDbPath() {
  if (process.env.UM_COUNTERS_DB_PATH) return process.env.UM_COUNTERS_DB_PATH;
  const historyDb = process.env.MEM0_HISTORY_DB_PATH || '/tmp/mem0-history.db';
  return path.join(path.dirname(historyDb), 'um-counters.db');
}

function openDb() {
  if (_db) return _db;
  if (_dbFactory) {
    _db = _dbFactory();
    return _db;
  }
  const Database = require('better-sqlite3');
  const dbPath = countersDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(CREATE_TABLE_SQL);
  // Stamp user_version at create only — a later schema rev bumps it in its
  // own (additive-column-only) migration; never re-stamp an existing DB down.
  if (db.pragma('user_version', { simple: true }) === 0) {
    db.pragma(`user_version = ${COUNTERS_USER_VERSION}`);
  }
  _db = db;
  return _db;
}

function upsertStmt() {
  if (!_upsertStmt) _upsertStmt = openDb().prepare(UPSERT_SQL);
  return _upsertStmt;
}

function warnOnce(err) {
  const errClass = err?.code ?? err?.name ?? 'Error';
  if (_warnedErrorClasses.has(errClass)) return;
  _warnedErrorClasses.add(errClass);
  safeLog(() => getLogger().warn({
    component: 'capture-events',
    err_class: errClass,
    err_message: err?.message ?? String(err),
  }, 'capture counter emit failed (fire-and-forget; warning once per error class)'),
  'log:capture-events:emit-failed');
}

/**
 * Derive the capture surface from request headers (spec §6): X-UM-Source is
 * the canonical header; X-Mem0-Source is accepted as an alias (existing bot
 * clients already send it); absent/blank ⇒ `fallback` ('unknown' by default;
 * the mem0-compat facade passes 'mem0-compat' to preserve its spec-§7 default).
 *
 * Node's http layer lowercases incoming header names — callers pass
 * req.headers as-is.
 */
export function surfaceFromHeaders(headers, fallback = 'unknown') {
  const raw = headers?.['x-um-source'] ?? headers?.['x-mem0-source'];
  return typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim().toLowerCase()
    : fallback;
}

/**
 * Emit one capture.* event: a structured pino line (pinned event name) plus a
 * durable (day, surface, project, event, outcome) counter upsert.
 *
 * FIRE-AND-FORGET: never throws, never fails the caller's write path. All
 * failures are swallowed with a once-per-error-class warn log. Synchronous by
 * design (better-sqlite3) — the upsert is microseconds.
 *
 * @param {object} evt
 * @param {string} evt.event     - Pinned name (CAPTURE_EVENTS.*) — required; no-op when absent.
 * @param {string} [evt.surface] - Capture surface; absent ⇒ 'unknown' (spec §6).
 * @param {string} [evt.project] - Project slug; absent ⇒ '' (spec §6: '' where inapplicable).
 * @param {string} [evt.outcome] - stored|abstained|deduped|superseded|error; absent ⇒ ''.
 */
export function recordCaptureEvent({ surface, project, event, outcome } = {}) {
  try {
    if (!event) return;
    const s = typeof surface === 'string' && surface.length > 0 ? surface : 'unknown';
    const p = typeof project === 'string' ? project : '';
    const o = typeof outcome === 'string' ? outcome : '';

    // Structured pino event with the spec-pinned name (§6). Emitted alongside
    // the counter so live log tails and durable counts can't drift apart.
    safeLog(() => getLogger().info(
      { event, surface: s, project: p, outcome: o },
      event,
    ), 'log:capture-events:event');

    const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    try {
      upsertStmt().run(day, s, p, event, o);
    } catch (err) {
      // Spec §6: busy-timeout pragma + a SINGLE retry on SQLITE_BUSY.
      if (err?.code !== 'SQLITE_BUSY') throw err;
      upsertStmt().run(day, s, p, event, o);
    }
  } catch (err) {
    warnOnce(err);
  }
}

/** Test seam: close + drop the singleton DB, clear warn-dedup + factory. */
export function _resetCaptureEventsForTest() {
  try { _db?.close?.(); } catch { /* best-effort */ }
  _db = null;
  _upsertStmt = null;
  _dbFactory = null;
  _warnedErrorClasses.clear();
}

/** Test seam: inject a DB factory (throwing / SQLITE_BUSY stubs). */
export function _setDbFactoryForTest(fn) {
  _resetCaptureEventsForTest();
  _dbFactory = fn;
}
