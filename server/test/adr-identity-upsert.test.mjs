/**
 * server/test/adr-identity-upsert.test.mjs — #279 identity-addressed ADR writes.
 *
 * Spec: docs/plans/2026-08-23-adr-identity-upsert-spec.md (D1–D7).
 * Test ids (T1*, T2a–T2l) map 1:1 to the paired plan's test contract.
 *
 * All payload assertions run against the REAL buildPayload output (the
 * production umAdd path with stub qdrant/provider seams) — never a stubbed
 * payload (plan T2 requirement; the P8 createdAt-clobber failure is invisible
 * to stubbed-payload tests).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { v5 as uuidv5 } from 'uuid';
import { umAdd, computeAdrIdentityId, computeFactId } from '../lib/add.mjs';
import { NAMESPACE_UM, IDENTITY_CARRY_FORWARD_FIELDS } from '../lib/dedup-constants.mjs';
import { _resetCaptureEventsForTest } from '../lib/capture-events.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Release the singleton sqlite handle (house pattern, capture-events.test.mjs):
// the last counters-db test would otherwise lock its temp dir on Windows.
after(() => {
  _resetCaptureEventsForTest();
});

// Same isolation pin as add.test.mjs: these tests inject the classifier seam
// only where they test it (T2f); pin the always-on default OFF elsewhere.
process.env.UM_LANE_CLASSIFIER_ENABLED = 'false';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures — mock qdrant client (upsert + retrieve + dedup surfaces) and the
// provider seams, in add.test.mjs's house style.
// ---------------------------------------------------------------------------
function makeMockQdrant({ retrievePoints = [], scrollHit = null, searchHit = null, retrieveThrows = false } = {}) {
  const calls = { upserts: [], retrieves: [], scrolls: [], searches: [] };
  return {
    calls,
    client: {
      upsert: async (collection, body) => { calls.upserts.push({ collection, body }); return { status: 'ok' }; },
      retrieve: async (collection, body) => {
        calls.retrieves.push({ collection, body });
        if (retrieveThrows) throw new Error('retrieve transport failure');
        return retrievePoints;
      },
      scroll: async (collection, body) => {
        calls.scrolls.push({ collection, body });
        return { points: scrollHit ? [scrollHit] : [] };
      },
      search: async (collection, body) => {
        calls.searches.push({ collection, body });
        return searchHit ? [searchHit] : [];
      },
    },
  };
}

function makeMockMemory({ collection = 'memories' } = {}) {
  return { config: { vectorStore: { config: { collectionName: collection, host: 'localhost', port: 6333 } } } };
}

const embedOverride = {
  supports: { embeddings: true },
  defaults: { embeddingModel: 'mock' },
  embed: async () => ({ vector: [0.1, 0.2, 0.3], usage: { tokensIn: 3, tokensOut: 0 } }),
};

function factsOverrideCounting(calls) {
  return {
    supports: { facts: true },
    defaults: { factsModel: 'mock' },
    factsInvoke: async (text) => {
      calls.push({ kind: 'facts', text });
      return { facts: [text], usage: { tokensIn: 1, tokensOut: 1 } };
    },
  };
}

const ADR_META = Object.freeze({
  schema_version: 1,
  type: 'adr',
  adr_id: '0042',
  adr_status: 'Accepted',
  repo_path: 'E:/Projects/universal-memory',
  decided_at: '2026-08-23',
  file_path: 'docs/decisions/0042-test.md',
  project: 'universal-memory',
});

const TITLE = 'Use Kuzu as the graph backend for relationship edges';

async function identityAdd({ qdrant, metadata = ADR_META, text = TITLE, infer = true, extra = {} } = {}) {
  const factsCalls = [];
  const result = await umAdd({
    memory: makeMockMemory(),
    text,
    userId: 'u-adr',
    metadata,
    infer,
    surface: 'claude-code-plugin',
    _factsProviderOverride: factsOverrideCounting(factsCalls),
    _embedProviderOverride: embedOverride,
    _qdrantClient: qdrant.client,
    ...extra,
  });
  return { result, factsCalls };
}

// ---------------------------------------------------------------------------
// T1 — identity id derivation (spec D3)
// ---------------------------------------------------------------------------
test('T1: computeAdrIdentityId pins the exact seed format (one-way door)', () => {
  const id = computeAdrIdentityId({ userId: 'u-adr', adrId: '0042', repoPath: 'E:/Projects/universal-memory' });
  // Exact-uuid pin: the seed is JSON.stringify(['adr', repoPath ?? null, adrId, userId])
  // under NAMESPACE_UM. Changing EITHER format or content breaks this test —
  // that is the point (spec D3: seed is a one-way door).
  const expected = uuidv5(JSON.stringify(['adr', 'E:/Projects/universal-memory', '0042', 'u-adr']), NAMESPACE_UM);
  assert.equal(id, expected);
});

test('T1: same tuple → same id; any component change → different id; absent repo_path deterministic', () => {
  const base = computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: '/r' });
  assert.equal(computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: '/r' }), base);
  assert.notEqual(computeAdrIdentityId({ userId: 'u', adrId: '0002', repoPath: '/r' }), base);
  assert.notEqual(computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: '/other' }), base);
  assert.notEqual(computeAdrIdentityId({ userId: 'u2', adrId: '0001', repoPath: '/r' }), base);
  const noPath = computeAdrIdentityId({ userId: 'u', adrId: '0001' });
  assert.equal(computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: undefined }), noPath);
  assert.notEqual(noPath, base);
  // JSON-array seed: null and undefined repoPath collapse to the same identity
  // (spec D3: `repo_path ?? null`), matching the --no-path degradation.
  assert.equal(computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: null }), noPath);
});

// ---------------------------------------------------------------------------
// T2a — identity branch: identity id, dedup NEVER consulted (spec D1/D4)
// ---------------------------------------------------------------------------
test('T2a: type:adr + adr_id upserts at the identity id and never touches dedup, even with a hash-identical point present', async () => {
  // A scroll/search hit exists — the content-addressed path WOULD dedup-merge.
  const qdrant = makeMockQdrant({
    scrollHit: { id: 'legacy-hash-hit', payload: { data: TITLE } },
    searchHit: { id: 'legacy-embed-hit', score: 0.99, payload: { data: TITLE } },
  });
  const { result } = await identityAdd({ qdrant });

  assert.equal(qdrant.calls.scrolls.length, 0, 'Layer-1 hash dedup must not run');
  assert.equal(qdrant.calls.searches.length, 0, 'Layer-2 embedding dedup must not run');
  assert.equal(qdrant.calls.upserts.length, 1);
  const point = qdrant.calls.upserts[0].body.points[0];
  assert.equal(point.id, computeAdrIdentityId({ userId: 'u-adr', adrId: '0042', repoPath: ADR_META.repo_path }));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].event, 'IDENTITY_UPSERT');
  assert.equal(result.results[0].id, point.id);
});

// ---------------------------------------------------------------------------
// T2b — re-add with changed adr_status: SAME id, new metadata lands (the #279 repro)
// ---------------------------------------------------------------------------
test('T2b: re-sync with flipped adr_status upserts (not setPayload) at the SAME id with the new value', async () => {
  const q1 = makeMockQdrant();
  await identityAdd({ qdrant: q1 });
  const first = q1.calls.upserts[0].body.points[0];
  assert.equal(first.payload.adr_status, 'Accepted');

  // Second sync: same title (unchanged hash — the exact #279 trigger), flipped status.
  const q2 = makeMockQdrant({ retrievePoints: [{ id: first.id, payload: first.payload }] });
  const { result } = await identityAdd({ qdrant: q2, metadata: { ...ADR_META, adr_status: 'Superseded' } });

  assert.equal(q2.calls.upserts.length, 1, 'full upsert, not a payload patch');
  const second = q2.calls.upserts[0].body.points[0];
  assert.equal(second.id, first.id, 'identity id is stable across syncs');
  assert.equal(second.payload.adr_status, 'Superseded', 'the posted value LANDS (the #279 fix)');
  assert.equal(second.payload.data, TITLE, 'verbatim title, not an extraction');
  assert.equal(result.results[0].event, 'IDENTITY_UPSERT');
});

// ---------------------------------------------------------------------------
// T2c — verbatim: facts() never invoked on the identity path (spec D2)
// ---------------------------------------------------------------------------
test('T2c: infer:true + type:adr never calls the facts orchestrator', async () => {
  const qdrant = makeMockQdrant();
  const { factsCalls } = await identityAdd({ qdrant, infer: true });
  assert.equal(factsCalls.length, 0, 'facts() must not run for identity writes');
  assert.equal(qdrant.calls.upserts[0].body.points[0].payload.data, TITLE);
});

// ---------------------------------------------------------------------------
// T2d — createdAt/valid_from carry-forward; MISS fresh; ERROR fail-closed (spec D5/D6, P8)
// ---------------------------------------------------------------------------
test('T2d: createdAt AND valid_from carried forward from the existing point (post-buildPayload override, P8)', async () => {
  const prior = {
    id: 'x',
    payload: { createdAt: '2026-01-01T00:00:00.000Z', valid_from: '2026-01-02T00:00:00.000Z' },
  };
  const qdrant = makeMockQdrant({ retrievePoints: [prior] });
  await identityAdd({ qdrant });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  // P8: buildPayload unconditionally writes createdAt: nowIso — only a
  // post-call override can preserve this. A metadata-borne value would be lost.
  assert.equal(payload.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(payload.valid_from, '2026-01-02T00:00:00.000Z');
});

test('T2d: retrieve MISS → first-sync behavior (fresh createdAt + valid_from stamped)', async () => {
  const qdrant = makeMockQdrant({ retrievePoints: [] });
  await identityAdd({ qdrant });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.ok(typeof payload.createdAt === 'string' && payload.createdAt.length > 0);
  assert.equal(payload.valid_from, payload.createdAt, 'VF1: first write shares one nowIso');
});

test('T2d: retrieve ERROR → umAdd rejects and nothing is upserted (fail closed, D6)', async () => {
  const qdrant = makeMockQdrant({ retrieveThrows: true });
  await assert.rejects(
    () => identityAdd({ qdrant }),
    /retrieve transport failure/,
    'a retrieve error must propagate, never silently proceed with fresh values',
  );
  assert.equal(qdrant.calls.upserts.length, 0, 'no upsert after a failed retrieve');
});

// ---------------------------------------------------------------------------
// T2e — resurrection guard (spec D5; round-1 CRITICAL, round-2 widened, FCP null-arm)
// ---------------------------------------------------------------------------
test('T2e: suppression fields + invalidated_at survive a re-sync; surfaces/projects unioned', async () => {
  const prior = {
    id: 'x',
    payload: {
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'superseded',
      supersededBy: 'point-b',
      supersededAt: '2026-02-01T00:00:00.000Z',
      invalidated_at: '2026-03-01T00:00:00.000Z',
      surfaces: ['a'],
      projects: ['proj-a'],
    },
  };
  const qdrant = makeMockQdrant({ retrievePoints: [prior] });
  await identityAdd({ qdrant });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.equal(payload.status, 'superseded', 'a demoted point must NOT resurrect (buildPayload forces current; the carry must win)');
  assert.equal(payload.supersededBy, 'point-b');
  assert.equal(payload.supersededAt, '2026-02-01T00:00:00.000Z');
  assert.equal(payload.invalidated_at, '2026-03-01T00:00:00.000Z', 'isRecallable-anchored: invalidated_at is a suppression field too');
  assert.deepEqual(payload.surfaces, ['a', 'claude-code-plugin'], 'union, not replace');
  assert.deepEqual(payload.projects, ['proj-a', 'universal-memory'], 'union, not replace');
});

test('T2e: current point without suppression fields → payload has NO such keys (omit-if-absent)', async () => {
  const prior = { id: 'x', payload: { createdAt: '2026-01-01T00:00:00.000Z' } };
  const qdrant = makeMockQdrant({ retrievePoints: [prior] });
  await identityAdd({ qdrant });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.equal(payload.status, 'current');
  assert.ok(!('supersededBy' in payload), 'no null/undefined payload keys');
  assert.ok(!('supersededAt' in payload));
  assert.ok(!('invalidated_at' in payload));
});

test('T2e: null-VALUED supersededBy/supersededAt (unsupersedePoint shape) are NOT carried', async () => {
  // supersede.mjs's unsupersede writes supersededBy: null / supersededAt: null —
  // the carry gates on value-presence (!= null), not key-presence (FCP residual).
  const prior = {
    id: 'x',
    payload: { createdAt: '2026-01-01T00:00:00.000Z', supersededBy: null, supersededAt: null },
  };
  const qdrant = makeMockQdrant({ retrievePoints: [prior] });
  await identityAdd({ qdrant });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.ok(!('supersededBy' in payload), 'null-valued keys must not be re-written');
  assert.ok(!('supersededAt' in payload));
  assert.equal(payload.status, 'current');
});

// ---------------------------------------------------------------------------
// T2f — deliberately unpartitioned: classifier never runs, no lane key (spec D4)
// ---------------------------------------------------------------------------
test('T2f: identity path never calls the lane classifier and writes no lane key, even when enabled', async () => {
  const classifyCalls = [];
  const qdrant = makeMockQdrant();
  await identityAdd({
    qdrant,
    extra: {
      _classifyLane: async () => { classifyCalls.push(1); return { lane: 'work', score: 0.9 }; },
      _laneClassifierEnabled: true,
    },
  });
  assert.equal(classifyCalls.length, 0, 'classifier must not run on the identity path');
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.ok(!('lane' in payload), 'identity points are unpartitioned by construction');
  assert.ok(!('persona' in payload));
});

// ---------------------------------------------------------------------------
// T2g — type:adr WITHOUT adr_id → legacy content-addressed pipeline unchanged (spec D1)
// ---------------------------------------------------------------------------
test('T2g: type:adr without adr_id falls through to the legacy pipeline (dedup consulted, computeFactId id)', async () => {
  const { adr_id: _dropped, ...metaNoId } = ADR_META;
  const qdrant = makeMockQdrant();
  const { result, factsCalls } = await identityAdd({ qdrant, metadata: metaNoId, infer: true });

  assert.equal(factsCalls.length, 1, 'legacy path extracts');
  assert.ok(qdrant.calls.scrolls.length >= 1, 'legacy path consults Layer-1 dedup');
  const point = qdrant.calls.upserts[0].body.points[0];
  assert.equal(point.id, computeFactId({ userId: 'u-adr', text: TITLE }), 'content-addressed id as today');
  assert.equal(result.results[0].event, 'ADD');
});

// ---------------------------------------------------------------------------
// T2h — _systemMigration + type:adr → trusted doc-tier path untouched (spec D1, P5)
// ---------------------------------------------------------------------------
test('T2h: _systemMigration:true + type:adr takes the legacy trusted path (no identity id, no retrieve)', async () => {
  const qdrant = makeMockQdrant();
  await identityAdd({
    qdrant,
    infer: false,
    metadata: { ...ADR_META, status: 'superseded' },  // vault frontmatter status — trusted path accepts it
    extra: { _systemMigration: true },
  });
  assert.equal(qdrant.calls.retrieves.length, 0, 'doc-tier reindex must not hit the identity branch');
  const point = qdrant.calls.upserts[0].body.points[0];
  assert.notEqual(
    point.id,
    computeAdrIdentityId({ userId: 'u-adr', adrId: '0042', repoPath: ADR_META.repo_path }),
    'doc-tier points keep their own (random) id space',
  );
  assert.equal(point.payload.status, 'superseded', 'trustedServerPath status honored exactly as today');
});

// ---------------------------------------------------------------------------
// T2i — entry guards not bypassed (spec D1; reserved-field regression pin)
// ---------------------------------------------------------------------------
test('T2i: reserved metadata.status still rejected on the untrusted identity path', async () => {
  const qdrant = makeMockQdrant();
  await assert.rejects(
    () => identityAdd({ qdrant, metadata: { ...ADR_META, status: 'current' } }),
    /reserved/i,
    'assertNoReservedFields runs before the identity branch',
  );
  assert.equal(qdrant.calls.upserts.length, 0);
});

// ---------------------------------------------------------------------------
// T2j — capture counters unchanged (spec D7)
// ---------------------------------------------------------------------------
test('T2j: identity write emits one capture.extraction row with outcome stored', async () => {
  // House pattern (capture-events.test.mjs): point the counters db at a fresh
  // temp file, run the write, read the rows back with sqlite.
  const dir = tempDir('um-adr-counters-');
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();

  const qdrant = makeMockQdrant();
  await identityAdd({ qdrant });

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare('SELECT surface, project, event, outcome, count FROM counters').all();
  } finally {
    db.close();
  }
  const extraction = rows.filter((r) => r.event === 'capture.extraction');
  assert.equal(extraction.length, 1, 'exactly one extraction row for the identity write');
  assert.equal(extraction[0].outcome, 'stored', 'extractionOutcomeFor default covers IDENTITY_UPSERT');
  assert.equal(extraction[0].surface, 'claude-code-plugin');
  assert.equal(extraction[0].project, 'universal-memory');
  assert.equal(extraction[0].count, 1);
});

// ---------------------------------------------------------------------------
// T2k — compat projection: IDENTITY_UPSERT → UPDATE, never NONE (spec D7, P9)
// ---------------------------------------------------------------------------
test('T2k: toMem0AddResults maps IDENTITY_UPSERT to UPDATE, not NONE', async () => {
  const { toMem0AddResults } = await import('../lib/mem0-compat.mjs');
  const projected = toMem0AddResults({ results: [{ id: 'p1', memory: TITLE, event: 'IDENTITY_UPSERT' }] });
  assert.equal(projected.results.length, 1);
  assert.equal(
    projected.results[0].event,
    'UPDATE',
    'a successful identity write must not read as nothing-happened to a mem0 client (the #279 silent-success class)',
  );
});

// ---------------------------------------------------------------------------
// T2l — carry-set constant agrees with isRecallable (FCP maintainability hardening)
// ---------------------------------------------------------------------------
test('T2l: IDENTITY_CARRY_FORWARD_FIELDS covers every metadata field isRecallable reads', () => {
  // Source-derived tripwire: extract every `md.<field>` reference from
  // recallable.mjs. A suppression field added there MUST be added to the
  // carry set (or this test consciously updated) — never silently resurrect.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recallable.mjs'), 'utf8');
  const reads = new Set([...src.matchAll(/\bmd\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(reads.size >= 2, 'sanity: isRecallable reads at least status + invalidated_at');
  for (const field of reads) {
    assert.ok(
      IDENTITY_CARRY_FORWARD_FIELDS.includes(field),
      `isRecallable reads '${field}' but IDENTITY_CARRY_FORWARD_FIELDS does not carry it — identity re-syncs would silently un-suppress on it`,
    );
  }
  // And the event-time pair rides along (spec D5).
  assert.ok(IDENTITY_CARRY_FORWARD_FIELDS.includes('createdAt'));
  assert.ok(IDENTITY_CARRY_FORWARD_FIELDS.includes('valid_from'));
  assert.ok(Object.isFrozen(IDENTITY_CARRY_FORWARD_FIELDS));
});
