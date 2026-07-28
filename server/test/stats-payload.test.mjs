// server/test/stats-payload.test.mjs — U2.5 (#171 Stage B): unit suite for
// server/lib/stats-payload.mjs's buildStats(), the extracted GET /api/stats
// payload builder.
//
// api-stats.test.mjs remains the HTTP-level regression contract for the
// route (auth, endpoint-class, rate-limit, wire shape). This suite tests
// buildStats() directly — no HTTP server — covering the two additive
// fields (R1 B2 capture_freshness_threshold_hours, R2-C-I3
// corpus.scan_saturated) plus the three degraded shapes and the `endpoint`
// param threaded into the degraded corpus-fetch log (the hazard called out
// in plan U2.5: the log used to hardcode '/api/stats').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { buildStats, FULL_SCAN_LIMIT } from '../lib/stats-payload.mjs';
import { _setLogStreamForTest } from '../lib/logger.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ---------- helpers ----------

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = Date.now();

async function tempDbPath(prefix = 'um-stats-payload-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'um-counters.db');
}

// Direct-SQL seeding with the pinned T5 schema (same shape as
// api-stats.test.mjs / stats.test.mjs — recordCaptureEvent hardcodes
// day=today, so tests that need "today" rows write it explicitly).
function seedDb(dbPath, rows = []) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        day     TEXT    NOT NULL,
        surface TEXT    NOT NULL,
        project TEXT    NOT NULL,
        event   TEXT    NOT NULL,
        outcome TEXT    NOT NULL,
        count   INTEGER NOT NULL,
        PRIMARY KEY (day, surface, project, event, outcome)
      )
    `);
    db.pragma('user_version = 1');
    const stmt = db.prepare(`
      INSERT INTO counters (day, surface, project, event, outcome, count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, surface, project, event, outcome)
      DO UPDATE SET count = count + excluded.count
    `);
    for (const r of rows) {
      stmt.run(r.day ?? TODAY, r.surface ?? 'claude-code', r.project ?? '', r.event, r.outcome ?? '', r.count ?? 1);
    }
  } finally {
    db.close();
  }
}

// Fake memory client: getAll returns exactly `pointCount` items regardless
// of the requested limit (unlike api-stats.test.mjs's makeFakeMemory, which
// deliberately mimics mem0's silent 100-cap to prove the /health fix — that
// concern is the route's, already covered there; this suite controls the
// PRE-filter count directly for the scan_saturated boundary tests).
function makeFakeMemory(pointCount, { getAllThrows = false } = {}) {
  const items = Array.from({ length: pointCount }, (_, i) => ({
    id: `uuid-${i}`,
    memory: `memory body ${i}`,
    metadata: { id: `doc-${i}`, title: `t${i}`, project: i % 2 === 0 ? 'um' : 'edge' },
  }));
  return {
    getAll: async () => {
      if (getAllThrows) throw new Error('qdrant down');
      return { results: items };
    },
  };
}

async function withEnv(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeCaptureSink(captured) {
  return new Writable({
    write(chunk, enc, cb) {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        try { captured.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
      cb();
    },
  });
}

// ---------------------------------------------------------------------------
// Documented body shape
// ---------------------------------------------------------------------------

test('buildStats: documented body shape — every §3 field present and correctly typed', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [
    { day: TODAY, event: 'capture.turn', outcome: 'stored', count: 4 },
    { day: TODAY, event: 'capture.extraction', outcome: 'stored', count: 2 },
    { day: TODAY, event: 'recall.search', outcome: '', count: 7 },
  ]);
  await withEnv({ UM_COUNTERS_DB_PATH: dbPath }, async () => {
    const body = await buildStats({
      now: NOW, memory: makeFakeMemory(9), userId: 'op', endpoint: '/api/stats',
    });

    assert.equal(body.schema_version, 1);
    assert.ok(!Number.isNaN(Date.parse(body.generated_at)));
    assert.equal(typeof body.capture_freshness_threshold_hours, 'number');

    assert.equal(typeof body.server.version, 'string');
    assert.equal(typeof body.server.uptime_s, 'number');
    assert.equal(typeof body.server.writes_enabled, 'boolean');
    assert.equal(typeof body.server.mount_mode, 'string');

    assert.equal(body.corpus.points, 9);
    // points_by_project is a null-prototype map (v1.8.1 hostile-key hardening)
    // — compared field-by-field rather than via deepEqual against a plain
    // object literal, whose prototype would never match.
    assert.equal(body.corpus.points_by_project.um, 5);
    assert.equal(body.corpus.points_by_project.edge, 4);
    assert.equal(body.corpus.scan_saturated, false);
    assert.equal(Object.keys(body.corpus.growth_7d).length, 7);
    assert.equal(Object.keys(body.corpus.growth_docs_7d).length, 7);
    assert.equal(body.corpus.derived_from, 'extraction-counters');

    assert.equal(typeof body.capture, 'object');
    assert.equal(typeof body.recall.searches_today, 'number');
    assert.equal(typeof body.recall.searches_7d, 'number');
    assert.equal(
      body.recall.latency_since_boot.label,
      'deployment serving latency (includes engine + embedding time)',
    );
    assert.equal(body.degraded, undefined, 'every source live ⇒ no degraded key');
  });
});

// ---------------------------------------------------------------------------
// capture_freshness_threshold_hours (R1 B2, R2-*-N5)
// ---------------------------------------------------------------------------

test('capture_freshness_threshold_hours: defaults to 26 when UM_FRESHNESS_MAX_AGE_HOURS is unset', async () => {
  await withEnv({ UM_FRESHNESS_MAX_AGE_HOURS: undefined }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(0), userId: 'op', endpoint: '/x' });
    assert.equal(body.capture_freshness_threshold_hours, 26);
  });
});

test('capture_freshness_threshold_hours: honors a positive env override', async () => {
  await withEnv({ UM_FRESHNESS_MAX_AGE_HOURS: '48' }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(0), userId: 'op', endpoint: '/x' });
    assert.equal(body.capture_freshness_threshold_hours, 48);
  });
});

test('capture_freshness_threshold_hours: "0" stays 0 — never coerced to 26 by a plain || fallback', async () => {
  await withEnv({ UM_FRESHNESS_MAX_AGE_HOURS: '0' }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(0), userId: 'op', endpoint: '/x' });
    assert.equal(body.capture_freshness_threshold_hours, 0);
  });
});

test('capture_freshness_threshold_hours: negative env value falls back to 26', async () => {
  await withEnv({ UM_FRESHNESS_MAX_AGE_HOURS: '-5' }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(0), userId: 'op', endpoint: '/x' });
    assert.equal(body.capture_freshness_threshold_hours, 26);
  });
});

test('capture_freshness_threshold_hours: non-numeric env value (NaN) falls back to 26', async () => {
  await withEnv({ UM_FRESHNESS_MAX_AGE_HOURS: 'not-a-number' }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(0), userId: 'op', endpoint: '/x' });
    assert.equal(body.capture_freshness_threshold_hours, 26);
  });
});

// Round-1 review fix (Minor): a set-but-blank env var (`UM_FRESHNESS_MAX_AGE_HOURS=`, the
// common docker/.env shape) must NOT read as `Number('') === 0` — that would silently mark
// every surface permanently stale. Blank/whitespace-only reclassifies as UNSET (→ 26);
// a deliberate '0' (tested above) must still survive as 0.
test('capture_freshness_threshold_hours: empty-string env value ("" — set but blank) falls back to 26, NOT 0', async () => {
  await withEnv({ UM_FRESHNESS_MAX_AGE_HOURS: '' }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(0), userId: 'op', endpoint: '/x' });
    assert.equal(body.capture_freshness_threshold_hours, 26);
  });
});

test('capture_freshness_threshold_hours: whitespace-only env value falls back to 26, NOT 0', async () => {
  await withEnv({ UM_FRESHNESS_MAX_AGE_HOURS: '   ' }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(0), userId: 'op', endpoint: '/x' });
    assert.equal(body.capture_freshness_threshold_hours, 26);
  });
});

// ---------------------------------------------------------------------------
// corpus.scan_saturated (R2-C-I3)
// ---------------------------------------------------------------------------

test('scan_saturated: false when the pre-filter corpus is well under FULL_SCAN_LIMIT', async () => {
  const body = await buildStats({ now: NOW, memory: makeFakeMemory(5), userId: 'op', endpoint: '/x' });
  assert.equal(body.corpus.scan_saturated, false);
});

test('scan_saturated: true when the pre-filter corpus length hits FULL_SCAN_LIMIT exactly (>= boundary)', async () => {
  const body = await buildStats({ now: NOW, memory: makeFakeMemory(FULL_SCAN_LIMIT), userId: 'op', endpoint: '/x' });
  assert.equal(body.corpus.points, FULL_SCAN_LIMIT, 'sanity: no system docs to filter out of this fixture');
  assert.equal(body.corpus.scan_saturated, true);
});

test('scan_saturated: false one point under the cap (boundary is >=, not >)', async () => {
  const body = await buildStats({
    now: NOW, memory: makeFakeMemory(FULL_SCAN_LIMIT - 1), userId: 'op', endpoint: '/x',
  });
  assert.equal(body.corpus.scan_saturated, false);
});

// ---------------------------------------------------------------------------
// growth_docs_7d (#185 doc-tier growth, Δ-review R1 pin)
// ---------------------------------------------------------------------------

test('growth_docs_7d: present + zero-filled 7-key map when no capture.checkpoint rows exist', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [{ day: TODAY, event: 'capture.extraction', outcome: 'stored', count: 3 }]);
  await withEnv({ UM_COUNTERS_DB_PATH: dbPath }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(1), userId: 'op', endpoint: '/x' });
    assert.equal(Object.keys(body.corpus.growth_docs_7d).length, 7);
    assert.equal(body.corpus.growth_docs_7d[TODAY], 0);
  });
});

test('growth_docs_7d: a capture.checkpoint stored row today is counted', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [{ day: TODAY, event: 'capture.checkpoint', outcome: 'stored', count: 5 }]);
  await withEnv({ UM_COUNTERS_DB_PATH: dbPath }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(1), userId: 'op', endpoint: '/x' });
    assert.equal(body.corpus.growth_docs_7d[TODAY], 5);
  });
});

test('growth_docs_7d: null when counters are degraded (missing db)', async () => {
  const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'um-stats-payload-miss-')), 'nope.db');
  await withEnv({ UM_COUNTERS_DB_PATH: missing }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(1), userId: 'op', endpoint: '/x' });
    assert.equal(body.corpus.growth_docs_7d, null);
    assert.equal(body.corpus.growth_7d, null);
    assert.equal(body.capture, null);
  });
});

// ---------------------------------------------------------------------------
// Three degraded shapes (§5 A5)
// ---------------------------------------------------------------------------

test('degraded: counters-unavailable only — corpus fields stay live', async () => {
  const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'um-stats-payload-miss2-')), 'nope.db');
  await withEnv({ UM_COUNTERS_DB_PATH: missing }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(3), userId: 'op', endpoint: '/x' });
    assert.deepEqual(body.degraded, ['counters-unavailable']);
    assert.equal(body.corpus.points, 3);
    assert.equal(typeof body.corpus.points_by_project, 'object');
    assert.equal(body.corpus.scan_saturated, false);
    assert.equal(body.capture, null);
    assert.equal(body.corpus.growth_7d, null);
    assert.equal(body.corpus.growth_docs_7d, null);
    assert.equal(body.recall.searches_today, null);
  });
});

test('degraded: corpus-unavailable only — counters fields stay live, scan_saturated stays false (nothing scanned)', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [{ day: TODAY, event: 'capture.turn', outcome: 'stored', count: 1 }]);
  await withEnv({ UM_COUNTERS_DB_PATH: dbPath }, async () => {
    const body = await buildStats({
      now: NOW, memory: makeFakeMemory(3, { getAllThrows: true }), userId: 'op', endpoint: '/x',
    });
    assert.deepEqual(body.degraded, ['corpus-unavailable']);
    assert.equal(body.corpus.points, null);
    assert.equal(body.corpus.points_by_project, null);
    assert.equal(body.corpus.scan_saturated, false, 'key stays present and false — nothing was scanned');
    assert.ok(body.capture, 'counters-derived sections stay live');
  });
});

test('degraded: both sources down at once — degraded lists both markers', async () => {
  const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'um-stats-payload-miss3-')), 'nope.db');
  await withEnv({ UM_COUNTERS_DB_PATH: missing }, async () => {
    const body = await buildStats({
      now: NOW, memory: makeFakeMemory(3, { getAllThrows: true }), userId: 'op', endpoint: '/x',
    });
    assert.deepEqual(body.degraded, ['corpus-unavailable', 'counters-unavailable']);
    assert.equal(body.corpus.points, null);
    assert.equal(body.capture, null);
  });
});

// ---------------------------------------------------------------------------
// `endpoint` param threaded into the degraded corpus-fetch log (plan U2.5
// hazard: the log used to hardcode '/api/stats' — a later in-process
// /control caller must not mislabel logs/metrics under that literal).
// ---------------------------------------------------------------------------

test('endpoint param is threaded into the degraded corpus-fetch log, not hardcoded', async () => {
  const captured = [];
  _setLogStreamForTest(makeCaptureSink(captured));
  try {
    await buildStats({
      now: NOW,
      memory: { getAll: async () => { throw new Error('qdrant down'); } },
      userId: 'op',
      endpoint: '/control/stats-in-process',
    });
    const line = captured.find((l) => l.msg === 'stats corpus fetch failed — serving degraded');
    assert.ok(line, 'the degraded corpus-fetch log line was emitted');
    assert.equal(line.endpoint, '/control/stats-in-process', 'endpoint must reflect the caller-supplied param');
  } finally {
    _setLogStreamForTest(null);
  }
});

// ---------------------------------------------------------------------------
// `readCounters` DI seam (U5 / U3-gate finding F5): readCounterStats was a
// direct import inside this module with no seam. buildStats({..., readCounters
// = readCounterStats}) is a DEFAULTED param — a caller that omits it (every
// existing call site above, and the /api/stats route) gets IDENTICAL behavior
// to before this param existed. The /control route (server/lib/control-routes.mjs,
// U5) threads an injectable reader through so its own A1 ordering test can
// prove the authenticated branch — and ONLY the authenticated branch — reads
// the counters db, exactly like it already does for `memory`.
// ---------------------------------------------------------------------------

test('readCounters: an injected reader supersedes readCounterStats — the seam actually replaces the read', async () => {
  const fakeShape = {
    available: true,
    capture: {
      'synthetic-surface': {
        last_day_seen: TODAY,
        freshness_hours: 0,
        events_today: 3,
        errors_today: 0,
        outcomes_7d: { stored: 3, abstained: 0, deduped: 0, superseded: 0, error: 0 },
      },
    },
    growth_7d: { [TODAY]: 3 },
    growth_docs_7d: { [TODAY]: 0 },
    recall: { searches_today: 1, searches_7d: 2 },
  };
  let calledWithNow;
  const readCounters = ({ now: n }) => { calledWithNow = n; return fakeShape; };
  // A nonsense UM_COUNTERS_DB_PATH proves the override REPLACES the read
  // rather than merely running alongside the real one — if buildStats still
  // consulted readCounterStats under the hood, this path would degrade to
  // counters-unavailable instead of reflecting fakeShape.
  await withEnv({ UM_COUNTERS_DB_PATH: path.join(os.tmpdir(), 'um-stats-payload-seam-does-not-exist.db') }, async () => {
    const body = await buildStats({
      now: NOW, memory: makeFakeMemory(1), userId: 'op', endpoint: '/x', readCounters,
    });
    assert.equal(calledWithNow, NOW, 'buildStats forwards its own `now` seam to the injected reader');
    assert.deepEqual(body.capture, fakeShape.capture);
    assert.deepEqual(body.corpus.growth_7d, fakeShape.growth_7d);
    assert.deepEqual(body.corpus.growth_docs_7d, fakeShape.growth_docs_7d);
    assert.equal(body.recall.searches_today, 1);
    assert.equal(body.recall.searches_7d, 2);
    assert.equal(body.degraded, undefined, 'the injected reader reports available:true — no degraded marker');
  });
});

test('readCounters: omitting the param falls back to readCounterStats — zero behavior change', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [{ day: TODAY, event: 'capture.extraction', outcome: 'stored', count: 2 }]);
  await withEnv({ UM_COUNTERS_DB_PATH: dbPath }, async () => {
    const body = await buildStats({ now: NOW, memory: makeFakeMemory(1), userId: 'op', endpoint: '/x' });
    assert.equal(body.corpus.growth_7d[TODAY], 2, 'no readCounters param ⇒ the real readCounterStats reads the seeded db');
    assert.equal(body.degraded, undefined);
  });
});
