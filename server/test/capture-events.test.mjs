// server/test/capture-events.test.mjs — T5 (#159 / spec §6): capture.* counter emission.
//
// Covers:
//   • recordCaptureEvent unit semantics: upsert increment, distinct keys, ''
//     where inapplicable, PRAGMA user_version stamp, throwing-DB fire-and-forget,
//     SQLITE_BUSY single retry, default path derivation.
//   • surfaceFromHeaders: X-UM-Source primary, X-Mem0-Source alias, 'unknown'
//     default, custom fallback (mem0-compat keeps 'mem0-compat').
//   • Integration through the pinned instrumentation sites (spec §6):
//     doAppendTurn (capture.turn), doCheckpoint (capture.checkpoint incl.
//     outcome=error on UPSTREAM_FAILURE), umAdd facts-result site
//     (capture.extraction: stored/deduped/abstained), MCP tool path,
//     _systemMigration exclusion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import {
  recordCaptureEvent,
  surfaceFromHeaders,
  countersDbPath,
  CAPTURE_EVENTS,
  _resetCaptureEventsForTest,
  _setDbFactoryForTest,
} from '../lib/capture-events.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { doAppendTurn } from '../lib/append-turn.mjs';
import { doCheckpoint } from '../lib/checkpoint.mjs';
import { umAdd } from '../lib/add.mjs';
import { handleToolCall, handleAppendTurnRequest, createRequestHandler } from '../mem0-mcp-http.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// P4 isolation (same as add.test.mjs): pin the lane classifier OFF so the
// umAdd integration tests below exercise the counter site, not the classifier.
process.env.UM_LANE_CLASSIFIER_ENABLED = 'false';

// ---------- helpers ----------

async function freshCountersDb(prefix = 'um-counters-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  return dbPath;
}

function readRows(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT day, surface, project, event, outcome, count FROM counters ORDER BY event, outcome, surface').all();
  } finally {
    db.close();
  }
}

function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.jsonBody = obj; return this; },
  };
}

async function makeTempVault() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'um-capture-vault-'));
}

async function seedCapture(vaultDir, project, filename, content) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, filename), content);
}

const CHECKPOINT_CONFIG = {
  schema_version: 1,
  cost_cap_usd_per_day_per_project: 0.50,
  summary_model: 'gpt-4o-mini',
  state_cap_chars: 3000,
  lockdir_stale_timeout_ms: 600000,
};

const summarizeFn = async () => ({ summary: 'Mock summary.', costUsd: 0.001, tokensIn: 10, tokensOut: 5 });
const updateStateFn = async ({ oldStateMd, newSummary }) => ({
  schema_version: 1, mergedMd: `${oldStateMd}\n${newSummary}`, costUsd: 0, tokensIn: 0, tokensOut: 0, llmFailure: false,
});

const factsPassthrough = (facts) => ({
  supports: { facts: true },
  defaults: { factsModel: 'mock' },
  factsInvoke: async () => ({ facts, usage: { tokensIn: 5, tokensOut: 2 } }),
});
const embedOverride = {
  supports: { embeddings: true },
  defaults: { embeddingModel: 'mock' },
  embed: async () => ({ vector: [0.1, 0.2], usage: { tokensIn: 3, tokensOut: 0 } }),
};
const mockMemory = { config: { vectorStore: { config: { collectionName: 'memories', host: 'localhost', port: 6333 } } } };

// ---------- unit: upsert semantics ----------

test('recordCaptureEvent upserts: same key increments, distinct keys get separate rows', async () => {
  const dbPath = await freshCountersDb();
  const evt = { surface: 'claude-code', project: 'proj-a', event: CAPTURE_EVENTS.TURN, outcome: 'stored' };
  recordCaptureEvent(evt);
  recordCaptureEvent(evt);
  recordCaptureEvent({ ...evt, surface: 'discord' });

  const rows = readRows(dbPath);
  assert.equal(rows.length, 2, `expected 2 rows, got: ${JSON.stringify(rows)}`);
  const same = rows.find((r) => r.surface === 'claude-code');
  const other = rows.find((r) => r.surface === 'discord');
  assert.equal(same.count, 2, 'same-key emit must increment, not insert');
  assert.equal(other.count, 1);
  assert.equal(same.project, 'proj-a');
  assert.equal(same.event, 'capture.turn');
  assert.equal(same.outcome, 'stored');
  assert.match(same.day, /^\d{4}-\d{2}-\d{2}$/, 'day must be UTC YYYY-MM-DD');
  assert.equal(same.day, new Date().toISOString().slice(0, 10));
});

test("recordCaptureEvent persists '' where inapplicable (missing project/outcome) and 'unknown' surface", async () => {
  const dbPath = await freshCountersDb();
  recordCaptureEvent({ event: CAPTURE_EVENTS.CHECKPOINT });
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, 'unknown', "absent surface ⇒ 'unknown' (spec §6)");
  assert.equal(rows[0].project, '', "absent project ⇒ '' (spec §6)");
  assert.equal(rows[0].outcome, '', "absent outcome ⇒ '' (spec §6)");
});

test('counters DB stamps PRAGMA user_version = 1 at create', async () => {
  const dbPath = await freshCountersDb();
  recordCaptureEvent({ event: CAPTURE_EVENTS.TURN, outcome: 'stored' });
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 1);
  } finally {
    db.close();
  }
});

test('recordCaptureEvent without an event name is a no-op (no rows, no throw)', async () => {
  const dbPath = await freshCountersDb();
  recordCaptureEvent({});
  recordCaptureEvent();
  const stat = await fs.stat(dbPath).catch(() => null);
  // The DB may not even be created; if it was, it must hold zero rows.
  if (stat) assert.equal(readRows(dbPath).length, 0);
});

test('default path: UM_COUNTERS_DB_PATH unset ⇒ um-counters.db next to MEM0_HISTORY_DB_PATH', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'um-counters-default-'));
  const prevCounters = process.env.UM_COUNTERS_DB_PATH;
  const prevHistory = process.env.MEM0_HISTORY_DB_PATH;
  delete process.env.UM_COUNTERS_DB_PATH;
  process.env.MEM0_HISTORY_DB_PATH = path.join(dir, 'history.db');
  _resetCaptureEventsForTest();
  try {
    assert.equal(countersDbPath(), path.join(dir, 'um-counters.db'));
    recordCaptureEvent({ event: CAPTURE_EVENTS.TURN, outcome: 'stored' });
    const rows = readRows(path.join(dir, 'um-counters.db'));
    assert.equal(rows.length, 1);
  } finally {
    if (prevCounters !== undefined) process.env.UM_COUNTERS_DB_PATH = prevCounters;
    if (prevHistory !== undefined) process.env.MEM0_HISTORY_DB_PATH = prevHistory;
    else delete process.env.MEM0_HISTORY_DB_PATH;
    _resetCaptureEventsForTest();
  }
});

// ---------- unit: fire-and-forget + SQLITE_BUSY retry ----------

test('recordCaptureEvent never throws when the DB layer throws (fire-and-forget)', async () => {
  await freshCountersDb();
  _setDbFactoryForTest(() => { throw new Error('simulated: disk on fire'); });
  try {
    assert.doesNotThrow(() => recordCaptureEvent({
      surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored',
    }));
    // Second emit with the same failure class must also be silent (warn-once path).
    assert.doesNotThrow(() => recordCaptureEvent({
      surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored',
    }));
  } finally {
    _resetCaptureEventsForTest();
  }
});

test('recordCaptureEvent retries exactly once on SQLITE_BUSY', async () => {
  await freshCountersDb();
  let runCalls = 0;
  _setDbFactoryForTest(() => ({
    prepare: () => ({
      run: () => {
        runCalls += 1;
        if (runCalls === 1) {
          const err = new Error('database is locked');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
        return { changes: 1 };
      },
    }),
  }));
  try {
    assert.doesNotThrow(() => recordCaptureEvent({
      surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored',
    }));
    assert.equal(runCalls, 2, 'busy first attempt + one retry');
  } finally {
    _resetCaptureEventsForTest();
  }
});

test('recordCaptureEvent swallows persistent SQLITE_BUSY after the single retry', async () => {
  await freshCountersDb();
  let runCalls = 0;
  _setDbFactoryForTest(() => ({
    prepare: () => ({
      run: () => {
        runCalls += 1;
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      },
    }),
  }));
  try {
    assert.doesNotThrow(() => recordCaptureEvent({
      surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored',
    }));
    assert.equal(runCalls, 2, 'exactly one retry — never a loop');
  } finally {
    _resetCaptureEventsForTest();
  }
});

// ---------- unit: poisoned open (review IMPORTANT-1) ----------

test('a corrupt um-counters.db file never throws and never fails the emit path', async () => {
  const dbPath = await freshCountersDb();
  await fs.writeFile(dbPath, 'this is definitely not a sqlite database — garbage bytes');
  try {
    assert.doesNotThrow(() => recordCaptureEvent({
      surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored',
    }));
    assert.doesNotThrow(() => recordCaptureEvent({
      surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored',
    }));
  } finally {
    _resetCaptureEventsForTest();
  }
});

test('a poisoned open is negative-cached — openDb is not re-entered per emit (no fd leak)', async () => {
  await freshCountersDb();
  let factoryCalls = 0;
  _setDbFactoryForTest(() => {
    factoryCalls += 1;
    throw new Error('simulated corrupt-db open failure');
  });
  try {
    recordCaptureEvent({ surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored' });
    recordCaptureEvent({ surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored' });
    recordCaptureEvent({ surface: 's', project: 'p', event: CAPTURE_EVENTS.TURN, outcome: 'stored' });
    assert.equal(factoryCalls, 1, 'a failed open must be cached, not retried (and re-leaked) on every emit');
  } finally {
    _resetCaptureEventsForTest();
  }
});

// ---------- unit: surfaceFromHeaders ----------

test('surfaceFromHeaders: X-UM-Source wins, X-Mem0-Source is the alias, absent ⇒ unknown', () => {
  assert.equal(surfaceFromHeaders({ 'x-um-source': 'Claude-Code' }), 'claude-code');
  assert.equal(surfaceFromHeaders({ 'x-mem0-source': ' Discord ' }), 'discord');
  assert.equal(surfaceFromHeaders({ 'x-um-source': 'a', 'x-mem0-source': 'b' }), 'a', 'X-UM-Source takes precedence over the alias');
  assert.equal(surfaceFromHeaders({}), 'unknown');
  assert.equal(surfaceFromHeaders(undefined), 'unknown');
  assert.equal(surfaceFromHeaders({ 'x-um-source': '   ' }), 'unknown', 'whitespace-only ⇒ fallback');
  assert.equal(surfaceFromHeaders({}, 'mem0-compat'), 'mem0-compat', 'custom fallback preserved for the compat facade');
});

test('surfaceFromHeaders caps the derived value at 64 chars (NIT-5: bounded PK cardinality)', () => {
  const garbage = 'X'.repeat(200);
  const derived = surfaceFromHeaders({ 'x-um-source': garbage });
  assert.equal(derived.length, 64);
  assert.equal(derived, 'x'.repeat(64));
});

// ---------- integration: doAppendTurn (capture.turn) ----------

test('doAppendTurn success emits capture.turn outcome=stored with threaded surface + project', async () => {
  const dbPath = await freshCountersDb();
  const vault = await makeTempVault();
  const result = await doAppendTurn(
    { project: 'proj-t5', content: 'counted turn', role: 'user' },
    { vaultDir: vault, surface: 'claude-code' },
  );
  assert.equal(result.ok, true);
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { surface: rows[0].surface, project: rows[0].project, event: rows[0].event, outcome: rows[0].outcome, count: rows[0].count },
    { surface: 'claude-code', project: 'proj-t5', event: 'capture.turn', outcome: 'stored', count: 1 },
  );
});

test('doAppendTurn validation failure emits no capture.turn counter', async () => {
  const dbPath = await freshCountersDb();
  const vault = await makeTempVault();
  const result = await doAppendTurn(
    { project: '../evil', content: 'x', role: 'user' },
    { vaultDir: vault, surface: 'claude-code' },
  );
  assert.equal(result.ok, false);
  const stat = await fs.stat(dbPath).catch(() => null);
  if (stat) assert.equal(readRows(dbPath).length, 0);
});

test('a counter failure never fails the capture (throwing stub; append-turn still ok)', async () => {
  await freshCountersDb();
  _setDbFactoryForTest(() => { throw new Error('counters path killed'); });
  const vault = await makeTempVault();
  try {
    const result = await doAppendTurn(
      { project: 'proj-t5', content: 'still captured', role: 'user' },
      { vaultDir: vault, surface: 'claude-code' },
    );
    assert.equal(result.ok, true, 'A3: killing the counters path must not fail the capture');
    const onDisk = await fs.readFile(path.join(vault, result.path), 'utf8');
    assert.match(onDisk, /still captured/);
  } finally {
    _resetCaptureEventsForTest();
  }
});

// ---------- integration: HTTP handler surface threading ----------

test('handleAppendTurnRequest threads ctx.surface into the capture.turn counter', async () => {
  const dbPath = await freshCountersDb();
  const vault = await makeTempVault();
  const res = mockRes();
  await handleAppendTurnRequest(
    { body: { project: 'http-proj', content: 'via http', role: 'user' } },
    res,
    { vaultDir: vault, writesEnabled: true, reindexFn: async () => {}, surface: surfaceFromHeaders({ 'x-um-source': 'openclaw' }) },
  );
  assert.equal(res.statusCode, 200);
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, 'openclaw');
  assert.equal(rows[0].event, 'capture.turn');
});

// ---------- integration: MCP tool path ----------

test('MCP tool path (handleToolCall memory_append_turn) emits capture.turn with ctx surface', async () => {
  const dbPath = await freshCountersDb();
  const vault = await makeTempVault();
  const prevWrite = process.env.UM_MCP_WRITE_ENABLED;
  const prevVault = process.env.UM_VAULT_DIR;
  process.env.UM_MCP_WRITE_ENABLED = 'true';
  process.env.UM_VAULT_DIR = vault;
  try {
    const raw = await handleToolCall(
      'memory_append_turn',
      { project: 'mcp-proj', content: 'via mcp tool', role: 'assistant' },
      { surface: 'mcp-client' },
    );
    const result = JSON.parse(raw);
    assert.equal(result.ok, true);
    // Give the fire-and-forget reindex promise a tick so its .catch settles.
    await new Promise((r) => setImmediate(r));
    const rows = readRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].surface, 'mcp-client');
    assert.equal(rows[0].event, 'capture.turn');
    assert.equal(rows[0].outcome, 'stored');
  } finally {
    if (prevWrite !== undefined) process.env.UM_MCP_WRITE_ENABLED = prevWrite; else delete process.env.UM_MCP_WRITE_ENABLED;
    if (prevVault !== undefined) process.env.UM_VAULT_DIR = prevVault; else delete process.env.UM_VAULT_DIR;
  }
});

// ---------- integration: doCheckpoint (capture.checkpoint) ----------

test('doCheckpoint success emits capture.checkpoint outcome=stored', async () => {
  const dbPath = await freshCountersDb();
  const vault = await makeTempVault();
  await seedCapture(vault, 'ckproj', '2026-01-01.md', '# Session\nwork happened');
  const result = await doCheckpoint(
    { project: 'ckproj' },
    { config: CHECKPOINT_CONFIG, vaultDir: vault, summarizeFn, updateStateFn, reindexFn: async () => {}, surface: 'claude-code' },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { surface: rows[0].surface, project: rows[0].project, event: rows[0].event, outcome: rows[0].outcome },
    { surface: 'claude-code', project: 'ckproj', event: 'capture.checkpoint', outcome: 'stored' },
  );
});

test('doCheckpoint UPSTREAM_FAILURE (reindex exhausted) emits capture.checkpoint outcome=error', async () => {
  const dbPath = await freshCountersDb();
  const vault = await makeTempVault();
  await seedCapture(vault, 'ckproj', '2026-01-01.md', '# Session\nwork happened');
  const result = await doCheckpoint(
    { project: 'ckproj' },
    {
      config: CHECKPOINT_CONFIG,
      vaultDir: vault,
      summarizeFn,
      updateStateFn,
      reindexFn: async () => { throw new Error('qdrant outage'); },
      retryDelaysMs: [0, 0, 0],
      retryJitterMaxMs: 0,
      surface: 'claude-code',
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UPSTREAM_FAILURE');
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1, 'a qdrant outage must be visible in the counters, not silently uncounted');
  assert.equal(rows[0].event, 'capture.checkpoint');
  assert.equal(rows[0].outcome, 'error');
  assert.equal(rows[0].project, 'ckproj');
});

// ---------- integration: umAdd facts-result site (capture.extraction) ----------

test('umAdd emits capture.extraction outcome=stored per persisted fact', async () => {
  const dbPath = await freshCountersDb();
  await umAdd({
    memory: mockMemory,
    text: 'two facts here',
    userId: 'u-1',
    metadata: { project: 'um-proj' },
    infer: true,
    surface: 'discord',
    _factsProviderOverride: factsPassthrough(['fact one', 'fact two']),
    _embedProviderOverride: embedOverride,
    _qdrantClient: { upsert: async () => ({}) },
  });
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1, 'both facts share one counter row');
  assert.deepEqual(
    { surface: rows[0].surface, project: rows[0].project, event: rows[0].event, outcome: rows[0].outcome, count: rows[0].count },
    { surface: 'discord', project: 'um-proj', event: 'capture.extraction', outcome: 'stored', count: 2 },
  );
});

test('umAdd zero extracted facts emits capture.extraction outcome=abstained', async () => {
  const dbPath = await freshCountersDb();
  const result = await umAdd({
    memory: mockMemory,
    text: 'nothing memorable',
    userId: 'u-1',
    metadata: { project: 'um-proj' },
    infer: true,
    surface: 'discord',
    _factsProviderOverride: factsPassthrough([]),
    _embedProviderOverride: embedOverride,
    _qdrantClient: { upsert: async () => ({}) },
  });
  assert.equal(result.results.length, 0);
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'capture.extraction');
  assert.equal(rows[0].outcome, 'abstained');
  assert.equal(rows[0].count, 1);
});

test('umAdd dedup hit emits capture.extraction outcome=deduped', async () => {
  const dbPath = await freshCountersDb();
  const prevDedup = process.env.UM_DEDUP_ENABLED;
  delete process.env.UM_DEDUP_ENABLED; // default ON
  try {
    const existing = {
      id: 'existing-point',
      payload: { data: 'fact one', userId: 'u-1', surfaces: ['claude-code'], projects: ['um-proj'], dedupCount: 1, dedupVersion: 1 },
    };
    await umAdd({
      memory: mockMemory,
      text: 'fact one',
      userId: 'u-1',
      metadata: { project: 'um-proj' },
      infer: true,
      surface: 'discord',
      _factsProviderOverride: factsPassthrough(['fact one']),
      _embedProviderOverride: embedOverride,
      _qdrantClient: {
        scroll: async () => ({ points: [existing] }),   // Layer-1 hash hit
        search: async () => [],
        setPayload: async () => ({}),
        upsert: async () => ({}),
      },
    });
    const rows = readRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'capture.extraction');
    assert.equal(rows[0].outcome, 'deduped');
  } finally {
    if (prevDedup !== undefined) process.env.UM_DEDUP_ENABLED = prevDedup;
  }
});

test('umAdd in-band supersession emits capture.extraction outcome=superseded', async () => {
  const dbPath = await freshCountersDb();
  // Layer-2 embedding hit in the contradiction band + confirming judge ⇒
  // SUPERSEDED_INBAND (fixture mirrors add.test.mjs Gap-5 P3 tests).
  const older = { id: 'older-pt', score: 0.85, payload: { data: 'I live in Boston', lane: 'work', status: 'current' } };
  const result = await umAdd({
    memory: mockMemory,
    text: 'I live in Denver now',
    userId: 'u-1',
    metadata: { project: 'um-proj', lane: 'work' },
    infer: false,
    surface: 'discord',
    _embedProviderOverride: embedOverride,
    _qdrantClient: {
      scroll: async () => ({ points: [] }),        // no Layer-1 hash hit
      search: async () => [older],                 // Layer-2 in-band hit
      upsert: async () => ({ status: 'ok' }),
      setPayload: async () => ({ status: 'ok' }),
    },
    _autoSupersedeEnabled: true,
    _judgeContradiction: async () => ({ contradicts: true, confidence: 0.9, reasoning: 'newer invalidates older' }),
  });
  assert.equal(result.results[0].event, 'SUPERSEDED_INBAND', JSON.stringify(result));
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'capture.extraction');
  assert.equal(rows[0].outcome, 'superseded');
  assert.equal(rows[0].surface, 'discord');
});

test('MCP memory_add: caller-supplied args.surface wins over the header-derived ctx.surface (D1 F.1)', async () => {
  const dbPath = await freshCountersDb();
  const prevWrite = process.env.UM_MCP_WRITE_ENABLED;
  process.env.UM_MCP_WRITE_ENABLED = 'true';
  const upserts = [];
  try {
    await handleToolCall(
      'memory_add',
      { text: 'a fact from a named caller', surface: 'caller-surface', metadata: { project: 'um-proj' } },
      {
        memory: mockMemory,
        surface: 'header-surface',                 // what the /mcp route derives from X-UM-Source
        _factsProviderOverride: factsPassthrough(['a fact from a named caller']),
        _embedProviderOverride: embedOverride,
        _qdrantClient: { upsert: async (c, body) => { upserts.push(body); return {}; } },
      },
    );
    assert.equal(upserts.length, 1);
    assert.deepEqual(upserts[0].points[0].payload.surfaces, ['caller-surface'], 'stored attribution uses the caller value');
    const rows = readRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'capture.extraction');
    assert.equal(rows[0].surface, 'caller-surface', 'counter attribution uses the caller value, not the header');
  } finally {
    if (prevWrite !== undefined) process.env.UM_MCP_WRITE_ENABLED = prevWrite; else delete process.env.UM_MCP_WRITE_ENABLED;
  }
});

// ---------- integration: REST /api/add header-derived surface (review IMPORTANT-2) ----------

test('REST /api/add with X-UM-Source and no body surface uses the header for counters + stored attribution', async () => {
  const dbPath = await freshCountersDb();
  const prevWrite = process.env.UM_MCP_WRITE_ENABLED;
  const prevToken = process.env.UM_AUTH_TOKEN;
  process.env.UM_MCP_WRITE_ENABLED = 'true';
  process.env.UM_AUTH_TOKEN = 'test-token';
  const upserts = [];
  const srv = createServer(createRequestHandler({
    memory: mockMemory,
    _qdrantClient: { upsert: async (c, body) => { upserts.push(body); return {}; } },
    _factsProviderOverride: factsPassthrough(['header-attributed fact']),
    _embedProviderOverride: embedOverride,
  }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
        'X-UM-Source': 'Claude-Code',
      },
      body: JSON.stringify({ text: 'hello', metadata: { project: 'um-proj' } }), // NO body surface
    });
    assert.equal(r.status, 200, await r.text().catch(() => ''));
    await r.text().catch(() => '');
    assert.equal(upserts.length, 1);
    assert.deepEqual(upserts[0].points[0].payload.surfaces, ['claude-code'], 'stored surfaces attribution from the header');
    const rows = readRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'capture.extraction');
    assert.equal(rows[0].surface, 'claude-code', 'counter surface from X-UM-Source, not unknown');
  } finally {
    srv.close();
    await once(srv, 'close');
    if (prevWrite !== undefined) process.env.UM_MCP_WRITE_ENABLED = prevWrite; else delete process.env.UM_MCP_WRITE_ENABLED;
    if (prevToken !== undefined) process.env.UM_AUTH_TOKEN = prevToken; else delete process.env.UM_AUTH_TOKEN;
  }
});

test('umAdd _systemMigration:true emits NO capture.* counters (spec §6 migration exclusion)', async () => {
  const dbPath = await freshCountersDb();
  await umAdd({
    memory: mockMemory,
    text: 'bulk import doc',
    userId: 'u-1',
    metadata: { project: 'um-proj', type: 'note', id: 'n1', title: 'N1' },
    infer: false,
    surface: 'reindex',
    _systemMigration: true,
    _embedProviderOverride: embedOverride,
    _qdrantClient: { upsert: async () => ({}) },
  });
  const stat = await fs.stat(dbPath).catch(() => null);
  if (stat) assert.equal(readRows(dbPath).length, 0, 'a reindex of thousands of docs must not spike the freshness signal');
});
