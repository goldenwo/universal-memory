/**
 * Tests for the mem0 Platform-compat facade — Batch 3 (plan Tasks 4-6):
 * the per-route business logic behind handleMem0Compat, with mocked
 * internals (fake memory client / fake qdrant client / fake embed
 * provider / fake umAdd — the house `_`-prefixed DI-seam style).
 *
 * Run with: node --test server/test/mem0-compat-handlers.test.mjs
 *
 * Contract pins (spec §3 route table, §4 projection, §5 identity, §6 by-id
 * scope check):
 *   - R2 messages[] → ONE role-prefixed transcript umAdd (infer default);
 *     infer:false → one verbatim umAdd per message. agent_id/app_id/run_id
 *     stored snake_case in metadata (so applyMem0Filters' metadata fallback
 *     matches on read). Provenance from X-Mem0-Source, else 'mem0-compat'.
 *   - R3 over-fetch max(top_k*3, 30) → project → facade-side filter →
 *     threshold (default 0.3) → truncate top_k. RAW mem0 record shape:
 *     createdAt/updatedAt/userId at TOP level (mem0ai excludes them from
 *     metadata — dist/oss/index.mjs excludedKeys), projector must translate.
 *   - R4 page/page_size window, page_size capped at 500.
 *   - R5/R6/R7 by-id ops: fetch → payload.userId === operator → else 404
 *     (never 400, never acted on — foreign-point existence is not leaked).
 *   - R6 same-id re-embed upsert preserving the umAdd payload schema;
 *     hash-collision-with-another-point tolerated by design.
 *   - R8/R9 scan-then-delete-by-ids; scope refusal; system docs protected.
 *   - user_id anywhere in body/query/filters MUST equal the operator → 400.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleMem0Compat } from '../lib/mem0-compat.mjs';
import { SERVER_VERSION } from '../lib/version.mjs';

const md5 = (s) => createHash('md5').update(s).digest('hex');

const OP = 'op-user';
const COLLECTION = 'um_test';

// ---------------------------------------------------------------------------
// Fakes (mirror the ctx.memory injection style of search-quality.test.mjs
// and the _qdrantClient / _embedProviderOverride seams of add.test.mjs).
// ---------------------------------------------------------------------------

function makeMemory({ searchResults = [], getAllResults = [] } = {}) {
  const calls = { search: [], getAll: [], delete: [] };
  return {
    calls,
    config: { vectorStore: { config: { collectionName: COLLECTION } } },
    async search(query, opts) { calls.search.push({ query, opts }); return { results: searchResults }; },
    async getAll(opts) { calls.getAll.push(opts); return { results: getAllResults }; },
    async delete(id) { calls.delete.push(id); return { message: 'Memory deleted successfully!' }; },
  };
}

function makeQdrant(points = []) {
  const calls = { retrieve: [], upsert: [], setPayload: [], delete: [] };
  return {
    calls,
    async retrieve(collection, { ids }) {
      calls.retrieve.push({ collection, ids });
      return points.filter((p) => ids.includes(p.id));
    },
    async upsert(collection, args) { calls.upsert.push({ collection, args }); },
    async setPayload(collection, args) { calls.setPayload.push({ collection, args }); },
    async delete(collection, args) { calls.delete.push({ collection, args }); },
  };
}

function makeUmAdd(result) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return result ?? { results: [{ id: `stored-${calls.length}`, memory: args.text, event: 'ADD' }] };
  };
  fn.calls = calls;
  return fn;
}

function makeEmbedProvider(vector = [0.1, 0.2, 0.3]) {
  const calls = [];
  return { calls, embed: async (text) => { calls.push(text); return { vector, usage: { tokensIn: 1, tokensOut: 0 } }; } };
}

function ctxOf({ memory, qdrant, umAdd, embedProvider } = {}) {
  return {
    userId: OP,
    memory: memory ?? makeMemory(),
    _qdrantClient: qdrant ?? makeQdrant(),
    _umAdd: umAdd ?? makeUmAdd(),
    _embedProviderOverride: embedProvider ?? makeEmbedProvider(),
  };
}

const call = (method, path, body, ctx, headers = {}) =>
  handleMem0Compat({ method, headers }, new URL(path, 'http://x'), body, ctx);

/** RAW mem0 search/getAll record — REAL shape: camelCase timestamp/user
 *  fields at TOP level, NOT inside metadata (mem0ai excludedKeys). */
function rawRecord(id, { score, metadata = {}, userId = OP, memory, createdAt = '2026-06-01T00:00:00Z' } = {}) {
  const rec = { id, memory: memory ?? `fact-${id}`, hash: 'h', createdAt, metadata, userId };
  if (score !== undefined) rec.score = score;
  return rec;
}

/** A stored qdrant point exactly as umAdd's buildPayload writes it. */
function point(id, { userId = OP, data = `text-${id}`, extra = {} } = {}) {
  return {
    id,
    payload: {
      userId,
      data,
      hash: md5(data),
      createdAt: '2026-05-01T00:00:00Z',
      lane: 'work',
      surfaces: ['mcp'],
      dedupCount: 1,
      dedupVersion: 1,
      status: 'current',
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// R1 — GET /v1/ping/
// ---------------------------------------------------------------------------

test('R1 ping: 200 {status, name, version=SERVER_VERSION}', async () => {
  const out = await call('GET', '/v1/ping/', undefined, ctxOf());
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { status: 'ok', name: 'universal-memory', version: SERVER_VERSION });
});

// ---------------------------------------------------------------------------
// R2 — POST /v1/memories/
// ---------------------------------------------------------------------------

test('R2 add: messages[] joined into ONE role-prefixed transcript umAdd (infer default)', async () => {
  const umAdd = makeUmAdd({ results: [{ id: 'i1', memory: 'f1', event: 'ADD' }, { id: 'i2', memory: 'f2', event: 'DEDUP_MERGED', supersededId: 'z' }] });
  const ctx = ctxOf({ umAdd });
  const out = await call('POST', '/v1/memories/', {
    messages: [{ role: 'user', content: 'I moved to Lisbon' }, { role: 'assistant', content: 'Noted!' }],
  }, ctx);
  assert.equal(out.status, 200);
  assert.equal(umAdd.calls.length, 1);
  const args = umAdd.calls[0];
  assert.equal(args.text, 'user: I moved to Lisbon\nassistant: Noted!');
  assert.equal(args.infer, true);
  assert.equal(args.userId, OP);
  assert.equal(args.memory, ctx.memory);
  assert.equal(args.surface, 'mem0-compat');
  // extra per-result fields (supersededId) dropped by the dialect projection
  assert.deepEqual(out.body, { results: [{ id: 'i1', memory: 'f1', event: 'ADD' }, { id: 'i2', memory: 'f2', event: 'DEDUP_MERGED' }] });
});

test('R2 add: X-Mem0-Source header → lowercased surface tag (provenance §7)', async () => {
  const umAdd = makeUmAdd();
  await call('POST', '/v1/memories/', { messages: [{ role: 'user', content: 'x' }] },
    ctxOf({ umAdd }), { 'x-mem0-source': 'OpenClaw' });
  assert.equal(umAdd.calls[0].surface, 'openclaw');
});

test('R2 add: agent_id/app_id/run_id stored snake_case in metadata + categories + caller metadata merged', async () => {
  const umAdd = makeUmAdd();
  await call('POST', '/v1/memories/', {
    messages: [{ role: 'user', content: 'x' }],
    agent_id: 'agent-1',
    app_id: 'app-1',
    run_id: 'run-1',
    categories: ['ops'],
    metadata: { note: 'kept' },
  }, ctxOf({ umAdd }));
  const md = umAdd.calls[0].metadata;
  // snake_case names are LOAD-BEARING: applyMem0Filters' eq fallback reads
  // record.metadata.agent_id etc. (mem0-compat-pure.test.mjs ambiguity note)
  assert.equal(md.agent_id, 'agent-1');
  assert.equal(md.app_id, 'app-1');
  assert.equal(md.run_id, 'run-1');
  assert.deepEqual(md.categories, ['ops']);
  assert.equal(md.note, 'kept');
});

test('R2 add: infer:false → one verbatim umAdd per message, results concatenated', async () => {
  const umAdd = makeUmAdd(); // echoes args.text per call
  const out = await call('POST', '/v1/memories/', {
    messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }],
    infer: false,
  }, ctxOf({ umAdd }));
  assert.equal(out.status, 200);
  assert.equal(umAdd.calls.length, 2);
  assert.equal(umAdd.calls[0].text, 'first');
  assert.equal(umAdd.calls[0].infer, false);
  assert.equal(umAdd.calls[1].text, 'second');
  assert.equal(umAdd.calls[1].infer, false);
  assert.deepEqual(out.body.results.map((r) => r.memory), ['first', 'second']);
});

test('R2 add: absent / empty / content-less messages → 400 {detail}', async () => {
  for (const body of [undefined, {}, { messages: [] }, { messages: [{ role: 'user', content: '' }] }]) {
    const out = await call('POST', '/v1/memories/', body, ctxOf());
    assert.equal(out.status, 400, `body ${JSON.stringify(body)}`);
    assert.equal(typeof out.body.detail, 'string');
  }
});

test('R2 add: user_id mismatch → 400; matching user_id accepted', async () => {
  const umAdd = makeUmAdd();
  const bad = await call('POST', '/v1/memories/', { messages: [{ role: 'user', content: 'x' }], user_id: 'someone-else' }, ctxOf({ umAdd }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.detail, /user_id/);
  assert.equal(umAdd.calls.length, 0, 'mismatched write must not reach umAdd');
  const ok = await call('POST', '/v1/memories/', { messages: [{ role: 'user', content: 'x' }], user_id: OP }, ctxOf({ umAdd }));
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------------------
// R3 — POST /v2/memories/search/
// ---------------------------------------------------------------------------

test('R3 search: over-fetch max(top_k*3,30), threshold drop, top_k truncate, mem0 projection', async () => {
  const memory = makeMemory({
    searchResults: [
      rawRecord('s1', { score: 0.9, metadata: { lane: 'work' } }),
      rawRecord('s2', { score: 0.5 }),
      rawRecord('s3', { score: 0.45 }),
      rawRecord('s4', { score: 0.2 }), // below default threshold 0.3 → dropped
    ],
  });
  const out = await call('POST', '/v2/memories/search/', { query: 'lisbon', top_k: 2 }, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.equal(memory.calls.search.length, 1);
  assert.equal(memory.calls.search[0].query, 'lisbon');
  assert.deepEqual(memory.calls.search[0].opts, { userId: OP, limit: 30 }); // max(2*3, 30)
  assert.deepEqual(out.body.results.map((r) => r.id), ['s1', 's2']); // truncated to top_k
  // mem0-dialect projection from the REAL raw shape (top-level camelCase)
  const first = out.body.results[0];
  assert.equal(first.memory, 'fact-s1');
  assert.equal(first.user_id, OP);
  assert.equal(first.created_at, '2026-06-01T00:00:00Z');
  assert.deepEqual(first.categories, ['work']);
  assert.equal(first.score, 0.9);
});

test('R3 search: top_k default 10 → over-fetch limit 30; explicit threshold honored', async () => {
  const memory = makeMemory({
    searchResults: [rawRecord('s1', { score: 0.9 }), rawRecord('s2', { score: 0.5 })],
  });
  const out = await call('POST', '/v2/memories/search/', { query: 'q', threshold: 0.85 }, ctxOf({ memory }));
  assert.deepEqual(memory.calls.search[0].opts, { userId: OP, limit: 30 });
  assert.deepEqual(out.body.results.map((r) => r.id), ['s1']);
});

test('R3 search: facade-side filters post-retrieval (agent_id via stored metadata)', async () => {
  const memory = makeMemory({
    searchResults: [
      rawRecord('s1', { score: 0.9, metadata: { agent_id: 'a1' } }),
      rawRecord('s2', { score: 0.8, metadata: { agent_id: 'a2' } }),
    ],
  });
  const out = await call('POST', '/v2/memories/search/', { query: 'q', filters: { agent_id: 'a2' } }, ctxOf({ memory }));
  assert.deepEqual(out.body.results.map((r) => r.id), ['s2']);
});

test('R3 search: unknown filter key → 400 {detail} (CompatFilterError, fail-loud)', async () => {
  const out = await call('POST', '/v2/memories/search/', { query: 'q', filters: { bogus: 'x' } }, ctxOf());
  assert.equal(out.status, 400);
  assert.match(out.body.detail, /bogus/);
});

test('R3 search: filters user_id mismatch → 400 (no impersonation, spec §5)', async () => {
  const memory = makeMemory({ searchResults: [rawRecord('s1', { score: 0.9 })] });
  const out = await call('POST', '/v2/memories/search/', { query: 'q', filters: { user_id: 'other' } }, ctxOf({ memory }));
  assert.equal(out.status, 400);
  assert.match(out.body.detail, /user_id/);
  assert.equal(memory.calls.search.length, 0, 'mismatch refused before retrieval');
});

test('R3 search: rerank/keyword_search/fields accepted and ignored (documented no-ops)', async () => {
  const memory = makeMemory({ searchResults: [rawRecord('s1', { score: 0.9 })] });
  const out = await call('POST', '/v2/memories/search/', {
    query: 'q', rerank: true, keyword_search: true, fields: ['memory'],
  }, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.results.map((r) => r.id), ['s1']);
});

test('R3 search: missing query → 400 {detail}', async () => {
  const out = await call('POST', '/v2/memories/search/', {}, ctxOf());
  assert.equal(out.status, 400);
});

test('R3 search: superseded/system records excluded (read-path parity with doSearch)', async () => {
  const memory = makeMemory({
    searchResults: [
      rawRecord('s1', { score: 0.9 }),
      rawRecord('s2', { score: 0.8, metadata: { status: 'superseded' } }),
      rawRecord('sys', { score: 0.7, metadata: { id: '_um_embedding_stamp' } }),
    ],
  });
  const out = await call('POST', '/v2/memories/search/', { query: 'q' }, ctxOf({ memory }));
  assert.deepEqual(out.body.results.map((r) => r.id), ['s1']);
});

// ---------------------------------------------------------------------------
// R4 — POST /v2/memories/ (list with page window)
// ---------------------------------------------------------------------------

test('R4 list: full-list projection + filters + system-doc exclusion', async () => {
  const memory = makeMemory({
    getAllResults: [
      rawRecord('g1', { metadata: { agent_id: 'a1' } }),
      rawRecord('g2', { metadata: { agent_id: 'a2' } }),
      rawRecord('sys', { metadata: { id: '_um_embedding_stamp' } }),
    ],
  });
  const out = await call('POST', '/v2/memories/', { filters: { agent_id: 'a1' } }, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.equal(memory.calls.getAll[0].userId, OP);
  assert.deepEqual(out.body.results.map((r) => r.id), ['g1']);
  assert.equal(out.body.results[0].user_id, OP);
});

test('R4 list: page/page_size window from query params', async () => {
  const memory = makeMemory({
    getAllResults: ['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => rawRecord(id)),
  });
  const out = await call('POST', '/v2/memories/?page=2&page_size=2', {}, ctxOf({ memory }));
  assert.deepEqual(out.body.results.map((r) => r.id), ['g3', 'g4']);
});

test('R4 list: page_size capped at 500 (attacker-supplied sizes clamped)', async () => {
  const memory = makeMemory({
    getAllResults: Array.from({ length: 505 }, (_, i) => rawRecord(`g${i}`)),
  });
  const out = await call('POST', '/v2/memories/?page=1&page_size=9999', {}, ctxOf({ memory }));
  assert.equal(out.body.results.length, 500);
});

test('R4 list: bad filters → 400; filters user_id mismatch → 400', async () => {
  const bad = await call('POST', '/v2/memories/', { filters: { nope: 1 } }, ctxOf());
  assert.equal(bad.status, 400);
  const mismatch = await call('POST', '/v2/memories/', { filters: { user_id: 'other' } }, ctxOf());
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.detail, /user_id/);
});

// ---------------------------------------------------------------------------
// R5 — GET /v1/memories/{id}/ (by-id scope check → 404, spec §6)
// ---------------------------------------------------------------------------

test('R5 get: own point → 200 mem0 record built from the qdrant payload', async () => {
  const qdrant = makeQdrant([point('p1')]);
  const out = await call('GET', '/v1/memories/p1/', undefined, ctxOf({ qdrant }));
  assert.equal(out.status, 200);
  assert.equal(out.body.id, 'p1');
  assert.equal(out.body.memory, 'text-p1');
  assert.equal(out.body.user_id, OP);
  assert.equal(out.body.created_at, '2026-05-01T00:00:00Z');
  assert.deepEqual(out.body.categories, ['work']);
  // internal storage fields must not leak as dialect metadata top-levels
  assert.equal('data' in out.body.metadata, false);
  assert.equal('userId' in out.body.metadata, false);
});

test('R5 get: foreign-userId point → 404 (existence not leaked)', async () => {
  const qdrant = makeQdrant([point('p1', { userId: 'someone-else' })]);
  const out = await call('GET', '/v1/memories/p1/', undefined, ctxOf({ qdrant }));
  assert.equal(out.status, 404);
  assert.match(out.body.detail, /not found/i);
});

test('R5 get: absent id → 404 {detail}', async () => {
  const out = await call('GET', '/v1/memories/nope/', undefined, ctxOf({ qdrant: makeQdrant() }));
  assert.equal(out.status, 404);
});

// ---------------------------------------------------------------------------
// R6 — PUT /v1/memories/{id}/ (direct-qdrant same-id update)
// ---------------------------------------------------------------------------

test('R6 update: text → re-embed + SAME-id upsert preserving the umAdd payload schema', async () => {
  const qdrant = makeQdrant([point('p1', { data: 'old text' })]);
  const embedProvider = makeEmbedProvider([0.4, 0.5, 0.6]);
  const out = await call('PUT', '/v1/memories/p1/', { text: 'new text', metadata: { note: 'edited' } },
    ctxOf({ qdrant, embedProvider }));
  assert.equal(out.status, 200);
  assert.equal(embedProvider.calls.length, 1);
  assert.equal(embedProvider.calls[0], 'new text');
  assert.equal(qdrant.calls.upsert.length, 1);
  const { collection, args } = qdrant.calls.upsert[0];
  assert.equal(collection, COLLECTION);
  assert.equal(args.points.length, 1);
  const p = args.points[0];
  assert.equal(p.id, 'p1'); // SAME point id — the R6 invariant
  assert.deepEqual(p.vector, [0.4, 0.5, 0.6]);
  assert.equal(p.payload.data, 'new text');
  assert.equal(p.payload.hash, md5('new text')); // hash refreshed
  assert.equal(p.payload.userId, OP); // carried
  assert.equal(p.payload.createdAt, '2026-05-01T00:00:00Z'); // carried
  assert.deepEqual(p.payload.surfaces, ['mcp']); // carried
  assert.equal(p.payload.status, 'current'); // carried
  assert.equal(p.payload.note, 'edited'); // metadata merged
  assert.equal(typeof p.payload.updatedAt, 'string'); // set
  // response: updated record projected + event
  assert.equal(out.body.event, 'UPDATE');
  assert.equal(out.body.memory, 'new text');
  assert.equal(out.body.updated_at, p.payload.updatedAt);
});

test('R6 update: metadata-only → setPayload merge, NO re-embed, NO upsert', async () => {
  const qdrant = makeQdrant([point('p1')]);
  const embedProvider = makeEmbedProvider();
  const out = await call('PUT', '/v1/memories/p1/', { metadata: { note: 'x' } }, ctxOf({ qdrant, embedProvider }));
  assert.equal(out.status, 200);
  assert.equal(embedProvider.calls.length, 0);
  assert.equal(qdrant.calls.upsert.length, 0);
  assert.equal(qdrant.calls.setPayload.length, 1);
  const { args } = qdrant.calls.setPayload[0];
  assert.deepEqual(args.points, ['p1']);
  assert.equal(args.payload.note, 'x');
  assert.equal(typeof args.payload.updatedAt, 'string');
  assert.equal(out.body.event, 'UPDATE');
  assert.equal(out.body.memory, 'text-p1'); // text untouched
  assert.equal(out.body.metadata.note, 'x');
});

test('R6 update: foreign point → 404 and NOT acted on', async () => {
  const qdrant = makeQdrant([point('p1', { userId: 'someone-else' })]);
  const out = await call('PUT', '/v1/memories/p1/', { text: 'hijack' }, ctxOf({ qdrant }));
  assert.equal(out.status, 404);
  assert.equal(qdrant.calls.upsert.length, 0);
  assert.equal(qdrant.calls.setPayload.length, 0);
});

test('R6 update: neither text nor metadata → 400 {detail}', async () => {
  const qdrant = makeQdrant([point('p1')]);
  const out = await call('PUT', '/v1/memories/p1/', {}, ctxOf({ qdrant }));
  assert.equal(out.status, 400);
});

test('R6 update: post-update hash collision with a DIFFERENT point is tolerated (both survive)', async () => {
  // p2 already stores the exact text p1 is being updated to → same hash.
  const qdrant = makeQdrant([point('p1', { data: 'old text' }), point('p2', { data: 'new text' })]);
  const out = await call('PUT', '/v1/memories/p1/', { text: 'new text' }, ctxOf({ qdrant }));
  assert.equal(out.status, 200);
  assert.equal(qdrant.calls.upsert.length, 1);
  assert.equal(qdrant.calls.upsert[0].args.points[0].id, 'p1'); // p1 updated in place
  assert.equal(qdrant.calls.delete.length, 0); // p2 untouched — two points may share a hash
  assert.equal(qdrant.calls.setPayload.length, 0);
});

test('R6 update: client metadata cannot clobber schema fields (userId/data/hash/createdAt)', async () => {
  const qdrant = makeQdrant([point('p1', { data: 'old text' })]);
  const out = await call('PUT', '/v1/memories/p1/', {
    text: 'new text',
    metadata: { userId: 'evil', data: 'evil', hash: 'evil', createdAt: 'evil', note: 'ok' },
  }, ctxOf({ qdrant }));
  assert.equal(out.status, 200);
  const p = qdrant.calls.upsert[0].args.points[0];
  assert.equal(p.payload.userId, OP);
  assert.equal(p.payload.data, 'new text');
  assert.equal(p.payload.hash, md5('new text'));
  assert.equal(p.payload.createdAt, '2026-05-01T00:00:00Z');
  assert.equal(p.payload.note, 'ok');
});

// ---------------------------------------------------------------------------
// R7 — DELETE /v1/memories/{id}/
// ---------------------------------------------------------------------------

test('R7 delete: own point → memory.delete(id) → 200 {message}', async () => {
  const memory = makeMemory();
  const qdrant = makeQdrant([point('p1')]);
  const out = await call('DELETE', '/v1/memories/p1/', undefined, ctxOf({ memory, qdrant }));
  assert.equal(out.status, 200);
  assert.deepEqual(memory.calls.delete, ['p1']);
  assert.deepEqual(out.body, { message: 'Memory deleted successfully!' });
});

test('R7 delete: foreign point → 404, delete NOT called', async () => {
  const memory = makeMemory();
  const qdrant = makeQdrant([point('p1', { userId: 'someone-else' })]);
  const out = await call('DELETE', '/v1/memories/p1/', undefined, ctxOf({ memory, qdrant }));
  assert.equal(out.status, 404);
  assert.equal(memory.calls.delete.length, 0);
});

test('R7 delete: absent id → 404', async () => {
  const out = await call('DELETE', '/v1/memories/nope/', undefined, ctxOf({ qdrant: makeQdrant() }));
  assert.equal(out.status, 404);
});

// ---------------------------------------------------------------------------
// R8 — DELETE /v1/memories/?user_id=&agent_id=&app_id=&run_id=
// ---------------------------------------------------------------------------

const bulkFixture = () => makeMemory({
  getAllResults: [
    rawRecord('g1', { metadata: { agent_id: 'a1' } }),
    rawRecord('g2', { metadata: { agent_id: 'a2', run_id: 'r1' } }),
    rawRecord('g3', { metadata: {} }),
    rawRecord('sys', { metadata: { id: '_um_embedding_stamp' } }),
  ],
});

test('R8 bulk delete: NO recognized scope param → 400 refusal', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', '/v1/memories/', undefined, ctxOf({ memory }));
  assert.equal(out.status, 400);
  assert.equal(memory.calls.delete.length, 0);
});

test('R8 bulk delete: user_id mismatch → 400', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', '/v1/memories/?user_id=other', undefined, ctxOf({ memory }));
  assert.equal(out.status, 400);
  assert.match(out.body.detail, /user_id/);
  assert.equal(memory.calls.delete.length, 0);
});

test('R8 bulk delete: user_id=operator → deletes all operator memories EXCEPT system docs', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', `/v1/memories/?user_id=${OP}`, undefined, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.deepEqual(memory.calls.delete.sort(), ['g1', 'g2', 'g3']);
  assert.deepEqual(out.body, { message: '3 memories deleted' });
});

test('R8 bulk delete: agent_id scope → only matching-metadata points deleted', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', '/v1/memories/?agent_id=a1', undefined, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.deepEqual(memory.calls.delete, ['g1']);
  assert.deepEqual(out.body, { message: '1 memories deleted' });
});

test('R8 bulk delete: multiple scope params AND together', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', '/v1/memories/?agent_id=a2&run_id=r1', undefined, ctxOf({ memory }));
  assert.deepEqual(memory.calls.delete, ['g2']);
  assert.equal(out.status, 200);
});

// ---------------------------------------------------------------------------
// R9 — DELETE /v2/entities/{type}/{id}/
// ---------------------------------------------------------------------------

test('R9 entity delete: user/<operator> → full operator wipe (system docs protected)', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', `/v2/entities/user/${OP}/`, undefined, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.deepEqual(memory.calls.delete.sort(), ['g1', 'g2', 'g3']);
  assert.deepEqual(out.body, { message: '3 memories deleted' });
});

test('R9 entity delete: user/<foreign> → 404 (spec §6 no-leak), nothing deleted', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', '/v2/entities/user/other/', undefined, ctxOf({ memory }));
  assert.equal(out.status, 404);
  assert.equal(memory.calls.delete.length, 0);
});

test('R9 entity delete: agent/<id> → scan filtered on stored agent_id metadata', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', '/v2/entities/agent/a2/', undefined, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.deepEqual(memory.calls.delete, ['g2']);
});

test('R9 entity delete: unknown type → 400 {detail}', async () => {
  const memory = bulkFixture();
  const out = await call('DELETE', '/v2/entities/bogus/x/', undefined, ctxOf({ memory }));
  assert.equal(out.status, 400);
  assert.equal(memory.calls.delete.length, 0);
});

// ---------------------------------------------------------------------------
// R10 — GET /v1/entities/
// ---------------------------------------------------------------------------

test('R10 entities: single-operator projection with total_memories (system docs excluded)', async () => {
  const memory = bulkFixture();
  const out = await call('GET', '/v1/entities/', undefined, ctxOf({ memory }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { results: [{ type: 'user', id: OP, total_memories: 3 }] });
});

// ---------------------------------------------------------------------------
// R11 — events (degrade to empty / 404)
// ---------------------------------------------------------------------------

test('R11 events: list → 200 {results: []}', async () => {
  const out = await call('GET', '/v1/events/', undefined, ctxOf());
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { results: [] });
});

test('R11 events: by id → 404 {detail}', async () => {
  const out = await call('GET', '/v1/event/abc/', undefined, ctxOf());
  assert.equal(out.status, 404);
  assert.equal(typeof out.body.detail, 'string');
});

// ---------------------------------------------------------------------------
// Error dialect — handler exceptions stay {detail}, never the UM envelope
// ---------------------------------------------------------------------------

test('dispatcher: handler exception → 500 {detail} in the mem0 dialect', async () => {
  const memory = makeMemory();
  memory.search = async () => { throw new Error('qdrant down'); };
  const out = await call('POST', '/v2/memories/search/', { query: 'q' }, ctxOf({ memory }));
  assert.equal(out.status, 500);
  assert.equal(typeof out.body.detail, 'string');
});
