// server/lib/stats-payload.mjs — U2.5 (#171 Stage B): the GET /api/stats
// payload builder, extracted out of mem0-mcp-http.mjs so a later in-process
// /control route can read the same stats without an HTTP round-trip.
//
// buildStats() is the load-bearing extraction: it is the ONLY place this
// payload is assembled. The route (mem0-mcp-http.mjs) is now a thin caller —
// it resolves `memory`/`userId`/`now`, calls buildStats(), and writes the
// result. A future /control page calls buildStats() directly with its own
// in-process memory client.
//
// Sources (spec §3): um-counters.db (read-only via readCounterStats —
// capture freshness, growth, recall counts), qdrant via memory.getAll
// (corpus size/split), the in-process ring buffer (serving latency),
// process/env facts.
//
// Degraded mode (§5 A5): a missing/unreadable counters db or a throwing
// memory client each null their OWN section + append a `degraded` marker —
// callers get a full payload either way (fresh installs have no counters
// db; stats must not fail over one dark source).
//
// CLOCK SEAM: `now` (epoch ms) is a required param, same convention as
// readCounterStats — no Date.now() in this module. The route passes
// Date.now(); tests pass frozen values.

import { filterSystemDocs } from './system-docs.mjs';
import { umGetAll, FULL_SCAN_LIMIT } from './mem0-read.mjs';
import { safeLog } from './obs-fallback.mjs';
import { getLogger } from './logger.mjs';
import { currentRequestId } from './request-context.mjs';
import { readCounterStats } from './stats.mjs';
import { SERVER_VERSION } from './version.mjs';
import { latencySinceBoot, LATENCY_LABEL } from './recall-telemetry.mjs';
import { isWriteEnabled } from './write-enabled.mjs';
import { buildLayers } from './layers.mjs';
import { undatedImputation, UNDATED_IMPUTATION_TTL_MS } from './undated-imputation.mjs';
import { undatedFactorFor } from './ranking.mjs';
import { isDecayEnabled, resolveHalfLifeDays } from './decay-env.mjs';

// Full-corpus getAll ceiling for /health + /api/stats (#171 Stage A, plan U2
// audit): mem0ai's getAll defaults to limit=100, which silently truncated
// the /health count. Mirrors the compat facade's COMPAT_SCAN_LIMIT
// (mem0-compat.mjs) — generous for single-operator scale (hundreds–low-
// thousands of points). Owned here (not the entrypoint) because buildStats
// needs it internally and this module cannot import back from the
// entrypoint (see the isWriteEnabled note below); the entrypoint's /health
// route imports it back from here.
export { FULL_SCAN_LIMIT };  // re-export; single owner is lib/mem0-read.mjs (#231 round-2)

// Default capture-freshness alert threshold (hours) — R1 B2. Operator-
// overridable via UM_FRESHNESS_MAX_AGE_HOURS; a plain `|| 26` would eat a
// deliberate `0` (treat-as-always-stale), so the zero/negative/NaN cases
// are handled explicitly (R2-*-N5).
const DEFAULT_FRESHNESS_MAX_AGE_HOURS = 26;

function captureFreshnessThresholdHours() {
  const raw = process.env.UM_FRESHNESS_MAX_AGE_HOURS;
  // A set-but-blank env var (`UM_FRESHNESS_MAX_AGE_HOURS=`, a common
  // docker/.env shape) must read as UNSET, not as `Number('') === 0` — that
  // would silently mark every surface permanently stale. Reclassify
  // null/undefined/whitespace-only as NaN so it falls through to the
  // default below; a deliberate '0' still parses to 0 and survives.
  const n = (raw == null || raw.trim() === '') ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FRESHNESS_MAX_AGE_HOURS;
}

/**
 * Build the GET /api/stats response body (spec §3 contract).
 *
 * @param {object} opts
 * @param {number} opts.now      - Clock seam: explicit epoch ms.
 * @param {object} opts.memory   - Resolved memory client (mem0 `getAll`).
 * @param {string} opts.userId   - Operator user id for the `getAll` scan.
 * @param {string} opts.endpoint - Route label threaded into the degraded
 *   corpus-fetch log (`endpoint` field) — the caller's identity, not a
 *   hardcoded '/api/stats': a future in-process /control caller passes its
 *   own label so logs/metrics attribute to the right surface.
 * @param {{get: Function}} [opts.imputation] - #297 (spec D16): the undated-imputation
 *   cache whose H-independent statistic the `undated_imputation` block reports. Defaults to
 *   the module singleton exactly as `listAll` defaults to `umGetAll`, so BOTH callers — the
 *   /api/stats route (which also passes `ctx?._undatedImputation`) and the in-process
 *   /control route — render the block with no edit to control-routes. Read-only here: stats
 *   NEVER triggers a refresh (D7 — a scan per operator pull, and the block would describe an
 *   epoch searches never saw).
 * @param {Function} [opts.readCounters] - DI seam over the counters-db reader
 *   (U5 / U3-gate finding F5: `readCounterStats` was a direct import with no
 *   seam). Defaults to `readCounterStats` — a caller that omits it gets
 *   IDENTICAL behavior to before this param existed. Tests inject a fake/
 *   throwing reader the same way `memory` is already injectable.
 * @param {string} [opts.vaultDir] - Task 10 (spec §6): vault root for the
 *   `layers` block's filesystem-mtime reads. Defaults to
 *   `process.env.UM_VAULT_DIR` — the SAME resolution checkpoint.mjs's own
 *   ctx.vaultDir fallback uses, not vault.mjs's HOME-fallback vaultPath()
 *   (this must point at the exact directory checkpoint writes to). Absent in
 *   most test callers, by design — see lib/layers.mjs's module header for
 *   why that is NOT treated as degraded.
 * @param {object} [opts.checkpointConfig] - DI seam over the parsed
 *   checkpoint.json layers.mjs needs for the #185 min_transcript_bytes
 *   floor. Production omits it; layers.mjs reads config/checkpoint.json
 *   itself once per call.
 * @returns {Promise<object>} the full stats body, including `degraded` when
 *   one or more sources are unavailable.
 */
export async function buildStats({
  now, memory, userId, endpoint, readCounters = readCounterStats,
  vaultDir = process.env.UM_VAULT_DIR, checkpointConfig,
  // #231: enumeration seam — production defaults to the native scroll
  // (lib/mem0-read); tests inject a canned {results} enumerator the same
  // way readCounters already works.
  listAll = umGetAll,
  imputation = undatedImputation,
}) {
  const degraded = [];

  // Qdrant-sourced corpus fields. EXPLICIT large limit (FULL_SCAN_LIMIT) —
  // mem0ai getAll defaults to limit=100 (the /health silent-cap bug).
  let points = null;
  let pointsByProject = null;
  let scanSaturated = false;
  try {
    // #231: native enumeration (mem0 3.x getAll cannot filter UM's camelCase
    // payload schema); shape parity with 2.4.6 getAll preserved in mem0-read.
    const raw = await listAll(memory, { userId, limit: FULL_SCAN_LIMIT });
    const rawItems = Array.isArray(raw) ? raw : (raw?.results ?? []);
    // R2-C-I3: authoritative saturation flag. `points` below is a POST-
    // filterSystemDocs count and cannot be compared to FULL_SCAN_LIMIT by a
    // caller without hardcoding 10000 — this module owns both numbers, so
    // it compares the PRE-filter length against its own cap.
    scanSaturated = rawItems.length >= FULL_SCAN_LIMIT;
    const items = filterSystemDocs(rawItems);
    points = items.length;
    // Null-prototype map: `project` comes from stored, writer-controlled
    // metadata — on a plain literal, '__proto__' vanishes via the
    // prototype setter and any Object.prototype member name (e.g.
    // 'constructor') reads the inherited value through `?? 0` and
    // serves a garbage concatenated string (v1.8.1 shipped bug).
    pointsByProject = Object.create(null);
    for (const r of items) {
      const project = r?.metadata?.project;
      // Fallback bucket: metadata.project is not guaranteed (plan U2).
      const key = typeof project === 'string' && project.length > 0 ? project : '(unknown)';
      pointsByProject[key] = (pointsByProject[key] ?? 0) + 1;
    }
  } catch (err) {
    safeLog(() => getLogger().warn({
      request_id: currentRequestId(),
      endpoint,
      err_class: err?.code ?? err?.name ?? 'Error',
      err_message: err?.message,
    }, 'stats corpus fetch failed — serving degraded'), 'log:stats:corpus-unavailable');
    degraded.push('corpus-unavailable');
    // Nothing was scanned on this path — scan_saturated stays false (the
    // key is never omitted; body shape stays stable across degraded modes).
  }

  // Counters-derived sections (readCounterStats never throws for
  // db-state reasons — null-shaped when missing/unreadable, A5). Goes
  // through the `readCounters` seam so a caller (or a test) can supply its
  // own reader; production never passes one, so this is exactly
  // `readCounterStats({ now })` unless overridden.
  const counters = readCounters({ now });
  if (!counters.available) degraded.push('counters-unavailable');

  // Task 10 (spec §6): the `layers` block — filesystem-mtime per-project
  // freshness, independent of the counters db above (never the same source
  // twice: this is what would have caught the 08-04 outage the counters-
  // derived `capture` section could not see). buildLayers() never throws —
  // its own degraded markers ('layers-unavailable' / 'layers-partial' /
  // 'layers_saturated') fold into this payload's degraded[] exactly like
  // corpus/counters do.
  const layersResult = await buildLayers({ vaultDir, config: checkpointConfig });
  if (layersResult.degraded.length > 0) degraded.push(...layersResult.degraded);

  // #297: the relative undated-imputation block (spec §4.2 step 5). The cache's INTERNAL
  // value is camelCase; it is mapped ONCE here to the payload's snake_case wire spelling (D24 —
  // the same in/out split readCounterStats already uses), never spread onto the wire. Every
  // wire key comes from exactly one source:
  //   enabled              isDecayEnabled() — the ONE owner doSearch also reads (D25)
  //   mode                 'fallback' | 'relative' — what an undated score is multiplied by
  //                        RIGHT NOW is `applied_factor`, not this word
  //   quantile             the policy quantile the statistic sits at (0.5 = median; a code
  //                        constant, not env — spec §4.6)
  //   cohort_n             dated, recallable, non-system, non-future points in the statistic
  //                        (null before the first successful refresh)
  //   age_days_at_quantile the H-independent statistic A_q (null in fallback)
  //   future_excluded      dated points beyond the clock-skew window, EXCLUDED from the
  //                        statistic and counted (D11)
  //   computed_at          epoch ms of the last SUCCESSFUL refresh (freshness), stamped with
  //                        that attempt's start instant; null before the first success
  //   last_attempt_at      epoch ms of the last refresh ATTEMPT, success or failure (the TTL
  //                        is keyed on it — D13); null before the first attempt
  //   last_refresh_ms      wall time of the last successful attempt, INCLUDING any retry
  //                        backoff (the refresh log line's scanDurationMs is the scan alone)
  //   last_scan_items      raw item count of the last successful scan
  //   last_refresh_failed  true when the LAST refresh ATTEMPT errored — never "the value is
  //                        old" (the refresh is lazy; a value is legitimately hours old
  //                        overnight on a single-operator install)
  //   last_error           that attempt's error message, else null
  //   saturated            the scan hit FULL_SCAN_LIMIT (the quantile is still computed)
  //   ttl_ms               the refresh cadence (a code constant)
  //   half_life_days       resolveHalfLifeDays() — the request-time H doSearch uses
  //   factor               null until a statistic exists, else undatedFactorFor(A_q, H)
  //   applied_factor       what doSearch multiplies an undated score by RIGHT NOW: 1 with
  //                        decay off, else factor ?? exp(-0.25) (D20 honesty rule — never the
  //                        fallback constant printed as if it were a live estimate)
  //   computed_age_ms      now − computed_at (null before the first success)
  //   attempt_age_ms       now − last_attempt_at (null before the first attempt)
  // Stuck-cache alert conditions for um-alert.sh (spec §4.5, the #239 flip rollout's job):
  //   (a) last_refresh_failed === true, or
  //   (b) computed_age_ms − attempt_age_ms > 2 × ttl_ms — the attempt-minus-success gap
  //       (last_attempt_at ≥ computed_at always, so the difference is non-negative);
  //   NOT wall-clock age of computed_at alone.
  // Presence-keyed like `layers`/`signals`: an ABSENT key ⇔ a pre-#297 server.
  const imp = imputation.get();
  const decayEnabled = isDecayEnabled();
  const halfLifeDays = resolveHalfLifeDays();
  const factor = imp.ageDaysAtQuantile == null ? null : undatedFactorFor(imp.ageDaysAtQuantile, halfLifeDays);
  const undatedImputationBlock = {
    enabled: decayEnabled,
    mode: imp.mode,
    quantile: imp.quantile,
    cohort_n: imp.cohortN,
    age_days_at_quantile: imp.ageDaysAtQuantile,
    future_excluded: imp.futureExcluded,
    computed_at: imp.computedAt,
    last_attempt_at: imp.lastAttemptAt,
    last_refresh_ms: imp.lastRefreshMs,
    last_scan_items: imp.lastScanItems,
    last_refresh_failed: imp.lastRefreshFailed,
    last_error: imp.lastError,
    saturated: imp.saturated,
    ttl_ms: UNDATED_IMPUTATION_TTL_MS,
    half_life_days: halfLifeDays,
    factor,
    applied_factor: decayEnabled ? undatedFactorFor(imp.ageDaysAtQuantile, halfLifeDays) : 1,
    computed_age_ms: imp.computedAt == null ? null : now - imp.computedAt,
    attempt_age_ms: imp.lastAttemptAt == null ? null : now - imp.lastAttemptAt,
  };

  const body = {
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    // R1 B2: operator-configured capture-freshness alert threshold (hours),
    // top-level — the later /control page compares surface freshness_hours
    // against this without hardcoding the default itself.
    capture_freshness_threshold_hours: captureFreshnessThresholdHours(),
    server: {
      version: SERVER_VERSION,
      uptime_s: Math.round(process.uptime()),
      writes_enabled: isWriteEnabled(),
      // CONFIGURED-value semantics (spec §3): the container cannot
      // introspect the actual mount; actual writability failures
      // surface via capture error counters instead.
      mount_mode: process.env.UM_MOUNT_MODE || 'unknown',
    },
    corpus: {
      points,
      points_by_project: pointsByProject,
      // R2-C-I3: whether the qdrant scan hit FULL_SCAN_LIMIT — `points` is
      // POST-filter and can't be compared to the cap by a caller without
      // hardcoding it; this module sets the flag authoritatively.
      scan_saturated: scanSaturated,
      growth_7d: counters.growth_7d,
      // #185: doc-tier writes (capture.checkpoint stored+error/day) —
      // session summaries bypass extraction, so growth_7d alone left a
      // runaway doc-tier writer invisible (the phantom-summary incident).
      growth_docs_7d: counters.growth_docs_7d,
      // Spec §3: growth is counters-derived (capture.extraction
      // stored+superseded/day), NOT a qdrant time-series — labeled.
      derived_from: 'extraction-counters',
    },
    capture: counters.capture,
    // Task 10 (spec §6): top-level so existing um-alert.sh/consumers stay
    // shape-safe (§6: "top-level keys are safe for existing um-alert.sh
    // consumers"). Always present from this version forward, even as `{}` —
    // um-alert.sh's own absent-key check is how a client tells "this server
    // predates the layers block" apart from "this server has zero projects
    // with captures".
    layers: layersResult.layers,
    // #267: client-reported anomaly signals (signal.capture_anomaly rows,
    // outside capture.%). Same always-present contract as `layers`: the
    // ABSENT key ⇔ a pre-#267 server (um-alert's ABSENT breadcrumb), null ⇔
    // counters degraded (mirrors capture: null), {} ⇔ healthy zero. LOOSE
    // null-check, never `===`: readCounters is a DI seam and a fake that
    // omits `anomalies` must degrade to the honest null, not mint the
    // malformed `{capture_anomaly: undefined}` shape (the banked
    // undefined-vs-null seam-contract class).
    signals: counters.anomalies == null ? null : { capture_anomaly: counters.anomalies },
    // #297: always present from this version forward (absent ⇔ a pre-#297 server); the
    // flip-owner's decision surface — see the block comment above for every key.
    undated_imputation: undatedImputationBlock,
    recall: {
      searches_today: counters.recall?.searches_today ?? null,
      searches_7d: counters.recall?.searches_7d ?? null,
      latency_since_boot: { ...latencySinceBoot(), label: LATENCY_LABEL },
    },
  };
  if (degraded.length > 0) body.degraded = degraded;
  return body;
}
