/**
 * server/test/adr-identity-upsert.test.mjs — #279 identity-addressed ADR writes.
 *
 * Spec: docs/plans/2026-08-23-adr-identity-upsert-spec.md (D1–D7).
 * Test ids (T1*, T2a–T2l) map 1:1 to the paired plan's test contract.
 * T2m (#275, docs/plans/2026-08-31-adr-status-derivation-spec.md §5) pins
 * the adr_status → status derivation on the same real-write-path terms.
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
import { isRecallable } from '../lib/recallable.mjs';
import { NAMESPACE_UM, IDENTITY_CARRY_FORWARD_FIELDS, D3_SERVER_MANAGED_STATUS_FIELDS } from '../lib/dedup-constants.mjs';
import { _resetCaptureEventsForTest } from '../lib/capture-events.mjs';
import { toMem0AddResults } from '../lib/mem0-compat.mjs';
import { makeMockMemory } from './fixtures/qdrant-mock.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Counters-DB hygiene (review sweep): EVERY identity write in this file
// reaches recordCaptureEvent, so the counters path must be pinned to a temp
// db at MODULE TOP — not just inside the counter-asserting test — or T2a-T2i
// write real rows to the machine-default (or a developer's exported)
// UM_COUNTERS_DB_PATH. House pattern: capture-events.test.mjs.
process.env.UM_COUNTERS_DB_PATH = path.join(tempDir('um-adr-counters-'), 'um-counters.db');
_resetCaptureEventsForTest();

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
function makeMockQdrant({ retrievePoints = [], retrieveResult, scrollHit = null, searchHit = null, retrieveThrows = false } = {}) {
  const calls = { upserts: [], retrieves: [], scrolls: [], searches: [] };
  return {
    calls,
    client: {
      upsert: async (collection, body) => { calls.upserts.push({ collection, body }); return { status: 'ok' }; },
      retrieve: async (collection, body) => {
        calls.retrieves.push({ collection, body });
        if (retrieveThrows) throw new Error('retrieve transport failure');
        // retrieveResult (raw, any shape) wins over retrievePoints — the
        // fail-closed shape tests inject {points:[...]}/garbage through it.
        return retrieveResult !== undefined ? retrieveResult : retrievePoints;
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

// makeMockMemory comes from the shared fixture (review round: it was a
// byte-identical local duplicate). makeMockQdrant stays LOCAL on purpose:
// the shared fixture's retrieve is id-keyed and store-backed, while these
// tests must inject ARBITRARY retrieve result shapes ({points:[...]},
// garbage, payload-less records) to pin the identity branch's fail-closed
// shape handling — a knob the fixture deliberately does not expose.

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
  // HARDCODED literal, deliberately NOT recomputed via the same expression
  // (review round: a mirrored-expression expectation re-greens under a seed
  // change, silently orphaning every existing identity point — the literal
  // makes that impossible to do accidentally). If this test goes red, the
  // seed changed: that is a DATA MIGRATION, not a test update.
  assert.equal(id, 'b3af9dad-2ab3-52dd-9a30-2eddbb461c1a');
  // Belt-and-braces: the literal corresponds to the documented seed shape.
  assert.equal(id, uuidv5(JSON.stringify(['adr', 'E:/Projects/universal-memory', '0042', 'u-adr']), NAMESPACE_UM));
});

test('T1: input guards — non-string/empty adrId or userId throw; no wrong-but-well-formed ids', () => {
  // JSON.stringify serializes undefined array elements as null — without the
  // guard a missing adrId would mint a valid-looking uuid (review round).
  assert.throws(() => computeAdrIdentityId({ userId: 'u', adrId: undefined, repoPath: '/r' }), TypeError);
  assert.throws(() => computeAdrIdentityId({ userId: 'u', adrId: 42, repoPath: '/r' }), TypeError);
  assert.throws(() => computeAdrIdentityId({ userId: 'u', adrId: '', repoPath: '/r' }), TypeError);
  assert.throws(() => computeAdrIdentityId({ userId: '', adrId: '0001' }), TypeError);
  assert.throws(() => computeAdrIdentityId({ adrId: '0001' }), TypeError);
});

test('T1: repoPath is normalized INSIDE the derivation — \'\' and non-string collapse to null', () => {
  // The T5 cleanup/split-detector recomputes ids from stored payloads; the
  // id must be a pure function of the LOGICAL tuple however "absent" was
  // spelled (review round: call-site-only normalization diverges).
  const noPath = computeAdrIdentityId({ userId: 'u', adrId: '0001' });
  assert.equal(computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: '' }), noPath);
  assert.equal(computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: null }), noPath);
  assert.equal(computeAdrIdentityId({ userId: 'u', adrId: '0001', repoPath: 7 }), noPath);
  assert.equal(noPath, '5f26414a-76eb-5bd2-906a-03c94c926f94');
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

test('T2d: {points:[...]} REST envelope is tolerated as a retrieve shape', async () => {
  // Mirrors fetchScopedPoint's dual-shape tolerance (review round): a
  // wrapper/client returning the REST envelope must not read as a MISS.
  const prior = { id: 'x', payload: { createdAt: '2026-01-01T00:00:00.000Z' } };
  const qdrant = makeMockQdrant({ retrieveResult: { points: [prior] } });
  await identityAdd({ qdrant });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.equal(payload.createdAt, '2026-01-01T00:00:00.000Z', 'the envelope shape carried the prior forward');
});

test('T2d: unrecognized retrieve shapes fail CLOSED, not open-as-miss', async () => {
  // Review round (found by three independent angles): a defined-but-
  // unrecognized shape used to map to prior=null and silently re-date/
  // resurrect — the exact outcome D6's fail-closed contract forbids.
  for (const bad of [{ result: [] }, 'nonsense', 42, {}]) {
    const qdrant = makeMockQdrant({ retrieveResult: bad });
    await assert.rejects(
      () => identityAdd({ qdrant }),
      /unrecognized retrieve response shape/,
      `shape ${JSON.stringify(bad)} must throw`,
    );
    assert.equal(qdrant.calls.upserts.length, 0);
  }
  // A returned record WITHOUT a payload is equally unverifiable — fail closed.
  const qdrant = makeMockQdrant({ retrieveResult: [{ id: 'x' }] });
  await assert.rejects(() => identityAdd({ qdrant }), /retrieved point has no payload/);
  assert.equal(qdrant.calls.upserts.length, 0);
});

test('T2d: a caller-supplied USABLE valid_from wins over the carry on re-sync (RC2 parity)', async () => {
  // Review round (found by four independent angles): buildPayload's RC2
  // guard deliberately admits a usable caller valid_from; an unconditional
  // carry would silently discard the operator's event-time correction —
  // the same posted-value-never-lands class #279 fixes.
  const prior = {
    id: 'x',
    payload: { createdAt: '2026-01-01T00:00:00.000Z', valid_from: '2026-01-01T00:00:00.000Z' },
  };
  const qdrant = makeMockQdrant({ retrievePoints: [prior] });
  await identityAdd({ qdrant, metadata: { ...ADR_META, valid_from: '2025-12-15T00:00:00.000Z' } });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.equal(payload.valid_from, '2025-12-15T00:00:00.000Z', 'the correction lands');
  assert.equal(payload.createdAt, '2026-01-01T00:00:00.000Z', 'createdAt still carried (no caller path exists for it)');
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

test('T2e: reaction projection fields (#187) survive the full replace', async () => {
  // reaction-attach.mjs setPayload-patches reaction_count/reaction_types
  // onto existing points; a full replace that dropped them would silently
  // diverge the payload from the reaction ledger (review round).
  const prior = {
    id: 'x',
    payload: { createdAt: '2026-01-01T00:00:00.000Z', reaction_count: 2, reaction_types: ['👍'] },
  };
  const qdrant = makeMockQdrant({ retrievePoints: [prior] });
  await identityAdd({ qdrant });
  const payload = qdrant.calls.upserts[0].body.points[0].payload;
  assert.equal(payload.reaction_count, 2);
  assert.deepEqual(payload.reaction_types, ['👍']);
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

test('T2g: number-typed adr_id falls through WITH a warn breadcrumb', async () => {
  // Review round: a present-but-wrong-typed adr_id (a natural JSON-client
  // mistake) silently diverging into content-addressing is the #279 hazard
  // class — the fallthrough is correct, the silence was not.
  const warns = [];
  const qdrant = makeMockQdrant();
  const { result } = await identityAdd({
    qdrant,
    metadata: { ...ADR_META, adr_id: 42 },
    extra: { _logger: warnCapturingLogger(warns) },
  });
  assert.equal(result.results[0].event, 'ADD', 'legacy pipeline taken');
  const breadcrumbs = warns.filter((w) => w.obj?.event === 'adr.identity_skipped');
  assert.equal(breadcrumbs.length, 1, 'exactly one adr.identity_skipped warn');
  assert.equal(breadcrumbs[0].obj.adrIdType, 'number');
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
  assert.equal(extraction[0].outcome, 'stored', 'IDENTITY_UPSERT maps to stored (explicit case)');
  assert.equal(extraction[0].surface, 'claude-code-plugin');
  assert.equal(extraction[0].project, 'universal-memory');
  assert.equal(extraction[0].count, 1);
  assert.equal(rows.filter((r) => r.event === 'signal.reaction').length, 0,
    'no reaction metadata → no signal.reaction row');
});

test('T2j: a reacted identity write emits ONE signal.reaction stored row (#187 parity)', async () => {
  // Review round (found by four independent angles): the identity early
  // return skipped the per-reacted-call signal.reaction emit, silently
  // undercounting the #215 stored+reacted counts for this write class.
  const dir = tempDir('um-adr-counters-rx-');
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();

  const qdrant = makeMockQdrant();
  await identityAdd({ qdrant, metadata: { ...ADR_META, reaction_count: 1 } });

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare('SELECT event, outcome, count FROM counters').all();
  } finally {
    db.close();
  }
  const reaction = rows.filter((r) => r.event === 'signal.reaction');
  assert.equal(reaction.length, 1, 'one row per reacted call, mirroring the main path');
  assert.equal(reaction[0].outcome, 'stored');
  assert.equal(reaction[0].count, 1);
});

// ---------------------------------------------------------------------------
// T2k — compat projection: IDENTITY_UPSERT → UPDATE, never NONE (spec D7, P9)
// ---------------------------------------------------------------------------
test('T2k: toMem0AddResults maps IDENTITY_UPSERT to UPDATE, not NONE', () => {
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
  // md\??\. — optional-chaining reads (md?.field) count too (review round:
  // the bare-dot-only pattern would go blind under an innocent refactor
  // while the size sanity check stayed green off the surviving old reads).
  const reads = new Set([...src.matchAll(/\bmd\??\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(reads.size >= 2, 'sanity: isRecallable reads at least status + invalidated_at');
  for (const field of reads) {
    assert.ok(
      IDENTITY_CARRY_FORWARD_FIELDS.includes(field),
      `isRecallable reads '${field}' but IDENTITY_CARRY_FORWARD_FIELDS does not carry it — identity re-syncs would silently un-suppress on it`,
    );
  }
  // The status trio arrives by SPREAD from D3_SERVER_MANAGED_STATUS_FIELDS
  // (drift class T2l's isRecallable tripwire cannot see: bookkeeping fields).
  for (const field of D3_SERVER_MANAGED_STATUS_FIELDS) {
    assert.ok(IDENTITY_CARRY_FORWARD_FIELDS.includes(field), `D3 field '${field}' must be carried`);
  }
  // And the event-time pair + #187 reaction projection ride along (spec D5).
  assert.ok(IDENTITY_CARRY_FORWARD_FIELDS.includes('createdAt'));
  assert.ok(IDENTITY_CARRY_FORWARD_FIELDS.includes('valid_from'));
  assert.ok(IDENTITY_CARRY_FORWARD_FIELDS.includes('reaction_count'));
  assert.ok(IDENTITY_CARRY_FORWARD_FIELDS.includes('reaction_types'));
  assert.ok(Object.isFrozen(IDENTITY_CARRY_FORWARD_FIELDS));
});

// ---------------------------------------------------------------------------
// T2m — #275 adr_status → status derivation (spec §5 items 1-10). All through
// the REAL umAdd path (identityAdd) against the actually-upserted payload —
// a hardcoded map copy cannot satisfy these (§5 item 9's pinning rule).
// ---------------------------------------------------------------------------
function warnCapturingLogger(warns) {
  return { info: () => {}, warn: (obj, msg) => warns.push({ obj, msg }), error: () => {}, debug: () => {} };
}

function priorPoint(payload) {
  return { id: 'x', payload: { createdAt: '2026-01-01T00:00:00.000Z', ...payload } };
}

async function derivedPayload({ adrStatus, prior, warns } = {}) {
  const qdrant = makeMockQdrant(prior ? { retrievePoints: [prior] } : {});
  const { adr_status, ...metaWithoutStatus } = ADR_META;
  const metadata = adrStatus === undefined
    ? metaWithoutStatus
    : { ...ADR_META, adr_status: adrStatus };
  await identityAdd({ qdrant, metadata, ...(warns ? { extra: { _logger: warnCapturingLogger(warns) } } : {}) });
  return qdrant.calls.upserts[0].body.points[0].payload;
}

test('T2m-1: Superseded on fresh registration (MISS) lands status superseded', async () => {
  const payload = await derivedPayload({ adrStatus: 'Superseded' });
  assert.equal(payload.status, 'superseded', 'an already-retired ADR registers suppressed');
});

test('T2m-2: Superseded re-sync over prior current lands superseded (the carry-clobber core)', async () => {
  const payload = await derivedPayload({ adrStatus: 'Superseded', prior: priorPoint({ status: 'current' }) });
  assert.equal(payload.status, 'superseded', 'the carried current must NOT clobber the derivation');
});

test('T2m-3: Accepted re-sync over prior BARE superseded un-suppresses (spec D3, pinned deliberately)', async () => {
  const payload = await derivedPayload({ adrStatus: 'Accepted', prior: priorPoint({ status: 'superseded' }) });
  assert.equal(payload.status, 'current', 'bare status = derivation-owned; frontmatter is authoritative');
});

test('T2m-4: Accepted re-sync over mechanism-demoted prior stays superseded (provenance gates the clear)', async () => {
  const payload = await derivedPayload({
    adrStatus: 'Accepted',
    prior: priorPoint({ status: 'superseded', supersededBy: 'point-b', supersededAt: '2026-02-01T00:00:00.000Z' }),
  });
  assert.equal(payload.status, 'superseded', 'mechanism demotions are one-way under sync (T2e restated at the derivation boundary)');
  assert.equal(payload.supersededBy, 'point-b');
});

test('T2m-4b: SUPPRESS intent over a mechanism-demoted prior relabels status; provenance rides along, still suppressed', async () => {
  // The provenance gate protects against UN-suppression only — a
  // suppress-intent sync may relabel the status VALUE (dedup-constants
  // family-1 docblock, corrected wording). Pinned so a future refactor
  // cannot "helpfully" gate the suppress branch on provenanceClear.
  const payload = await derivedPayload({
    adrStatus: 'Rejected',
    prior: priorPoint({ status: 'superseded', supersededBy: 'point-b', supersededAt: '2026-02-01T00:00:00.000Z' }),
  });
  assert.equal(payload.status, 'rejected', 'suppress wins over the carry unconditionally');
  assert.equal(payload.supersededBy, 'point-b', 'provenance carried untouched');
  assert.equal(isRecallable({ metadata: payload }), false, 'suppressed either way — never a resurrection');
});

test('T2m-5: invalidated_at alone blocks the clear; carried regardless (forward-looking pin)', async () => {
  // No live mechanism writes invalidated_at to identity points today — this
  // pins the D3 constraint for the mechanism that eventually does.
  const payload = await derivedPayload({
    adrStatus: 'Accepted',
    prior: priorPoint({ status: 'superseded', invalidated_at: '2026-03-01T00:00:00.000Z' }),
  });
  assert.equal(payload.status, 'superseded', 'clear gate must not fire while invalidated_at is present');
  assert.equal(payload.invalidated_at, '2026-03-01T00:00:00.000Z');
});

test('T2m-6: unrecognized value derives nothing in either direction; exactly one WARN with the offending value', async () => {
  const warnsA = [];
  const a = await derivedPayload({ adrStatus: 'Superseded by ADR-0008', prior: priorPoint({ status: 'current' }), warns: warnsA });
  assert.equal(a.status, 'current', 'prose-style status must not suppress');
  const warnRowsA = warnsA.filter((w) => w.obj?.event === 'adr.status_unrecognized');
  assert.equal(warnRowsA.length, 1, 'exactly one adr.status_unrecognized warn per call');
  assert.equal(warnRowsA[0].obj.adr_status, 'Superseded by ADR-0008');

  const warnsB = [];
  const b = await derivedPayload({ adrStatus: 'Superceded', prior: priorPoint({ status: 'superseded' }), warns: warnsB });
  assert.equal(b.status, 'superseded', 'a typo must not resurrect a suppressed point');
  assert.equal(warnsB.filter((w) => w.obj?.event === 'adr.status_unrecognized').length, 1);
});

test('T2m-6b: absent, empty, and whitespace-only adr_status derive nothing and do not WARN (no-signal arm)', async () => {
  const warns = [];
  const payload = await derivedPayload({ prior: priorPoint({ status: 'superseded' }), warns });
  assert.equal(payload.status, 'superseded', 'carry semantics unchanged when no signal');
  assert.equal(warns.filter((w) => w.obj?.event === 'adr.status_unrecognized').length, 0);
  for (const blank of ['', '   ']) {
    const w = [];
    const p = await derivedPayload({ adrStatus: blank, prior: priorPoint({ status: 'superseded' }), warns: w });
    assert.equal(p.status, 'superseded', `blank '${blank}' must not change status`);
    assert.equal(w.filter((x) => x.obj?.event === 'adr.status_unrecognized').length, 0,
      `blank '${blank}' is no-signal, not unrecognized (review: a blank is not an authored token)`);
  }
});

test('T2m-7: matching is trim + case-insensitive', async () => {
  for (const v of [' Superseded ', 'SUPERSEDED', 'superseded']) {
    const payload = await derivedPayload({ adrStatus: v });
    assert.equal(payload.status, 'superseded', `'${v}' must suppress`);
  }
});

test('T2m-8: Deprecated / Rejected map to their lowercase read-side values', async () => {
  assert.equal((await derivedPayload({ adrStatus: 'Deprecated' })).status, 'deprecated');
  assert.equal((await derivedPayload({ adrStatus: 'Rejected' })).status, 'rejected');
});

test('T2m-9: every suppressing derivation is non-recallable — lockstep via the REAL write path', async () => {
  // §5 item 9's pinning rule: a typo'd map value must fail HERE, so the
  // assertion runs against the actually-upserted payload, never the D2 table.
  for (const v of ['Superseded', 'Deprecated', 'Rejected']) {
    const payload = await derivedPayload({ adrStatus: v });
    assert.equal(
      isRecallable({ metadata: payload }),
      false,
      `adr_status '${v}' must leave the point non-recallable (write-side map drifted from recallable.mjs?)`,
    );
  }
  // And the clear side stays recallable.
  const cleared = await derivedPayload({ adrStatus: 'Accepted' });
  assert.equal(isRecallable({ metadata: cleared }), true);
});

test('T2m-10: prototype-chain keys are unrecognized — never a suppress, never a resurrect (D2 own-keys-only)', async () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const warns = [];
    const payload = await derivedPayload({ adrStatus: key, prior: priorPoint({ status: 'superseded' }), warns });
    assert.equal(payload.status, 'superseded', `'${key}' must not clear a suppressed point`);
    assert.equal(typeof payload.status, 'string', `'${key}' must not assign a non-string status`);
    assert.equal(warns.filter((w) => w.obj?.event === 'adr.status_unrecognized').length, 1, `one WARN for '${key}'`);
  }
});
