// server/lib/idle-sweep.mjs — #314 (spec §4.2.2, D1-D11): the server digests the layers no
// session end reaches.
//
// One run an hour, inside the server (D1): read the layers block, keep the eligible layers —
// undigested and either idle for 6 h or waiting since MAX_AGE, or carrying a pending-reindex
// entry (D4) — drop those inside their retry window (D6), and attempt the oldest eight (D5),
// one at a time, each through doCheckpoint under the sweep's own surface (D8, D11). A provider
// failure ends the run (D6). Each attempt logs one `sweep.attempt` line; the two outcomes
// LAYERS-STALE does not report at once — a reindex-stage failure (the cursor already passed a
// summary that is not searchable; its repair record turns the layer stale only after the
// threshold) and a rejected call — are recorded as signal.sweep_failure (D7). The
// sweep never touches pending-reindex entries itself: a layer's checkpoint repairs them under
// its own lock. runOnce never rejects, logging can never break a run, and both timers are
// unref'd.

import fs from 'node:fs';
import path from 'node:path';
import { buildLayers as defaultBuildLayers, summaryLagMaxHours, readCursorLight } from './layers.mjs';
import { classifyCheckpointSettlement, SWEEP_FAILURE_EVENT } from './checkpoint-signal.mjs';
import { recordCaptureEvent, SWEEP_SURFACE } from './capture-events.mjs';
import { isWriteEnabled as defaultIsWriteEnabled } from './write-enabled.mjs';
import { priceFor } from './pricing.mjs';
import { summarizerTarget } from './summarize.mjs';
import { DEFAULT_STALE_MS } from './lockdir.mjs';
import { HEARTBEAT_INTERVAL_MS, DEFAULT_CONFIG_PATH } from './checkpoint-config.mjs';
import { getLogger } from './logger.mjs';

export const SWEEP_INTERVAL_MS = 60 * 60_000;
// D1: a lockdir orphaned by a crash mid-attempt is recoverable before the first run meets it.
export const SWEEP_FIRST_RUN_DELAY_MS = DEFAULT_STALE_MS + HEARTBEAT_INTERVAL_MS;

const MS_PER_HOUR = 3_600_000;
const IDLE_HOURS = 6;
// D4/D10: the age arm acts this many hourly runs before the alert threshold.
const AGE_LEAD_HOURS = 6;
const MAX_ATTEMPTS_PER_RUN = 8;
const RETRY_MS = 6 * MS_PER_HOUR;
const RATELIMIT_STREAK_LIMIT = 3;
// D10: below this LAG_MAX the floor max(1, LAG_MAX - 6) leaves the age arm no lead.
const LAG_MAX_WARN_BELOW = 8;
const PARTIAL_STOPS = new Set(['chunk_cap', 'raw_lock', 'cost_cap']);

/** D4: MAX_AGE, derived from the alert threshold's own resolver (never re-parsed). */
export function sweepMaxAgeHours(env = process.env) {
  return Math.max(1, summaryLagMaxHours(env) - AGE_LEAD_HOURS);
}

const iso = (ms) => new Date(ms).toISOString();
const errMessage = (err) => err?.message ?? String(err);
/** A payload hours field as a comparable number: "Infinity" is ∞, null (no wait) sorts last. */
const hoursOf = (v) => (v === 'Infinity' ? Infinity : typeof v === 'number' ? v : -Infinity);

/** D4: undigested and (idle >= 6 h or waited >= MAX_AGE), or a pending-reindex entry. */
function isEligible(l, t, maxAgeHours) {
  if (l.repair_since) return true;
  if (l.undigested !== true) return false;
  const idleHours = (t - Date.parse(l.last_capture_at)) / MS_PER_HOUR;
  return idleHours >= IDLE_HOURS || hoursOf(l.age_hours) >= maxAgeHours;
}

/** D5's order key: the longest wait, content or repair. */
function waitKey(l) {
  return Math.max(l.undigested === true ? hoursOf(l.age_hours) : -Infinity, l.repair_since ? hoursOf(l.repair_hours) : -Infinity);
}

/** D7: the closed outcome set — classifyCheckpointSettlement's values, then its null shapes. */
function outcomeOf(result, rejected) {
  const classified = classifyCheckpointSettlement({ result, rejected });
  if (classified !== null) return classified;
  if (result?.skipped === 'thin_transcript') return 'abstained';
  if (PARTIAL_STOPS.has(result?.stopped?.reason)) return 'partial';
  return 'digested';
}

function nextUtcDay(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

const defaultLog = {
  info: (obj, msg) => getLogger().info({ component: 'idle-sweep', ...obj }, msg),
  warn: (obj, msg) => getLogger().warn({ component: 'idle-sweep', ...obj }, msg),
  error: (obj, msg) => getLogger().error({ component: 'idle-sweep', ...obj }, msg),
};

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  clearInterval: (h) => clearInterval(h),
};

/**
 * @param {object} deps
 * @param {Function} deps.checkpointFn - doCheckpoint(args, ctx) in production.
 * @param {object} deps.ctx - the accepted-mode checkpoint ctx: `{ vaultDir, reindexFn }` (+ test
 *   DI). The sweep sets `surface: 'sweep'` itself and passes no lane or persona (D11).
 * @param {Function} [deps.buildLayers] - layers.mjs's buildLayers, called with `{ vaultDir, now }`.
 * @param {Function} [deps.isWriteEnabled] - checked at the start of every run (D11).
 * @param {object} [deps.env] - for UM_SUMMARY_LAG_MAX_HOURS (D4, D10).
 * @param {Function} [deps.now] - the clock, in ms.
 * @param {{info:Function, warn:Function, error:Function}} [deps.log]
 * @param {Function} [deps.recordEvent] - recordCaptureEvent; used only for signal.sweep_failure.
 * @param {Function} [deps.readCursor] - `({ vaultDir, project })` → readCursorLight's shape or null.
 * @param {object} [deps.timers] - setTimeout/setInterval/clearTimeout/clearInterval.
 * @param {{provider:string, model:string}|null} [deps.summarizer] - for the unpriced-model warning.
 * @returns {{runOnce:Function, start:Function, stop:Function, state:Function}}
 */
export function createIdleSweep({
  checkpointFn,
  ctx,
  buildLayers = defaultBuildLayers,
  isWriteEnabled = defaultIsWriteEnabled,
  env = process.env,
  now = Date.now,
  log = defaultLog,
  recordEvent = recordCaptureEvent,
  readCursor = ({ vaultDir, project }) => readCursorLight(path.join(vaultDir, 'state', project, 'checkpoint-cursor.json')),
  timers = defaultTimers,
  summarizer = null,
} = {}) {
  if (typeof checkpointFn !== 'function') throw new TypeError('createIdleSweep: checkpointFn is required');
  const vaultDir = ctx?.vaultDir;

  let running = false;
  let started = false;
  let firstTimer = null;
  let intervalTimer = null;
  let lastRunAt = null;
  let lastRun = null;
  const layersState = {};
  // D6, in memory: a restart resets both (at worst one extra attempt per layer).
  const nextEligible = new Map();
  const rateLimitStreak = new Map();

  const say = (level, obj, msg) => {
    try { log[level](obj, msg); } catch { /* a logger failure never breaks a run */ }
  };

  async function readPosition(project) {
    try {
      const c = await readCursor({ vaultDir, project });
      return c && typeof c.file === 'string' ? { file: c.file, offset: c.offset } : null;
    } catch {
      return null;
    }
  }

  /** D6: when the layer may be attempted again, and whether this outcome ends the run. */
  function retryDecision(project, result, rejected, t) {
    const prev = rateLimitStreak.get(project) ?? 0;
    const error = !rejected && result?.ok === false ? result.error : undefined;
    const stop = !rejected && result?.ok === true ? result.stopped?.reason : undefined;
    // A reindex-stage failure is never a provider stop, whatever its code (the repair owns it).
    const providerFailure = error?.code === 'UPSTREAM_FAILURE' && error.stage !== 'reindex';
    const rateLimited = (providerFailure && error.provider_class === 'ratelimit') || stop === 'provider_ratelimit';
    let streak = 0;
    let nextEligibleAt;
    let endRun = false;
    if (rateLimited) {
      streak = prev + 1;
      nextEligibleAt = streak >= RATELIMIT_STREAK_LIMIT ? t + RETRY_MS : null;
      endRun = true;
    } else if (providerFailure || stop === 'provider_failure') {
      nextEligibleAt = t + RETRY_MS; // a provider-class failure waits 6 h
      endRun = true;
    } else if (stop === 'cost_cap' || error === 'cost cap hit') {
      nextEligibleAt = nextUtcDay(t);
    } else if (result?.ok === true && result.backlog_remaining === true && (stop === 'chunk_cap' || stop === 'raw_lock')) {
      nextEligibleAt = null;
    } else {
      nextEligibleAt = t + RETRY_MS;
    }
    rateLimitStreak.set(project, streak);
    nextEligible.set(project, nextEligibleAt);
    return { nextEligibleAt, endRun };
  }

  async function attempt(project) {
    const startedAt = now();
    const cursorBefore = await readPosition(project);
    let result;
    let rejected = false;
    try {
      result = await checkpointFn({ project }, { ...ctx, surface: SWEEP_SURFACE });
    } catch (err) {
      rejected = true;
      say('warn', { project, err_message: errMessage(err) }, 'sweep: checkpoint rejected');
    }
    const cursorAfter = await readPosition(project);
    const settledAt = now();
    const outcome = outcomeOf(result, rejected);
    const stoppedReason = (!rejected && result?.ok === true && result.stopped?.reason) || null;
    const repair = (!rejected && result?.repairs) || null;
    const decision = retryDecision(project, result, rejected, settledAt);
    layersState[project] = {
      last_attempt_at: iso(settledAt),
      outcome,
      stopped_reason: stoppedReason,
      next_eligible_at: decision.nextEligibleAt === null ? null : iso(decision.nextEligibleAt),
      cursor_after: cursorAfter,
      repair,
    };
    say('info', {
      event: 'sweep.attempt',
      project,
      outcome,
      stopped_reason: stoppedReason,
      chunks_done: result?.chunks_done ?? null,
      backlog_remaining: result?.backlog_remaining ?? null,
      duration_ms: settledAt - startedAt,
      cursor_before: cursorBefore,
      cursor_after: cursorAfter,
      summary_path: result?.summary_path ?? null,
      repairs: repair,
    }, 'sweep.attempt');
    const failure = rejected ? 'rejected' : (result?.ok === false && result.error?.stage === 'reindex' ? 'reindex_failed' : null);
    if (failure !== null) {
      try {
        recordEvent({ surface: SWEEP_SURFACE, project, event: SWEEP_FAILURE_EVENT, outcome: failure });
      } catch (err) {
        say('warn', { project, err_message: errMessage(err) }, 'sweep: signal.sweep_failure not recorded');
      }
    }
    return decision;
  }

  async function sweepOnce() {
    const t = now();
    lastRunAt = t;
    lastRun = { eligible: null, attempted: 0 };
    let writes;
    try {
      writes = isWriteEnabled();
    } catch (err) {
      say('warn', { err_message: errMessage(err) }, 'sweep: write check failed; run skipped');
      return;
    }
    if (!writes) {
      return;
    }
    let layers;
    try {
      ({ layers } = await buildLayers({ vaultDir, now: t }));
    } catch (err) {
      say('warn', { err_message: errMessage(err) }, 'sweep: layers unreadable; run skipped');
      return;
    }
    const maxAgeHours = sweepMaxAgeHours(env);
    const eligible = Object.entries(layers ?? {})
      .filter(([, l]) => l !== null && typeof l === 'object' && isEligible(l, t, maxAgeHours))
      .filter(([name]) => !(nextEligible.get(name) > t))
      .sort(([a, la], [b, lb]) => (waitKey(lb) - waitKey(la)) || (a < b ? -1 : a > b ? 1 : 0));
    lastRun = { eligible: eligible.length, attempted: 0 };
    for (const [name] of eligible.slice(0, MAX_ATTEMPTS_PER_RUN)) {
      lastRun.attempted += 1;
      const decision = await attempt(name);
      if (decision.endRun) break;
    }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      await sweepOnce();
    } catch (err) {
      say('error', { err_message: errMessage(err) }, 'sweep: run failed');
    } finally {
      running = false;
    }
  }

  const api = {
    runOnce,
    start() {
      if (started) return api;
      started = true;
      const lagMaxHours = summaryLagMaxHours(env);
      if (lagMaxHours < LAG_MAX_WARN_BELOW) {
        say('warn', { lag_max_hours: lagMaxHours, max_age_hours: sweepMaxAgeHours(env) },
          `sweep: UM_SUMMARY_LAG_MAX_HOURS ${lagMaxHours} is under ${LAG_MAX_WARN_BELOW}, so the sweep cannot act before a layer reads stale`);
      }
      if (summarizer && priceFor(summarizer.provider, summarizer.model).type === 'unknown') {
        say('warn', { provider: summarizer.provider, model: summarizer.model },
          'sweep: the summarizer model has no price entry, so the per-project cost cap cannot bind');
      }
      const tick = () => runOnce().catch((err) => say('error', { err_message: errMessage(err) }, 'sweep: tick failed'));
      firstTimer = timers.setTimeout(tick, SWEEP_FIRST_RUN_DELAY_MS);
      firstTimer?.unref?.();
      intervalTimer = timers.setInterval(tick, SWEEP_INTERVAL_MS);
      intervalTimer?.unref?.();
      return api;
    },
    stop() {
      if (firstTimer !== null) timers.clearTimeout(firstTimer);
      if (intervalTimer !== null) timers.clearInterval(intervalTimer);
      firstTimer = null;
      intervalTimer = null;
      started = false;
    },
    state() {
      return {
        enabled: true,
        last_run_at: lastRunAt === null ? null : iso(lastRunAt),
        last_run: lastRun === null ? null : { ...lastRun },
        layers: Object.fromEntries(Object.entries(layersState).map(([k, v]) => [k, { ...v }])),
      };
    },
  };
  return api;
}

/** D10: opt-out — anything but a trimmed 'false' means on (the isAutoSupersedeEnabled convention). */
export function isSweepEnabled(env = process.env) {
  return env.UM_SWEEP_ENABLED?.trim() !== 'false';
}

function readShippedCheckpointConfig() {
  try {
    return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  } catch {
    return null; // the checkpoint itself reports an unreadable config; the warning is best effort
  }
}

/**
 * Spec §4.2.3: the server's boot hook, called in the IS_MAIN listen callback. Returns null when
 * the sweep is off (D10), else a started sweep (its first run comes SWEEP_FIRST_RUN_DELAY_MS later).
 *
 * The unpriced-model warning (§4.3.5) names the model a sweep checkpoint pays for: the chunk
 * transaction calls summarize() with `{ backend: UM_SUMMARIZER, model: checkpoint.json's
 * summary_model }` (checkpoint-chunk-txn.mjs, step 3; the sweep passes no model override), which
 * summarizerTarget resolves exactly as summarize() does.
 *
 * Never throws: the caller is the listen callback, where a throw is an uncaughtException and
 * lockdir.mjs exits the process on one. A sweep that cannot start logs once, clears any timer it
 * had already set, and returns null — the server runs on without it.
 *
 * @param {object} deps - createIdleSweep's deps, plus:
 * @param {object|null} [deps.config] - parsed checkpoint.json; read from disk when omitted.
 * @returns {ReturnType<typeof createIdleSweep>|null}
 */
export function startIdleSweep({ config = readShippedCheckpointConfig(), env = process.env, ...deps } = {}) {
  if (!isSweepEnabled(env)) return null;
  let sweep = null;
  try {
    const summarizer = summarizerTarget({ backend: env.UM_SUMMARIZER, model: config?.summary_model }, env);
    sweep = createIdleSweep({ ...deps, env, summarizer });
    return sweep.start();
  } catch (err) {
    try { sweep?.stop(); } catch { /* best effort */ }
    try {
      (deps.log ?? defaultLog).error({ err_message: errMessage(err) }, 'sweep: could not start; the server runs without it');
    } catch { /* a logger failure never escapes */ }
    return null;
  }
}
