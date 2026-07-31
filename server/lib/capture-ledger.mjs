// server/lib/capture-ledger.mjs — #201 capture ledger: late-arrival addressing
// for the reaction-salience producer.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record, per the reaction-signal.mjs convention):
//
// • LEDGER-FIRST ORDERING: the ledger row (and any reaction_state mutation) is
//   ground truth and commits BEFORE qdrant payload writes. Payload annotations
//   are a projection; every attach recomputes ALL its targets from the ledger,
//   so a failed payload write is healed by the next attach on that capture.
//
// • RESOLUTION (two-phase, forward-first): a reaction maps to the EARLIEST
//   capture at/after its message_ts (containment is causally guaranteed —
//   capture fires at agent_end, after the message). The skew reach-back
//   [ts − UM_REACTION_TS_SKEW_MS, ts) is a FALLBACK only when no forward row
//   exists within UM_REACTION_MATCH_HORIZON_HOURS — a naive earliest-in-window
//   rule would misresolve interleaved exchanges to the PRIOR capture whenever
//   they sit closer than the skew. The message_hash refiner (earliest window
//   row whose message_hashes contains it) overrides the pick; the caller
//   observes disagreement via `refinerDisagreed` (calibration signal).
//
// • RETENTION FOLDS, NEVER DROPS: only unreacted rows (no reaction_state, no
//   attachments) are pruned after UM_CAPTURE_LEDGER_RETENTION_DAYS; each
//   pruned row increments exchange_tally(day, user_id, surface, verdict) —
//   the ONLY exchange-grained base-rate record. capture.extraction counters
//   mix units (per-fact stored vs per-call abstained) and can never yield an
//   exchange ratio; the #187 measurement's denominator is live rows + tally.
//   Reacted rows are kept indefinitely (sparse — bounded by human reactions).
//
// • PRUNE THROTTLE: at most once per process per UTC day (module stamp,
//   _resetCaptureLedgerForTest clears it) — better-sqlite3 is synchronous and
//   the prune must never become a per-capture sweep inside the R2 response
//   path.
//
// • DDL PER OPERATION: the idempotent CREATE-IF-NOT-EXISTS runs on EVERY
//   operation; never cache a "schema ready" flag — the capture-events
//   _setDbFactoryForTest seam swaps the underlying DB file at any time.
//
// • DB ACCESS: rides capture-events.mjs's lazy singleton via its exported
//   openDb() (WAL + busy_timeout live THERE, set once). This module prepares
//   statements per call and caches nothing, so the capture-events reset seams
//   stay authoritative for both modules. Schema evolution here is
//   ADDITIVE-COLUMN-ONLY; PRAGMA user_version belongs to the counters table
//   and is never touched here.
//
// • FAIL-SOFT ON THE CAPTURE PATH: recordCapture never throws (a ledger
//   failure must never fail the user's capture — warn + counter, return
//   null). The reaction-path exports (resolveCapture, upsertReactionState,
//   recordAttachment, aggregateForPoint, updatePointRef) DO throw on DB
//   failure — the route maps that to a retryable 5xx.

import { randomUUID } from 'node:crypto';
import { openDb } from './capture-events.mjs';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { umCaptureLedgerErrorsTotal } from './metrics.mjs';

const DDL = `
  CREATE TABLE IF NOT EXISTS capture_ledger (
    capture_id     TEXT NOT NULL PRIMARY KEY,
    user_id        TEXT NOT NULL,
    run_id         TEXT,
    surface        TEXT NOT NULL,
    project        TEXT,
    created_at     TEXT NOT NULL,
    verdict        TEXT NOT NULL,
    point_refs     TEXT NOT NULL,
    message_hashes TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_resolution
    ON capture_ledger (user_id, run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ledger_created_at
    ON capture_ledger (created_at);
  CREATE TABLE IF NOT EXISTS reaction_state (
    capture_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    count      INTEGER NOT NULL,
    types      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (capture_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS attachments (
    capture_id         TEXT NOT NULL,
    requested_point_id TEXT NOT NULL,
    terminal_point_id  TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (capture_id, requested_point_id)
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_terminal
    ON attachments (terminal_point_id);
  CREATE TABLE IF NOT EXISTS exchange_tally (
    day     TEXT NOT NULL,
    user_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    verdict TEXT NOT NULL,
    count   INTEGER NOT NULL,
    PRIMARY KEY (day, user_id, surface, verdict)
  );
`;

const DEFAULT_SKEW_MS = 120_000;
const DEFAULT_HORIZON_HOURS = 24;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MESSAGES_PER_CAPTURE = 64;

let _lastPruneDay = null; // prune throttle stamp (UTC day)

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function reactionSkewMs() { return envInt('UM_REACTION_TS_SKEW_MS', DEFAULT_SKEW_MS); }
export function reactionHorizonMs() { return envInt('UM_REACTION_MATCH_HORIZON_HOURS', DEFAULT_HORIZON_HOURS) * 3_600_000; }
function retentionDays() { return envInt('UM_CAPTURE_LEDGER_RETENTION_DAYS', DEFAULT_RETENTION_DAYS); }
function messagesPerCapture() { return envInt('UM_REACTION_MESSAGES_PER_CAPTURE', DEFAULT_MESSAGES_PER_CAPTURE); }

/** DDL-per-operation (see header) — returns the shared singleton handle. */
function db() {
  const d = openDb();
  d.exec(DDL);
  return d;
}

function warnLedger(err, where) {
  try { umCaptureLedgerErrorsTotal.inc({ where }); } catch { /* obs fail-safe */ }
  safeLog(() => getLogger().warn({
    component: 'capture-ledger',
    where,
    err_class: err?.code ?? err?.name ?? 'Error',
    err_message: err?.message ?? String(err),
  }, 'capture-ledger operation failed'), `log:capture-ledger:${where}`);
}

/**
 * Record one capture batch — called at the compat R2 site AFTER umAdd returns.
 * FAIL-SOFT: never throws; returns the capture id, or null on any failure.
 *
 * @param {object} c
 * @param {string} c.userId
 * @param {string|undefined} c.runId - opaque; never parsed
 * @param {string} c.surface
 * @param {string|undefined} c.project
 * @param {string} c.createdAt - ISO
 * @param {'stored'|'abstained'} c.verdict - admission verdict
 * @param {Array<{id: string, hash: string}>} c.pointRefs - surviving ids + payload hashes
 * @param {string[]} c.messageHashes - md5 per POSTed message content
 * @returns {string|null} capture id
 */
export function recordCapture({ userId, runId, surface, project, createdAt, verdict, pointRefs, messageHashes } = {}) {
  try {
    const d = db();
    const captureId = randomUUID();
    const insert = () => d.prepare(`
      INSERT INTO capture_ledger
        (capture_id, user_id, run_id, surface, project, created_at, verdict, point_refs, message_hashes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      captureId, userId, runId ?? null, surface, project ?? null,
      createdAt, verdict, JSON.stringify(pointRefs ?? []), JSON.stringify(messageHashes ?? []),
    );
    try {
      insert();
    } catch (err) {
      // Counters-writer parity (spec §6 pin in capture-events.mjs): busy_timeout
      // pragma + a SINGLE retry on SQLITE_BUSY — a dropped ledger row makes the
      // exchange permanently unaddressable, a worse loss than a dropped counter.
      if (err?.code !== 'SQLITE_BUSY') throw err;
      insert();
    }
    maybePrune(d);
    return captureId;
  } catch (err) {
    warnLedger(err, 'recordCapture');
    return null;
  }
}

function rowOut(row, refinerDisagreed) {
  return {
    captureId: row.capture_id,
    userId: row.user_id,
    runId: row.run_id,
    surface: row.surface,
    project: row.project,
    createdAt: row.created_at,
    verdict: row.verdict,
    pointRefs: JSON.parse(row.point_refs),
    refinerDisagreed,
  };
}

/**
 * Resolve a late reaction to its capture (two-phase forward-first — header).
 * Returns null when nothing matches. Throws on DB failure (route maps to 5xx).
 */
export function resolveCapture({ userId, runId, messageTs, messageHash } = {}) {
  const tsMs = Date.parse(messageTs);
  if (!Number.isFinite(tsMs)) return null;
  const lowerIso = new Date(tsMs - reactionSkewMs()).toISOString();
  const upperIso = new Date(tsMs + reactionHorizonMs()).toISOString();
  const rows = db().prepare(`
    SELECT * FROM capture_ledger
    WHERE user_id = ? AND run_id = ? AND created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
  `).all(userId, runId, lowerIso, upperIso);
  if (rows.length === 0) return null;

  const tsIso = new Date(tsMs).toISOString();
  const forward = rows.find((r) => r.created_at >= tsIso);
  // Fallback = clock-offset safety net: every remaining row is BEFORE the
  // message ts, and the offset is small, so the causally-correct capture is
  // the one CLOSEST to ts (the last ASC row) — never the oldest (review
  // R#205: rows[0] here re-introduced the earliest-wins bias the forward
  // phase exists to avoid).
  let pick = forward ?? rows[rows.length - 1];

  let refinerDisagreed = false;
  if (typeof messageHash === 'string' && messageHash.length > 0) {
    const refined = rows.find((r) => {
      try { return JSON.parse(r.message_hashes).includes(messageHash); } catch { return false; }
    });
    if (refined && refined.capture_id !== pick.capture_id) {
      pick = refined;
      refinerDisagreed = true;
    }
  }
  return rowOut(pick, refinerDisagreed);
}

/**
 * Absolute-count last-write-wins upsert (zero is valid — removal; the floor-1
 * rule belongs to the payload projection, not the ledger).
 *
 * @returns {'created'|'updated'|'cap_exceeded'} transition — 'created' keys
 *   the transition-based counter emit; 'cap_exceeded' maps to a 400 upstream.
 */
export function upsertReactionState({ captureId, messageId, count, types } = {}) {
  const d = db();
  const existing = d.prepare(
    'SELECT 1 AS one FROM reaction_state WHERE capture_id = ? AND message_id = ?',
  ).get(captureId, messageId);
  const now = new Date().toISOString();
  if (existing) {
    d.prepare(
      'UPDATE reaction_state SET count = ?, types = ?, updated_at = ? WHERE capture_id = ? AND message_id = ?',
    ).run(count, JSON.stringify(types ?? []), now, captureId, messageId);
    return 'updated';
  }
  const { n } = d.prepare(
    'SELECT COUNT(*) AS n FROM reaction_state WHERE capture_id = ?',
  ).get(captureId);
  if (n >= messagesPerCapture()) return 'cap_exceeded';
  d.prepare(
    'INSERT INTO reaction_state (capture_id, message_id, count, types, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(captureId, messageId, count, JSON.stringify(types ?? []), now);
  return 'created';
}

/**
 * Universal attachment upsert — one row per (capture, requested point); a
 * re-attach moves the terminal (supersession chain advanced, or reindex
 * re-resolution) and aggregates follow it.
 */
export function recordAttachment({ captureId, requestedPointId, terminalPointId } = {}) {
  db().prepare(`
    INSERT INTO attachments (capture_id, requested_point_id, terminal_point_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (capture_id, requested_point_id)
    DO UPDATE SET terminal_point_id = excluded.terminal_point_id, updated_at = excluded.updated_at
  `).run(captureId, requestedPointId, terminalPointId, new Date().toISOString());
}

/**
 * Point-level aggregate (spec D-c): SUM of reaction counts and union of types
 * across DISTINCT captures currently attached to this terminal point — the
 * anti-clobber contract: two captures funneled onto one point ACCUMULATE,
 * never overwrite each other.
 */
export function aggregateForPoint(pointId) {
  const d = db();
  const captures = d.prepare(
    'SELECT DISTINCT capture_id FROM attachments WHERE terminal_point_id = ? ORDER BY rowid ASC',
  ).all(pointId);
  let count = 0;
  const types = [];
  const seen = new Set();
  const stateStmt = d.prepare(
    'SELECT count, types FROM reaction_state WHERE capture_id = ? ORDER BY message_id ASC',
  );
  for (const { capture_id: cid } of captures) {
    for (const row of stateStmt.all(cid)) {
      count += row.count;
      let parsed;
      try { parsed = JSON.parse(row.types); } catch { parsed = []; }
      for (const t of parsed) {
        if (!seen.has(t)) { seen.add(t); types.push(t); }
      }
    }
  }
  return { count, types };
}

/**
 * Reindex persist-back (spec D-c): rewrite a dangling point id inside a
 * capture's point_refs so the hash fallback fires once per reindex, not on
 * every subsequent attach.
 */
export function updatePointRef({ captureId, oldPointId, newPointId } = {}) {
  const d = db();
  const row = d.prepare('SELECT point_refs FROM capture_ledger WHERE capture_id = ?').get(captureId);
  if (!row) return;
  let refs;
  try { refs = JSON.parse(row.point_refs); } catch { return; }
  const updated = refs.map((r) => (r.id === oldPointId ? { ...r, id: newPointId } : r));
  d.prepare('UPDATE capture_ledger SET point_refs = ? WHERE capture_id = ?')
    .run(JSON.stringify(updated), captureId);
}

/**
 * Throttled retention prune (header): delete unreacted rows past retention,
 * folding each into exchange_tally first. Runs inside recordCapture's
 * fail-soft envelope.
 */
function maybePrune(d) {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastPruneDay === today) return;
  _lastPruneDay = today;
  const cutoffIso = new Date(Date.now() - retentionDays() * 86_400_000).toISOString();
  const candidates = d.prepare(`
    SELECT capture_id, user_id, surface, verdict, created_at FROM capture_ledger
    WHERE created_at < ?
      AND capture_id NOT IN (SELECT capture_id FROM reaction_state)
      AND capture_id NOT IN (SELECT capture_id FROM attachments)
  `).all(cutoffIso);
  if (candidates.length === 0) return;
  const tallyStmt = d.prepare(`
    INSERT INTO exchange_tally (day, user_id, surface, verdict, count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT (day, user_id, surface, verdict) DO UPDATE SET count = count + 1
  `);
  const deleteStmt = d.prepare('DELETE FROM capture_ledger WHERE capture_id = ?');
  const fold = d.transaction((rows) => {
    for (const r of rows) {
      tallyStmt.run(r.created_at.slice(0, 10), r.user_id, r.surface, r.verdict);
      deleteStmt.run(r.capture_id);
    }
  });
  fold(candidates);
}

/** Test seam: clear the prune-throttle stamp. */
export function _resetCaptureLedgerForTest() {
  _lastPruneDay = null;
}
