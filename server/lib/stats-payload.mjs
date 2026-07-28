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
import { safeLog } from './obs-fallback.mjs';
import { getLogger } from './logger.mjs';
import { currentRequestId } from './request-context.mjs';
import { readCounterStats } from './stats.mjs';
import { SERVER_VERSION } from './version.mjs';
import { latencySinceBoot, LATENCY_LABEL } from './recall-telemetry.mjs';
import { isWriteEnabled } from './write-enabled.mjs';

// Full-corpus getAll ceiling for /health + /api/stats (#171 Stage A, plan U2
// audit): mem0ai's getAll defaults to limit=100, which silently truncated
// the /health count. Mirrors the compat facade's COMPAT_SCAN_LIMIT
// (mem0-compat.mjs) — generous for single-operator scale (hundreds–low-
// thousands of points). Owned here (not the entrypoint) because buildStats
// needs it internally and this module cannot import back from the
// entrypoint (see the isWriteEnabled note below); the entrypoint's /health
// route imports it back from here.
export const FULL_SCAN_LIMIT = 10000;

// Default capture-freshness alert threshold (hours) — R1 B2. Operator-
// overridable via UM_FRESHNESS_MAX_AGE_HOURS; a plain `|| 26` would eat a
// deliberate `0` (treat-as-always-stale), so the zero/negative/NaN cases
// are handled explicitly (R2-*-N5).
const DEFAULT_FRESHNESS_MAX_AGE_HOURS = 26;

function captureFreshnessThresholdHours() {
  const n = Number(process.env.UM_FRESHNESS_MAX_AGE_HOURS);
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
 * @returns {Promise<object>} the full stats body, including `degraded` when
 *   one or more sources are unavailable.
 */
export async function buildStats({ now, memory, userId, endpoint }) {
  const degraded = [];

  // Qdrant-sourced corpus fields. EXPLICIT large limit (FULL_SCAN_LIMIT) —
  // mem0ai getAll defaults to limit=100 (the /health silent-cap bug).
  let points = null;
  let pointsByProject = null;
  let scanSaturated = false;
  try {
    const raw = await memory.getAll({ userId, limit: FULL_SCAN_LIMIT });
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
  // db-state reasons — null-shaped when missing/unreadable, A5).
  const counters = readCounterStats({ now });
  if (!counters.available) degraded.push('counters-unavailable');

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
    recall: {
      searches_today: counters.recall?.searches_today ?? null,
      searches_7d: counters.recall?.searches_7d ?? null,
      latency_since_boot: { ...latencySinceBoot(), label: LATENCY_LABEL },
    },
  };
  if (degraded.length > 0) body.degraded = degraded;
  return body;
}
