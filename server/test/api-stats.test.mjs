// server/test/api-stats.test.mjs — U2 (#171 Stage A): recall telemetry (both
// production read paths) + GET /api/stats.
//
// Covers (spec §3 contract + §5 A1/A4/A5, plan U2):
//   • Endpoint-class row: /api/stats = auth+rate-limit always on PLUS the NEW
//     decoupled noLoopbackBypass marker (NOT compat:true — token scheme and
//     error dialect stay standard, spec §3 R1 finding).
//   • A1: 401 without token; 401 FROM LOOPBACK without token (bypass vetoed);
//     200 with token, full §3 shape; 401 speaks the UM {error} envelope.
//   • Second veto site: a loopback caller IS rate-limited on /api/stats while
//     /api/* loopback traffic keeps its bypass.
//   • A4: N doSearch calls with ctx.surface move searches_today + populate
//     percentiles; a surface-less doSearch (test/eval caller shape) emits
//     NOTHING; compat /v2/search + /v2/memories/ (list) increment recall
//     counters with surface mem0-compat-or-header.
//   • A5: counters db absent ⇒ capture:null + growth_7d:null +
//     degraded:["counters-unavailable"], HTTP 200, qdrant fields live;
//     memory client throws ⇒ degraded:["corpus-unavailable"], HTTP 200.
//   • Route template: /api/stats buckets under endpoint="/api/stats", not
//     '/__unknown__' (metrics-registry scrape, r1-review-fixes pattern).
//   • /health silent-100-cap fix: a 150-point corpus reads memories=150 on
//     /health and points=150 on /api/stats (fake client mimics mem0's
//     default limit=100 when no explicit limit is passed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { endpointClassRoute } from '../lib/endpoint-class.mjs';
import { createRequestHandler, doSearch } from '../mem0-mcp-http.mjs';
import { handleMem0Compat } from '../lib/mem0-compat.mjs';
import { readCounterStats } from '../lib/stats.mjs';
import { _resetCaptureEventsForTest } from '../lib/capture-events.mjs';
import {
  noteRecallSearch,
  latencySinceBoot,
  recallDurations,
  RING_CAPACITY,
  _resetRecallTelemetryForTest,
} from '../lib/recall-telemetry.mjs';
import { registry } from '../lib/metrics.mjs';
import { SERVER_VERSION } from '../lib/version.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ---------- helpers ----------

const TOKEN = 'stats-secret-token';
const TODAY = new Date().toISOString().slice(0, 10);

async function tempDbPath(prefix = 'um-api-stats-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'um-counters.db');
}

// Direct-SQL seeding with the pinned T5 schema (same helper shape as
// stats.test.mjs — recordCaptureEvent hardcodes day=today).
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

// Fake memory client. getAll mimics mem0ai's DEFAULT limit=100 when the
// caller passes no explicit limit — the exact silent cap /health inherited
// (plan U2 audit) — so the limit fix is observable, not vacuous.
function makeFakeMemory(pointCount, { getAllThrows = false } = {}) {
  const items = Array.from({ length: pointCount }, (_, i) => ({
    id: `uuid-${i}`,
    memory: `memory body ${i}`,
    metadata: i % 3 === 0
      ? { id: `doc-${i}`, title: `t${i}` } // no project → "(unknown)" bucket
      : { id: `doc-${i}`, title: `t${i}`, project: i % 3 === 1 ? 'um' : 'edge' },
  }));
  return {
    getAll: async ({ limit } = {}) => {
      if (getAllThrows) throw new Error('qdrant down');
      return { results: items.slice(0, limit ?? 100) };
    },
    search: async () => ({ results: items.slice(0, 3).map((r) => ({ ...r, score: 0.9 })) }),
  };
}

// House ephemeral-port pattern (mem0-compat-routes.test.mjs): pin env,
// start createRequestHandler on loopback, restore ALL touched env on close.
async function startServer({ memory, env = {} }) {
  const overrides = { UM_AUTH_TOKEN: TOKEN, ...env };
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const srv = createServer(createRequestHandler({ memory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  return { close, url };
}

const authed = { headers: { 'Authorization': `Bearer ${TOKEN}` } };

// ---------------------------------------------------------------------------
// Endpoint-class row (unit)
// ---------------------------------------------------------------------------

test('endpoint-class: /api/stats row = auth+rate-limit on, noLoopbackBypass marker, NO compat flag', () => {
  const route = endpointClassRoute({ url: '/api/stats' }, {}, '1.2.3.4');
  assert.deepEqual(route, { bypassAuth: false, bypassRateLimit: false, noLoopbackBypass: true });
  assert.equal(route.compat, undefined, 'stats must NOT reuse compat (token scheme + error dialect stay standard)');
});

test('endpoint-class: /api/stats row wins over the /api/* catch-all (first-match order)', () => {
  const stats = endpointClassRoute({ url: '/api/stats' }, {}, '127.0.0.1');
  const other = endpointClassRoute({ url: '/api/search' }, {}, '127.0.0.1');
  assert.equal(stats.noLoopbackBypass, true);
  assert.equal(other.noLoopbackBypass, undefined, 'the marker is scoped to /api/stats only');
});

// ---------------------------------------------------------------------------
// A1 — auth incl. the loopback veto
// ---------------------------------------------------------------------------

test('A1: 401 without token (non-loopback), UM {error} envelope not {detail}', async () => {
  const { close, url } = await startServer({ memory: makeFakeMemory(3) });
  try {
    const r = await fetch(url('/api/stats'), { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(typeof body.error, 'object', '401 speaks the standard UM envelope');
    assert.equal(body.detail, undefined, 'no mem0 dialect on /api/stats');
  } finally { await close(); }
});

test('A1 veto: pure loopback WITHOUT token → 401 (loopback bypass denied on /api/stats)', async () => {
  const { close, url } = await startServer({ memory: makeFakeMemory(3) });
  try {
    const r = await fetch(url('/api/stats')); // pure loopback, no auth header
    assert.equal(r.status, 401);
    // Guard: the same loopback peer still bypasses auth on other /api/* routes.
    const list = await fetch(url('/api/list'));
    assert.equal(list.status, 200, '/api/* loopback bypass must be unaffected');
  } finally { await close(); }
});

test('A1: 200 with token — full spec-§3 shape', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [
    { day: TODAY, surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 4 },
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 2 },
    { day: TODAY, surface: 'claude-code', event: 'recall.search', outcome: '', count: 7 },
  ]);
  const { close, url } = await startServer({
    memory: makeFakeMemory(9),
    env: { UM_COUNTERS_DB_PATH: dbPath, UM_MOUNT_MODE: undefined },
  });
  try {
    const r = await fetch(url('/api/stats'), authed);
    assert.equal(r.status, 200);
    const body = await r.json();

    assert.equal(body.schema_version, 1);
    assert.ok(!Number.isNaN(Date.parse(body.generated_at)), 'generated_at is a timestamp');

    assert.equal(body.server.version, SERVER_VERSION);
    assert.equal(typeof body.server.uptime_s, 'number');
    assert.equal(typeof body.server.writes_enabled, 'boolean');
    assert.equal(body.server.mount_mode, 'unknown', 'UM_MOUNT_MODE unset ⇒ "unknown"');

    assert.equal(body.corpus.points, 9);
    // makeFakeMemory: i%3===0 → no project (3 of 9), i%3===1 → 'um', else 'edge'.
    assert.deepEqual(body.corpus.points_by_project, { '(unknown)': 3, um: 3, edge: 3 });
    assert.equal(Object.keys(body.corpus.growth_7d).length, 7, 'zero-filled 7-day map');
    assert.equal(body.corpus.growth_7d[TODAY], 2, 'capture.extraction stored counts as growth');

    const cc = body.capture['claude-code'];
    assert.equal(cc.last_day_seen, TODAY);
    assert.equal(cc.freshness_hours, 0);
    assert.equal(cc.events_today, 6, 'recall.search rows do NOT count as capture events');
    assert.equal(cc.errors_today, 0);
    assert.deepEqual(cc.outcomes_7d, { stored: 6, abstained: 0, deduped: 0, superseded: 0, error: 0 });

    assert.equal(body.recall.searches_today, 7);
    assert.equal(body.recall.searches_7d, 7);
    assert.equal(
      body.recall.latency_since_boot.label,
      'deployment serving latency (includes engine + embedding time)',
    );
    assert.equal(typeof body.recall.latency_since_boot.n, 'number');

    assert.equal(body.degraded, undefined, 'no degraded flag when every source is live');
  } finally { await close(); }
});

// v1.8.1 shipped-bug fix: both /api/stats record builders were plain object
// literals keyed by attacker-controlled strings (surface ← X-UM-Source,
// project ← stored metadata). A key named '__proto__' hits the prototype
// setter — the entry vanishes from JSON — and a project named after any
// Object.prototype member (e.g. 'constructor') reads the inherited value
// through `?? 0` and serves a garbage concatenated string as its count.
test('hostile keys: __proto__ surface and __proto__/constructor projects served as data', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [
    { day: TODAY, surface: '__proto__', event: 'capture.turn', outcome: 'stored', count: 3 },
  ]);
  const items = [
    { id: 'u1', memory: 'm1', metadata: { id: 'd1', project: '__proto__' } },
    { id: 'u2', memory: 'm2', metadata: { id: 'd2', project: '__proto__' } },
    { id: 'u3', memory: 'm3', metadata: { id: 'd3', project: 'constructor' } },
    { id: 'u4', memory: 'm4', metadata: { id: 'd4', project: 'um' } },
  ];
  const memory = {
    getAll: async ({ limit } = {}) => ({ results: items.slice(0, limit ?? 100) }),
    search: async () => ({ results: [] }),
  };
  const { close, url } = await startServer({ memory, env: { UM_COUNTERS_DB_PATH: dbPath } });
  try {
    const r = await fetch(url('/api/stats'), authed);
    assert.equal(r.status, 200);
    const body = await r.json();

    const byProject = body.corpus.points_by_project;
    assert.ok(Object.hasOwn(byProject, '__proto__'), '__proto__ project must be an own key in the JSON');
    assert.equal(byProject['__proto__'], 2);
    assert.equal(byProject['constructor'], 1, 'constructor count must be a number, not inherited-value garbage');
    assert.equal(byProject.um, 1);

    assert.ok(Object.hasOwn(body.capture, '__proto__'), '__proto__ surface must survive to the served JSON');
    assert.equal(body.capture['__proto__'].events_today, 3);
  } finally { await close(); }
});

test('second veto site: loopback caller IS rate-limited on /api/stats; /api/* bypass intact', async () => {
  const { close, url } = await startServer({
    memory: makeFakeMemory(2),
    env: { UM_RATE_LIMIT_RPM: '1', UM_RATE_LIMIT_BURST: '1' },
  });
  try {
    const first = await fetch(url('/api/stats'), authed);
    assert.equal(first.status, 200);
    const second = await fetch(url('/api/stats'), authed);
    assert.equal(second.status, 429, 'loopback must NOT bypass the limiter on /api/stats');
    assert.equal(typeof second.headers.get('retry-after'), 'string');
    const body = await second.json();
    assert.equal(typeof body.error, 'object', '429 speaks the UM envelope, not the mem0 dialect');
    // Guard: the exhausted bucket does not limit ordinary loopback /api/* traffic.
    const list = await fetch(url('/api/list'));
    assert.equal(list.status, 200);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// A4 — recall telemetry through doSearch (production path 1)
// ---------------------------------------------------------------------------

async function withTelemetryDb(fn) {
  const dbPath = await tempDbPath('um-recall-tel-');
  const prev = process.env.UM_COUNTERS_DB_PATH;
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  _resetRecallTelemetryForTest();
  try {
    await fn(dbPath);
  } finally {
    if (prev !== undefined) process.env.UM_COUNTERS_DB_PATH = prev;
    else delete process.env.UM_COUNTERS_DB_PATH;
    _resetCaptureEventsForTest();
    _resetRecallTelemetryForTest();
  }
}

test('A4: N doSearch calls WITH ctx.surface move searches_today + populate percentiles', async () => {
  await withTelemetryDb(async (dbPath) => {
    const memory = makeFakeMemory(5);
    for (let i = 0; i < 3; i++) {
      await doSearch('q', 5, false, false, { memory, surface: 'claude-code' });
    }
    const stats = readCounterStats({ now: Date.now(), dbPath });
    assert.equal(stats.recall.searches_today, 3);
    assert.equal(stats.recall.searches_7d, 3);
    const lat = latencySinceBoot();
    assert.equal(lat.n, 3, 'each production search lands one ring-buffer sample');
    assert.equal(typeof lat.p50_ms, 'number');
    assert.equal(typeof lat.p95_ms, 'number');
    // G2 scope filter: recall rows must not manufacture capture freshness.
    assert.equal(stats.capture['claude-code'], undefined, 'recall.search must not create a capture surface');
  });
});

test('A4 gate: a surface-less doSearch (test/eval caller shape) emits NOTHING', async () => {
  await withTelemetryDb(async (dbPath) => {
    const memory = makeFakeMemory(5);
    await doSearch('q', 5, false, false, { memory });          // ctx without surface
    await doSearch('q', 5, false, false, memory);              // legacy positional client
    await doSearch('q', 5, false, false, { memory, surface: '' }); // empty string = unset
    // Strongest possible proof of "emits NOTHING": the T5 writer creates the
    // db lazily on first emit — with zero emissions the file never exists,
    // so readCounterStats reads null-shaped (available:false).
    const stats = readCounterStats({ now: Date.now(), dbPath });
    assert.equal(stats.available, false, 'no emission ⇒ the counters db was never even created');
    assert.equal(recallDurations().length, 0, 'no ring-buffer samples');
  });
});

// ---------------------------------------------------------------------------
// A4 — recall telemetry through the mem0-compat handlers (production path 2)
// ---------------------------------------------------------------------------

test('A4 compat: /v2/memories/search/ increments recall counters (surface mem0-compat default)', async () => {
  await withTelemetryDb(async (dbPath) => {
    const ctx = { memory: makeFakeMemory(5), userId: 'op' };
    const req = { method: 'POST', headers: {} };
    const out = await handleMem0Compat(req, new URL('/v2/memories/search/', 'http://x'), { query: 'q' }, ctx);
    assert.equal(out.status, 200);
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        "SELECT surface, SUM(count) AS n FROM counters WHERE event = 'recall.search' GROUP BY surface",
      ).get();
      assert.deepEqual(row, { surface: 'mem0-compat', n: 1 });
    } finally { db.close(); }
    assert.equal(latencySinceBoot().n, 1);
  });
});

test('A4 compat: X-UM-Source header wins over the mem0-compat fallback', async () => {
  await withTelemetryDb(async (dbPath) => {
    const ctx = { memory: makeFakeMemory(5), userId: 'op' };
    const req = { method: 'POST', headers: { 'x-um-source': 'openclaw' } };
    const out = await handleMem0Compat(req, new URL('/v2/memories/search/', 'http://x'), { query: 'q' }, ctx);
    assert.equal(out.status, 200);
    const stats = readCounterStats({ now: Date.now(), dbPath });
    assert.equal(stats.recall.searches_today, 1);
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT surface FROM counters WHERE event = 'recall.search'").get();
      assert.equal(row.surface, 'openclaw');
    } finally { db.close(); }
  });
});

test('A4 compat: a post-processing throw ⇒ 500 AND no recall counter (emit-after-success)', async () => {
  await withTelemetryDb(async (dbPath) => {
    // Engine call succeeds but the returned record detonates in
    // post-processing (throwing `metadata` getter — the first pipeline step
    // that touches metadata throws, whichever it is) — the dispatcher maps
    // it to a 500. The recall counter must NOT have moved: a failed serve
    // is not "recall volume" (doSearch emit-after-success parity).
    const bad = { id: 'x', memory: 'm', score: 0.9 };
    Object.defineProperty(bad, 'metadata', {
      get() { throw new Error('post-processing boom'); },
      enumerable: true,
    });
    const ctx = {
      memory: { search: async () => ({ results: [bad] }) },
      userId: 'op',
    };
    const req = { method: 'POST', headers: {} };
    const out = await handleMem0Compat(req, new URL('/v2/memories/search/', 'http://x'), { query: 'q' }, ctx);
    assert.equal(out.status, 500);
    const stats = readCounterStats({ now: Date.now(), dbPath });
    assert.equal(stats.available, false, 'no emission ⇒ counters db never created');
    assert.equal(recallDurations().length, 0, 'no ring-buffer sample for a failed serve');
  });
});

test('A4 compat: /v2/memories/ (list read) also counts as a recall', async () => {
  await withTelemetryDb(async (dbPath) => {
    const ctx = { memory: makeFakeMemory(5), userId: 'op' };
    const req = { method: 'POST', headers: {} };
    const out = await handleMem0Compat(req, new URL('/v2/memories/', 'http://x'), {}, ctx);
    assert.equal(out.status, 200);
    const stats = readCounterStats({ now: Date.now(), dbPath });
    assert.equal(stats.recall.searches_today, 1);
    assert.equal(latencySinceBoot().n, 1);
  });
});

// ---------------------------------------------------------------------------
// A4 — REST /api/search HTTP path threads surface from X-UM-Source (plan R1).
// The direct doSearch tests above pass surface in ctx, bypassing the route's
// `surface: surfaceFromHeaders(req.headers)` spread. These exercise that
// wiring end-to-end: a refactor dropping the spread at the POST/GET sites
// would zero ALL /api/search recall attribution while passing every other
// test — so each verb site gets its own HTTP-level pin.
// ---------------------------------------------------------------------------

test('A4 REST: POST /api/search threads X-UM-Source into the recall.search surface', async () => {
  await withTelemetryDb(async (dbPath) => {
    const { close, url } = await startServer({ memory: makeFakeMemory(5) });
    try {
      const res = await fetch(url('/api/search'), {
        method: 'POST',
        headers: { ...authed.headers, 'Content-Type': 'application/json', 'X-UM-Source': 'claude-code-plugin' },
        body: JSON.stringify({ query: 'q', limit: 5 }),
      });
      assert.equal(res.status, 200);
      const stats = readCounterStats({ now: Date.now(), dbPath });
      assert.equal(stats.recall.searches_today, 1, 'REST search must emit a recall.search row');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare("SELECT surface FROM counters WHERE event = 'recall.search'").get();
        assert.equal(row.surface, 'claude-code-plugin', 'REST surface must come from X-UM-Source, not the "unknown" fallback');
      } finally { db.close(); }
      assert.ok(latencySinceBoot().n >= 1, 'REST search lands a ring-buffer sample');
    } finally {
      await close();
    }
  });
});

test('A4 REST: GET /api/search threads X-UM-Source into the recall.search surface', async () => {
  await withTelemetryDb(async (dbPath) => {
    const { close, url } = await startServer({ memory: makeFakeMemory(5) });
    try {
      const res = await fetch(url('/api/search?q=hello&limit=5'), {
        headers: { ...authed.headers, 'X-UM-Source': 'chatgpt' },
      });
      assert.equal(res.status, 200);
      const stats = readCounterStats({ now: Date.now(), dbPath });
      assert.equal(stats.recall.searches_today, 1, 'GET REST search must emit a recall.search row');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare("SELECT surface FROM counters WHERE event = 'recall.search'").get();
        assert.equal(row.surface, 'chatgpt', 'GET REST surface must come from X-UM-Source');
      } finally { db.close(); }
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// A5 — degraded shapes (HTTP 200 throughout)
// ---------------------------------------------------------------------------

test('A5: counters db absent ⇒ capture:null + growth_7d:null + degraded flag; qdrant fields live', async () => {
  const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'um-stats-miss-')), 'nope.db');
  const { close, url } = await startServer({
    memory: makeFakeMemory(4),
    env: { UM_COUNTERS_DB_PATH: missing },
  });
  try {
    const r = await fetch(url('/api/stats'), authed);
    assert.equal(r.status, 200, 'degraded is 200, never 500 (fresh installs have no db)');
    const body = await r.json();
    assert.equal(body.capture, null);
    assert.equal(body.corpus.growth_7d, null);
    assert.deepEqual(body.degraded, ['counters-unavailable']);
    assert.equal(body.corpus.points, 4, 'qdrant-sourced fields stay live');
    assert.equal(typeof body.corpus.points_by_project, 'object');
    assert.equal(body.recall.searches_today, null, 'counters-derived recall counts degrade to null');
    assert.equal(typeof body.recall.latency_since_boot.n, 'number', 'in-process latency stays live');
  } finally { await close(); }
});

test('A5: memory client throws ⇒ degraded:["corpus-unavailable"], HTTP 200, counters fields live', async () => {
  const dbPath = await tempDbPath();
  seedDb(dbPath, [{ day: TODAY, surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 1 }]);
  const { close, url } = await startServer({
    memory: makeFakeMemory(4, { getAllThrows: true }),
    env: { UM_COUNTERS_DB_PATH: dbPath },
  });
  try {
    const r = await fetch(url('/api/stats'), authed);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.degraded, ['corpus-unavailable']);
    assert.equal(body.corpus.points, null);
    assert.equal(body.corpus.points_by_project, null);
    assert.equal(body.capture['claude-code'].events_today, 1, 'counters-derived sections stay live');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Route template + /health limit fix
// ---------------------------------------------------------------------------

test('route template: /api/stats buckets under endpoint="/api/stats", not /__unknown__', async () => {
  const { close, url } = await startServer({ memory: makeFakeMemory(1) });
  try {
    const r = await fetch(url('/api/stats'), authed);
    assert.equal(r.status, 200);
    await r.text();
    const text = await registry.metrics();
    assert.match(text, /um_http_requests_total\{[^}]*endpoint="\/api\/stats"/);
  } finally { await close(); }
});

test('/health limit fix: a 150-point corpus reads memories=150 (was silently capped at 100)', async () => {
  const { close, url } = await startServer({ memory: makeFakeMemory(150) });
  try {
    const h = await fetch(url('/health'));
    assert.equal(h.status, 200);
    assert.equal((await h.json()).memories, 150);
    const s = await fetch(url('/api/stats'), authed);
    assert.equal((await s.json()).corpus.points, 150, 'stats uses the same explicit large limit');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// recall-telemetry unit: ring capacity + since-boot reset
// ---------------------------------------------------------------------------

test('ring buffer caps at RING_CAPACITY (oldest overwritten) and reset empties it', async () => {
  await withTelemetryDb(async () => {
    for (let i = 0; i < RING_CAPACITY + 10; i++) {
      noteRecallSearch({ surface: 'claude-code', durationMs: i });
    }
    const durations = recallDurations();
    assert.equal(durations.length, RING_CAPACITY);
    assert.ok(!durations.includes(0), 'the oldest samples were overwritten');
    assert.ok(durations.includes(RING_CAPACITY + 9), 'the newest sample is present');
    const lat = latencySinceBoot();
    assert.equal(lat.n, RING_CAPACITY);
    _resetRecallTelemetryForTest();
    assert.deepEqual(latencySinceBoot(), { p50_ms: null, p95_ms: null, n: 0 }, 'since-boot semantics: reset ⇒ empty');
  });
});

test('latencySinceBoot: nearest-rank percentiles over an explicit array (pure)', () => {
  const lat = latencySinceBoot([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(lat.p50_ms, 50);
  assert.equal(lat.p95_ms, 100);
  assert.equal(lat.n, 10);
  assert.equal(latencySinceBoot([42]).p50_ms, 42);
  assert.equal(latencySinceBoot([42]).p95_ms, 42);
});
