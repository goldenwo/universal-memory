// server/lib/layers.mjs — Task 10 (PR-3, spec §6): per-layer freshness —
// filesystem-mtime ground truth per project, independent of the counters db
// and of emit-site correctness (mtimes cannot rot when an emit site
// silently stops firing). This is the component that would have caught the
// 2026-08-04 outage (spec §11.3): universal-memory's captures kept landing
// while session summaries and the cursor watermark stopped advancing for
// five days, and the pre-existing per-surface freshness check never saw it
// — surface freshness only watches `capture.%` counter rows, which stayed
// 0h "fresh" because capture.turn kept firing throughout.
//
// buildLayers() is READ-ONLY filesystem truth: raw capture file mtimes,
// session summary mtimes, state.md mtimes, and the checkpoint cursor's
// positional watermark (checkpoint-cursor.json) — never the counters db,
// never qdrant. It does not import checkpoint-cursor.mjs's write-path
// machinery (loadCursor/recoveryReinit/advanceCursor): this module only
// ever READS a cursor for a lightweight positional-arithmetic ground-truth
// read, and must not touch the arc's catastrophic-class write surface.
//
// STALE RULE (spec §6, verbatim — the ∞ sign has a review history of
// landing inverted; get the direction right and pin both):
//   stale := pending_bytes >= min_transcript_bytes AND lag > UM_SUMMARY_LAG_MAX_HOURS
//   lag := last_capture_at - digested_through
//   digested_through := cursor.last_turn_iso when a cursor exists, else last_summary_at
//   lag := +Infinity whenever digested_through resolves to null (no cursor
//     AND no summary ever, OR a cursor whose own last_turn_iso is
//     unusable) — a never-checkpointed project with real pending content
//     must read as MAXIMALLY stale. The infinity sits on the LAG, never on
//     digested_through: seeding digested_through itself with +Infinity
//     would make the subtraction `last_capture_at - Infinity` = -Infinity,
//     which is LESS than any finite threshold — the comparison inverts and
//     such a project would NEVER alert. That is exactly the silent-monitor
//     failure mode this arc exists to close, so the sentinel is pinned on
//     the side of the formula that keeps the direction safe.
//
// FAIL-SOFT (spec §6):
//   - A genuine per-project I/O error (EACCES, a corrupt/unreadable
//     directory, etc.) omits that project from the block and sets the
//     top-level degraded flag 'layers-partial'. It never aborts the whole
//     payload.
//   - The top-level captures/ directory not existing AT ALL is treated as
//     "zero projects have ever captured" (an empty, successfully-determined
//     result — the same class of truth as corpus's "0 points", not
//     'corpus-unavailable') rather than degraded. This deliberately does
//     NOT mirror stats.mjs's counters-db precedent (a missing counters db
//     IS flagged 'counters-unavailable' even on a never-existed file):
//     UM_VAULT_DIR is required for the server to run at all (see
//     mem0-mcp-http.mjs), so an absent/unusable vaultDir reaching THIS
//     module only happens in dev/test callers that never exercise the
//     layers path. Flagging every such caller degraded would stamp a new
//     `degraded` key onto every pre-existing /api/stats and /control test
//     in the suite for a state that cannot occur in a real deployment. A
//     REAL I/O error reading an EXISTING captures/ directory still
//     degrades, exactly like corpus-unavailable does for a throwing qdrant
//     client.
//   - Payload-level failure (the captures/ readdir itself throwing a
//     non-ENOENT error) → degraded entry, never a thrown 500.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFloor, DEFAULT_MIN_TRANSCRIPT_BYTES } from './checkpoint-config.mjs';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(LIB_DIR, '../config/checkpoint.json');

// Own scan-entry ceiling, following the SAME precedent/pattern as
// stats-payload.mjs's FULL_SCAN_LIMIT (a generous cap + a saturation flag)
// — NOT the same export. Importing FULL_SCAN_LIMIT back from stats-payload
// would create a stats-payload <-> layers import cycle (stats-payload
// calls buildLayers; layers would need stats-payload's export), and the two
// caps bound different resources (vault directory entries here, qdrant
// getAll points there) that happen to share a sensible default value, not
// a single shared identity.
export const LAYERS_SCAN_LIMIT = 10000;

// UM_SUMMARY_LAG_MAX_HOURS default (spec §6: "Threshold defaults to 30").
const DEFAULT_SUMMARY_LAG_MAX_HOURS = 30;

const RAW_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const SESSION_FILE_RE = /^session-(\d{4}-\d{2}-\d{2})-.*\.md$/;
const CURSOR_FILE_NAME_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const MS_PER_HOUR = 3_600_000;

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * UM_SUMMARY_LAG_MAX_HOURS resolver — the SAME local guard pattern
 * stats-payload.mjs's captureFreshnessThresholdHours() already established
 * for UM_FRESHNESS_MAX_AGE_HOURS (spec §6 explicitly calls out that
 * precedent): a set-but-blank env var must read as UNSET (never as
 * `Number('') === 0`, which would silently make every project permanently
 * eligible for staleness on the lag arm), while a deliberate '0' survives.
 */
function summaryLagMaxHours() {
  const raw = process.env.UM_SUMMARY_LAG_MAX_HOURS;
  const n = (raw == null || raw.trim() === '') ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SUMMARY_LAG_MAX_HOURS;
}

/**
 * Read + parse config/checkpoint.json once per buildLayers() call. Never
 * throws: a missing/corrupt config file falls back to `{}`, which makes
 * resolveFloor() fall through to DEFAULT_MIN_TRANSCRIPT_BYTES exactly like
 * an absent `min_transcript_bytes` key would — a monitoring read must never
 * 500 over a config nicety the write path already treats as optional.
 */
async function readCheckpointConfig() {
  try {
    return JSON.parse(await fs.readFile(DEFAULT_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** readdir that treats ENOENT as "nothing here yet" and re-throws anything else. */
async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Minimal, read-only cursor read for freshness ground truth — deliberately
 * NOT checkpoint-cursor.mjs's loadCursor(): no self-healing, no recovery
 * re-init, no turn-header byte alignment check (that machinery belongs to
 * the write path this module must not touch). Only the light shape guard
 * needed to trust the file/offset pair for positional arithmetic.
 *
 * Returns null for "cursorless", which covers BOTH "the file has never
 * existed" (the common §4.3 pre-first-run case) AND "the file exists but is
 * unparseable/shape-invalid". The second case is a deliberate choice, not
 * neglect: falling back to the §4.3 bootstrap computation (and, via
 * digested_through, to last_summary_at) is the SAFER direction for a
 * freshness monitor than omitting the whole project from the layers block
 * over one corrupt cursor file — silently losing a project from monitoring
 * would BE this arc's own root failure mode, where treating it as
 * cursorless instead merely risks an over-generous pending_bytes count
 * (trading a false-positive alert for that outcome, never a false-negative
 * one).
 */
async function readCursorLight(cursorPath) {
  let raw;
  try {
    raw = await fs.readFile(cursorPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.file !== 'string' || !CURSOR_FILE_NAME_RE.test(parsed.file)) return null;
    if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0) return null;
    const lastTurnIso = typeof parsed.last_turn_iso === 'string' ? parsed.last_turn_iso : null;
    return { file: parsed.file, offset: parsed.offset, lastTurnIso };
  } catch {
    return null;
  }
}

/**
 * One project's layers entry, or `null` when the project has no captures at
 * all (spec §6: the block only carries "per project with any captures").
 *
 * Scan bounds (spec §6): newest-summary discovery uses the lexical-max
 * filename DATE, then stats only THAT day's (few) files — sessions/ grows
 * one file per chunk forever, so a full-dir stat sweep would be unbounded.
 * `last_capture_at` similarly stats only the single newest raw file (raw
 * filenames are lexically == chronologically sorted).
 *
 * `budget` is mutated in place with the readdir-derived entry counts this
 * project consumed — the caller enforces LAYERS_SCAN_LIMIT across the whole
 * buildLayers() call, not per project.
 *
 * @throws on a genuine I/O error other than ENOENT — the caller's per-project
 *   try/catch is what turns that into 'layers-partial' + omission.
 */
async function computeProjectLayer({
  vaultDir, project, minTranscriptBytes, lagMaxHours, budget,
}) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  const sessionsDir = path.join(vaultDir, 'sessions', project);
  const stateDir = path.join(vaultDir, 'state', project);

  const rawEntries = (await readdirSafe(rawDir)).filter((n) => RAW_FILE_RE.test(n)).sort();
  budget.used += rawEntries.length;
  if (rawEntries.length === 0) return null; // no captures — not a layers-block project

  const sessionEntries = (await readdirSafe(sessionsDir)).filter((n) => SESSION_FILE_RE.test(n)).sort();
  budget.used += sessionEntries.length;

  // last_capture_at: newest raw file's mtime — stat only that one entry.
  const newestRawStat = await fs.stat(path.join(rawDir, rawEntries[rawEntries.length - 1]));
  const lastCaptureAt = newestRawStat.mtime.toISOString();
  const lastCaptureMs = newestRawStat.mtimeMs;

  // last_summary_at + the §4.3 bootstrap-boundary date, from the SAME
  // sessionEntries readdir (never a second scan for the cursorless
  // pending_bytes fallback below).
  let lastSummaryAt = null;
  let newestSummaryDate = null;
  if (sessionEntries.length > 0) {
    for (const name of sessionEntries) {
      const m = SESSION_FILE_RE.exec(name);
      if (newestSummaryDate === null || m[1] > newestSummaryDate) newestSummaryDate = m[1];
    }
    const sameDayFiles = sessionEntries.filter((n) => n.startsWith(`session-${newestSummaryDate}-`));
    let maxMs = -Infinity;
    for (const name of sameDayFiles) {
      const st = await fs.stat(path.join(sessionsDir, name));
      if (st.mtimeMs > maxMs) maxMs = st.mtimeMs;
    }
    lastSummaryAt = new Date(maxMs).toISOString();
  }

  // last_state_at
  let lastStateAt = null;
  try {
    const st = await fs.stat(path.join(stateDir, 'state.md'));
    lastStateAt = st.mtime.toISOString();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Cursor read (light, positional-only — see readCursorLight doc comment).
  const cursor = await readCursorLight(path.join(stateDir, 'checkpoint-cursor.json'));

  // pending_bytes (spec §6, positional semantics): full bytes of every raw
  // file lexically > cursor.file, plus (size - offset) of cursor.file
  // itself; files < cursor.file are fully digested and contribute 0.
  let pendingBytes = 0;
  if (cursor !== null) {
    for (const name of rawEntries) {
      if (name > cursor.file) {
        const st = await fs.stat(path.join(rawDir, name));
        pendingBytes += st.size;
      } else if (name === cursor.file) {
        const st = await fs.stat(path.join(rawDir, name));
        pendingBytes += Math.max(0, st.size - cursor.offset);
      }
      // name < cursor.file: already digested, contributes 0.
    }
  } else {
    // Cursorless — §4.3 bootstrap boundary, computed from the raw/session
    // readdirs already fetched above (never a third scan). No session
    // summaries at all ⇒ boundary is "digest everything" (bootstrapInit's
    // own no-summaries fallback); otherwise everything at/after the newest
    // summary DATE counts as pending (that day is re-digested from offset
    // 0, and everything after it is undigested by construction).
    const boundaryFile = newestSummaryDate !== null ? `${newestSummaryDate}.md` : null;
    for (const name of rawEntries) {
      if (boundaryFile === null || name >= boundaryFile) {
        const st = await fs.stat(path.join(rawDir, name));
        pendingBytes += st.size;
      }
    }
  }

  // digested_through / lag (spec §6 — see module header for the ∞-sign
  // rationale). A digested_through that fails to parse (corrupt
  // last_turn_iso, or a lastSummaryAt this module itself never produces
  // malformed but defended anyway) is treated the SAME as null — the safe
  // direction is always toward a larger, alerting lag, never a silently
  // masked NaN comparison that reads as "never stale".
  const digestedThrough = cursor !== null ? cursor.lastTurnIso : lastSummaryAt;
  const digestedThroughMs = digestedThrough === null ? NaN : Date.parse(digestedThrough);
  const lagHours = Number.isNaN(digestedThroughMs)
    ? Infinity
    : round1((lastCaptureMs - digestedThroughMs) / MS_PER_HOUR);

  const stale = pendingBytes >= minTranscriptBytes && lagHours > lagMaxHours;

  return {
    last_capture_at: lastCaptureAt,
    last_summary_at: lastSummaryAt,
    last_state_at: lastStateAt,
    pending_bytes: pendingBytes,
    stale,
    // JSON has no Infinity literal — JSON.stringify silently turns a bare
    // Infinity into `null`, which would be indistinguishable from "no lag
    // computed". Serialized as the STRING "Infinity" instead, matching the
    // exact float-coercion contract control-page.mjs's pyFloat() and
    // um-alert.sh's python block already speak for threshold/freshness
    // values (both parse "Infinity"/"inf" natively) — one convention, not a
    // second one invented for this field.
    lag_hours: Number.isFinite(lagHours) ? lagHours : 'Infinity',
  };
}

/**
 * Build the spec-§6 `layers` block: per-project filesystem-mtime freshness,
 * independent of the counters db.
 *
 * @param {object} opts
 * @param {string} [opts.vaultDir] - vault root; same resolution the caller
 *   (buildStats) already uses for checkpoint ctx (process.env.UM_VAULT_DIR),
 *   NOT vault.mjs's HOME-fallback vaultPath() — this must point at the exact
 *   directory checkpoint.mjs writes to, never a dev-convenience default.
 * @param {object} [opts.config] - parsed checkpoint.json (DI seam; a test
 *   supplies its own, production omits it and this reads config/checkpoint.json
 *   once per call — vault.mjs's "no in-memory caching" posture, so an
 *   operator's edit is picked up on the next request).
 * @param {number} [opts.scanLimit] - DI seam over LAYERS_SCAN_LIMIT (a test
 *   fixture that actually creates 10000 files to exercise saturation would
 *   be prohibitively slow — unlike stats-payload's FULL_SCAN_LIMIT boundary
 *   test, which only generates cheap in-memory objects). Production omits it.
 * @returns {Promise<{layers: object, degraded: string[]}>}
 */
export async function buildLayers({ vaultDir, config, scanLimit = LAYERS_SCAN_LIMIT } = {}) {
  const cfg = config ?? await readCheckpointConfig();
  const minTranscriptBytes = resolveFloor(
    'UM_CHECKPOINT_MIN_TRANSCRIPT_BYTES', cfg.min_transcript_bytes, DEFAULT_MIN_TRANSCRIPT_BYTES,
  );
  const lagMaxHours = summaryLagMaxHours();

  const layers = {};
  const degraded = [];

  if (typeof vaultDir !== 'string' || vaultDir === '') {
    return { layers, degraded }; // see module header — deliberately not flagged
  }

  const capturesDir = path.join(vaultDir, 'captures');
  let projectDirs;
  try {
    const entries = await fs.readdir(capturesDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return { layers, degraded }; // zero projects have ever captured
    safeLog(() => getLogger().warn({
      request_id: currentRequestId(),
      component: 'layers',
      err_class: err?.code ?? err?.name ?? 'Error',
      err_message: err?.message,
    }, 'layers: captures directory unreadable — serving degraded'), 'log:layers:captures-unavailable');
    degraded.push('layers-unavailable');
    return { layers, degraded };
  }

  const budget = { used: 0 };
  let sawPartial = false;
  let saturated = false;

  for (const project of projectDirs) {
    if (budget.used >= scanLimit) { saturated = true; break; }
    try {
      // Sequential, not Promise.all — intentional: the budget check above
      // must happen BEFORE each project's own scan, so scanLimit bounds the
      // whole vault deterministically rather than racing many projects'
      // readdirs against it concurrently.
      const entry = await computeProjectLayer({
        vaultDir, project, minTranscriptBytes, lagMaxHours, budget,
      });
      if (entry !== null) layers[project] = entry;
    } catch (err) {
      sawPartial = true;
      safeLog(() => getLogger().warn({
        request_id: currentRequestId(),
        component: 'layers',
        project,
        err_class: err?.code ?? err?.name ?? 'Error',
        err_message: err?.message,
      }, 'layers: per-project stat failed — omitting project'), 'log:layers:project-partial');
    }
  }

  if (sawPartial) degraded.push('layers-partial');
  if (saturated) degraded.push('layers_saturated');

  return { layers, degraded };
}
