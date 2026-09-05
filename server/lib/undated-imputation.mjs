/**
 * server/lib/undated-imputation.mjs — the corpus-statistic cache behind relative undated
 * imputation (#297 spec §4.2 step 3).
 *
 * WHAT IT HOLDS. The H-INDEPENDENT statistic only (spec D12): the dated cohort's age at the
 * policy quantile (`ageDaysAtQuantile` = A_q), its size, the future-excluded count, and the
 * attempt/success bookkeeping. NEVER a factor and NEVER an H — `doSearch` derives the factor per
 * request with `undatedFactorFor(A_q, halfLife)` from the request's own H, so I3 (an undated item
 * and a dated item aged exactly A_q receive the same factor) holds even when H changes at runtime.
 *
 * HOW IT REFRESHES (spec D3/D13/D17, invariant I7 — at most ONE scan ATTEMPT per TTL per
 * instance, success or failure):
 *   - `get()` is synchronous and never awaits a scan; the STATISTIC fields of the served value
 *     never change between successful refreshes (the D13 attempt stamp does mint a new frozen
 *     object when an attempt starts), so one request's single read — taken BEFORE its
 *     refreshIfDue() kick — sees one epoch (I5).
 *   - `refreshIfDue()` is single-flight and fire-and-forget; its returned promise NEVER rejects
 *     (the whole body sits in one try/catch, and even the log calls are guarded). It runs when
 *     `now − lastAttemptAt ≥ UNDATED_IMPUTATION_TTL_MS` or nothing was ever attempted.
 *     `lastAttemptAt` is stamped BEFORE the scan, whatever the outcome (D13): a never-succeeding
 *     cache costs one attempt per TTL, not one per request.
 *   - Inside that ONE attempt the scan runs under the house `withRetry` (D17), so a transient
 *     qdrant blip is absorbed within the attempt while a real outage still costs at most the hour.
 *     Every try is bounded by UNDATED_IMPUTATION_SCAN_TIMEOUT_MS (code review, 2026-09-04): a
 *     scan that never settles would otherwise hold `inflight` forever — no further attempt, no
 *     warn, and BOTH §4.5 alert conditions silent (the attempt-minus-success gap pins at one
 *     TTL). A timed-out try is a failed try; a timed-out attempt is a failed attempt, which
 *     alert (a) sees. The qdrant client's own 300 s abort is a second, looser bound.
 *   - The scan's resolved value is normalised `Array.isArray(raw) ? raw : raw?.results`
 *     (`umGetAll` returns `{results}`; the stats-payload precedent). Any other shape — and a
 *     throw after retries — is a FAILED attempt: the last good value is kept, `lastRefreshFailed`
 *     and `lastError` are set, ONE warn is logged per failed attempt. `computedAt` is freshness:
 *     it moves only on success, and it is stamped with the attempt's START instant (the statistic
 *     reflects the corpus as of scan start), so `lastAttemptAt ≥ computedAt` holds exactly and
 *     the stats block's `computed_age_ms − attempt_age_ms` is the attempt-minus-success gap the
 *     stuck-cache alert reads (spec §4.5).
 *   - The cohort is what search can RETURN: `filterSystemDocs` + `isRecallable` are applied
 *     BEFORE `datedAgeQuantile` (P4). A `belowMinCohort` result is `mode: 'fallback'` with
 *     `cohortN` shown; the min-cohort decision itself lives in ranking.mjs (D14).
 *   - Saturation (`≥ FULL_SCAN_LIMIT` items): the quantile is still computed (a 10k sample is a
 *     fine quantile; qdrant scrolls in point-id order and UM ids are content-hash uuidv5 /
 *     randomUUID, so the first-10k window is age-unbiased) and `saturated: true` is set for the
 *     operator.
 *
 * LOG CONTRACT (spec §4.2 step 6 — machine-read by the CI smoke gate, the §7 proof-of-life grep,
 * the post-flip check and the rollback trigger; pinned VERBATIM, R6 asserts the strings):
 *   info `undated-imputation: refreshed` {mode, cohortN, ageDaysAtQuantile, futureExcluded,
 *        saturated, scanDurationMs, scanItems}   — H-independent fields only
 *   warn `undated-imputation: refresh failed — serving <mode>`
 *
 * DI SEAMS: `scan`, `now`, `log`, `retry` — no `halfLifeDays` (D12). The module also exports a
 * module-level SINGLETON created UNCONFIGURED (D16): until `configure({scan})` is called, `get()`
 * returns the fallback value and `refreshIfDue()` is a no-op that records no attempt.
 * `initMemory()` in mem0-mcp-http.mjs injects the scan as a THUNK over its live `memory`
 * binding, so a singleton built at import time is correct after boot; `buildStats` defaults to
 * the same singleton so both stats callers render the block.
 */

import { withRetry } from './retry.mjs';
import { filterSystemDocs } from './system-docs.mjs';
import { isRecallable } from './recallable.mjs';
import { datedAgeQuantile, UNDATED_QUANTILE } from './ranking.mjs';
import { FULL_SCAN_LIMIT } from './mem0-read.mjs';
import { getLogger } from './logger.mjs';

/**
 * Refresh cadence. One hour because A_q drifts ~0.042 d per hour by pure ageing (composition
 * adds ~0.33 points/hour to a 400-point cohort), i.e. ~0.14 % factor drift per hour and ~3.4 %
 * per day: one hour bounds the served factor within ~0.2 % of live at 24 scans/day — chosen for
 * operator legibility during the #239 window, not from a cost constraint (spec §4.6, R-f: not
 * an env knob). Pinned by R6.
 */
export const UNDATED_IMPUTATION_TTL_MS = 3_600_000;

/**
 * Per-try bound on the scan (code review 2026-09-04). Generous against the §4.5 budget (a
 * 10k-point scan is ~250 ms on the Pi; the revisit trigger is 500 ms) and tighter than the qdrant
 * client's 300 s abort; with withRetry's 3 retries an attempt settles within ~4 minutes worst
 * case, well inside one TTL. A timed-out attempt is a FAILED attempt — never a hung cache.
 */
export const UNDATED_IMPUTATION_SCAN_TIMEOUT_MS = 60_000;

const REFRESHED_MSG = 'undated-imputation: refreshed';
const FAILED_MSG_PREFIX = 'undated-imputation: refresh failed — serving ';

const FALLBACK_VALUE = Object.freeze({
  mode: 'fallback',
  quantile: UNDATED_QUANTILE,
  cohortN: null,
  ageDaysAtQuantile: null,
  futureExcluded: null,
  computedAt: null,
  lastAttemptAt: null,
  lastRefreshMs: null,
  lastScanItems: null,
  lastRefreshFailed: false,
  saturated: false,
  lastError: null,
});

/** A log call must never turn a refresh into a rejection. */
function safely(fn) {
  try { fn(); } catch { /* a throwing logger is not this module's failure to surface */ }
}

/**
 * Bound on `lastError` (code review 2026-09-04): the retry envelope carries the upstream message
 * verbatim — a qdrant/mem0 SDK error can embed a response body — and the value is re-served on
 * every /api/stats GET for up to a TTL. Capped, never unbounded.
 */
export const UNDATED_IMPUTATION_ERROR_MAX_CHARS = 300;

/** A throw value with no usable string form must not turn the failure path into a rejection. */
function errorText(err) {
  try { return String(err?.message ?? err).slice(0, UNDATED_IMPUTATION_ERROR_MAX_CHARS); } catch { return 'unknown error'; }
}

/** Race a scan call against the per-try bound; the timer is cleared as soon as the race settles. */
function withScanTimeout(promise, ms) {
  let timer;
  const bound = new Promise((_, reject) => {
    // The timer stays ref'd on purpose: an unref'd bound can only fire while something ELSE keeps the loop
    // alive, so a hung scan in an otherwise idle process would never time out (CI caught this under Node 22).
    // It is cleared the moment the race settles, so it never outlives the attempt it bounds.
    timer = setTimeout(() => reject(new Error(`scan timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/**
 * Build a cache instance.
 *
 * @param {object} [deps]
 * @param {(() => Promise<unknown>)|null} [deps.scan] - full-corpus enumerator; production passes a
 *   thunk over `umGetAll(memory, {userId, limit: FULL_SCAN_LIMIT})`. `null` = unconfigured (D16).
 * @param {() => number} [deps.now] - clock seam (epoch ms).
 * @param {{info: Function, warn: Function}} [deps.log] - logger seam (pino-shaped: `(fields, msg)`).
 * @param {(fn: Function, opts: object) => Promise<unknown>} [deps.retry] - retry seam (the house
 *   `withRetry` by default — spec D17).
 * @param {number} [deps.scanTimeoutMs] - per-try bound (default UNDATED_IMPUTATION_SCAN_TIMEOUT_MS);
 *   a DI seam so the hang→failed-attempt path is provable with a short real timer.
 */
export function createUndatedImputation({ scan = null, now = Date.now, log, retry = withRetry, scanTimeoutMs = UNDATED_IMPUTATION_SCAN_TIMEOUT_MS } = {}) {
  let scanFn = typeof scan === 'function' ? scan : null;
  let value = FALLBACK_VALUE;
  let inflight = null;
  const logger = () => log ?? getLogger();

  /** The current value: synchronous, frozen, the same object until a refresh lands. */
  function get() {
    return value;
  }

  /**
   * Inject (or replace) the scan seam — the boot-time step for the module singleton (D16).
   * Key-present semantics: `configure({})` / `configure()` change nothing; an explicit
   * non-function `scan` un-configures (code review 2026-09-04 — an absent key must never
   * silently kill a live cache).
   */
  function configure({ scan: nextScan } = {}) {
    if (nextScan === undefined) return;
    scanFn = typeof nextScan === 'function' ? nextScan : null;
  }

  /**
   * Kick a refresh if the TTL has elapsed (or nothing was ever attempted). Never rejects and
   * never throws — including a throwing `now()` seam (code review 2026-09-04). A NEGATIVE
   * elapsed time means the clock stepped backwards (NTP / VM resync): treated as due, so a
   * step back can never freeze refreshes for its length.
   */
  function refreshIfDue() {
    try {
      if (scanFn === null) return Promise.resolve();
      if (inflight) return inflight;
      const t = now();
      const elapsed = t - value.lastAttemptAt;
      if (value.lastAttemptAt != null && elapsed >= 0 && elapsed < UNDATED_IMPUTATION_TTL_MS) {
        return Promise.resolve();
      }
      inflight = attempt(t).catch(() => {}).finally(() => { inflight = null; });
      return inflight;
    } catch {
      return Promise.resolve();
    }
  }

  async function attempt(startedAt) {
    // D13: the attempt is stamped BEFORE the scan, whatever happens next.
    value = Object.freeze({ ...value, lastAttemptAt: startedAt });
    // The scan is captured ONCE per attempt: a configure() landing mid-attempt must not be
    // adopted by this attempt's retries (an attempt started under scan A never commits data
    // from scan B — code review 2026-09-04).
    const scan = scanFn;
    try {
      let scanDurationMs = 0;
      const raw = await retry(async () => {
        const s0 = now();
        // scan() is invoked SYNCHRONOUSLY here (single-flight counts on it: ten concurrent
        // refreshIfDue() calls must see one in-flight scan before any microtask runs); a
        // synchronous throw becomes this async closure's rejection, which withRetry handles.
        const r = await withScanTimeout(scan(), scanTimeoutMs);
        scanDurationMs = now() - s0;
        return r;
      }, { op: 'undated-imputation-scan' });
      const items = Array.isArray(raw) ? raw : raw?.results;
      if (!Array.isArray(items)) {
        throw new Error('scan resolved to neither an array nor {results: array}');
      }
      const cohort = filterSystemDocs(items).filter(isRecallable);
      const q = datedAgeQuantile(cohort, { now: startedAt });
      const next = {
        mode: q.ageDays == null ? 'fallback' : 'relative',
        quantile: UNDATED_QUANTILE,
        cohortN: q.n,
        ageDaysAtQuantile: q.ageDays,
        futureExcluded: q.futureExcluded,
        computedAt: startedAt,
        lastAttemptAt: startedAt,
        lastRefreshMs: now() - startedAt,
        lastScanItems: items.length,
        lastRefreshFailed: false,
        saturated: items.length >= FULL_SCAN_LIMIT,
        lastError: null,
      };
      value = Object.freeze(next);
      safely(() => logger().info({
        mode: next.mode,
        cohortN: next.cohortN,
        ageDaysAtQuantile: next.ageDaysAtQuantile,
        futureExcluded: next.futureExcluded,
        saturated: next.saturated,
        scanDurationMs,
        scanItems: next.lastScanItems,
      }, REFRESHED_MSG));
    } catch (err) {
      value = Object.freeze({
        ...value,
        lastRefreshFailed: true,
        lastError: errorText(err),
      });
      const mode = value.mode;
      safely(() => logger().warn({
        err_class: err?.code ?? err?.name ?? 'Error',
        err_message: err?.message,
        mode,
      }, `${FAILED_MSG_PREFIX}${mode}`));
    }
  }

  return { get, refreshIfDue, configure };
}

/**
 * The module-level singleton (D16): created UNCONFIGURED. `initMemory()` calls
 * `undatedImputation.configure({scan})` right after it assigns the module-level `memory`.
 */
export const undatedImputation = createUndatedImputation();
