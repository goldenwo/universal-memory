import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runDump, runJudge, runApplyPreflights, runApplyWrite } from '../../cli/mem0-import.mjs';

// The live write-loop test runs only with UM_LIVE_TESTS=1 (mirrors cli/test/reindex-e2e),
// needing a reachable qdrant + OPENAI_API_KEY + server deps resolvable. The heavy deps
// (@qdrant/js-client-rest, reindex/createMemoryInstance) are dynamic-imported INSIDE the
// gated test so this file loads cleanly offline (where those deps aren't on cli/'s path).
const LIVE_SKIP = !process.env.UM_LIVE_TESTS;
const QHOST = process.env.QDRANT_HOST || 'localhost';
const QPORT = parseInt(process.env.QDRANT_PORT || '6333', 10);

test('parseArgs reads stage + workdir + manifest', () => {
  const a = parseArgs(['--apply', '--workdir', '/tmp/imp', '--manifest', '/tmp/imp/m.jsonl']);
  assert.equal(a.stage, 'apply');
  assert.equal(a.workdir, '/tmp/imp');
  assert.equal(a.manifest, '/tmp/imp/m.jsonl');
});

test('runDump reads a hand-saved JSONL source into canonical records + counts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem0imp-'));
  const src = path.join(dir, 'source.jsonl');
  await fs.writeFile(src, [
    JSON.stringify({ id: 'm1', memory: 'Golden uses EST' }),
    JSON.stringify({ id: 'm2', memory: 'Date is 2026-04-15' }),
  ].join('\n') + '\n');
  const res = await runDump({ source: src, workdir: dir });
  assert.equal(res.count, 2);
  assert.deepEqual(res.records[0], { mem0_id: 'm1', text: 'Golden uses EST' });
  const dump = JSON.parse((await fs.readFile(path.join(dir, 'mem0-dump.jsonl'), 'utf8')).split('\n')[0]);
  assert.equal(dump.mem0_id, 'm1');
});

test('runDump refuses a workdir inside a git repo tree (privacy guard, spec §6/§2)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mem0repo-'));
  await fs.mkdir(path.join(repo, '.git')); // fake repo-root marker
  const src = path.join(repo, 'source.jsonl');
  await fs.writeFile(src, JSON.stringify({ id: 'm1', memory: 'x' }) + '\n');
  await assert.rejects(
    () => runDump({ source: src, workdir: path.join(repo, '.mem0-import') }),
    /repo tree|refusing/i,
  );
});

test('runJudge writes manifest + review with an injected invoke', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem0imp-'));
  const records = [
    { mem0_id: 'm1', text: 'never read .env' },
    { mem0_id: 'm2', text: 'Current memory is empty' },
  ];
  const invoke = async (_sys, user) => ({
    content: JSON.stringify({
      results: records
        .filter((r) => user.includes(r.mem0_id))
        .map((r) => ({ mem0_id: r.mem0_id, category: r.mem0_id === 'm1' ? 'personal' : 'junk', reason: 'x' })),
    }),
    usage: { tokensIn: 4, tokensOut: 2 },
  });
  const res = await runJudge({ records, workdir: dir, invoke, yes: true });
  assert.equal(res.kept, 1);
  const manifest = await fs.readFile(path.join(dir, 'manifest.jsonl'), 'utf8');
  assert.ok(manifest.includes('"schema_version":1'));
  assert.ok(manifest.includes('m1') && manifest.includes('personal'));
  const review = await fs.readFile(path.join(dir, 'review.md'), 'utf8');
  assert.ok(review.includes('kept 1'));
});

test('runJudge without --yes is a cost-gate no-op (no manifest written)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem0imp-'));
  const res = await runJudge({ records: [{ mem0_id: 'm1', text: 'x' }], workdir: dir, invoke: async () => { throw new Error('should not be called'); }, yes: false });
  assert.equal(res.skipped, true);
  await assert.rejects(() => fs.readFile(path.join(dir, 'manifest.jsonl'), 'utf8'));
});

const fakeMemory = (coll) => ({ config: { vectorStore: { config: { collectionName: coll } } } });
const okRow = { mem0_id: 'a', text: 't', category: 'personal', keep: true, reason: 'r', decided_by: 'judge' };

test('preflight: MEM0_USER_ID unset → hard fail (no test-user fallback)', async () => {
  await assert.rejects(
    () => runApplyPreflights({ env: {}, memory: fakeMemory('memories'), rows: [], readStampFn: async () => null, embedFn: async () => ({}) }),
    /MEM0_USER_ID/,
  );
});

test('preflight: scratch/eval collection target → refused', async () => {
  await assert.rejects(
    () => runApplyPreflights({ env: { MEM0_USER_ID: 'u' }, memory: fakeMemory('eval_mq_x'), rows: [], readStampFn: async () => null, embedFn: async () => ({}) }),
    /scratch|eval_/,
  );
});

test('preflight: embedding-stamp mismatch → abort', async () => {
  const readStampFn = async () => ({ provider: 'openai', model: 'old-model', dim: 1536 });
  const embedFn = async () => ({ provider: 'openai', model: 'new-model', vector: new Array(1536).fill(0) });
  await assert.rejects(
    () => runApplyPreflights({ env: { MEM0_USER_ID: 'u' }, memory: fakeMemory('memories'), rows: [], readStampFn, embedFn }),
    /embedding/i,
  );
});

test('preflight: passes for a matching stamp + valid manifest, returns userId', async () => {
  const readStampFn = async () => ({ provider: 'openai', model: 'm', dim: 2 });
  const embedFn = async () => ({ provider: 'openai', model: 'm', vector: [0, 0] });
  const res = await runApplyPreflights({ env: { MEM0_USER_ID: 'u' }, memory: fakeMemory('memories'), rows: [okRow], readStampFn, embedFn });
  assert.equal(res.userId, 'u');
  assert.equal(res.collection, 'memories');
});

test('preflight: no stamp on a fresh collection is allowed (warn, not abort)', async () => {
  const embedFn = async () => ({ provider: 'openai', model: 'm', vector: [0, 0] });
  const res = await runApplyPreflights({ env: { MEM0_USER_ID: 'u' }, memory: fakeMemory('memories'), rows: [okRow], readStampFn: async () => null, embedFn });
  assert.equal(res.userId, 'u');
});

test('apply write loop: idempotent, lane-tagged, reconciles drops', { skip: LIVE_SKIP }, async () => {
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const { createMemoryInstance } = await import('../../cli/reindex.mjs');
  const collection = `eval_import_${Date.now()}`;
  const env = { ...process.env, QDRANT_COLLECTION: collection, MEM0_USER_ID: 'import-test-user' };
  const memory = await createMemoryInstance({ env, collection });
  const qc = new QdrantClient({ host: QHOST, port: QPORT });
  const userId = 'import-test-user';
  const rows1 = [
    { mem0_id: 'k1', text: 'Golden prefers TDD', category: 'personal', keep: true, reason: 'r', decided_by: 'judge' },
    { mem0_id: 'k2', text: 'edge-catcher repo is private', category: 'dev', keep: true, reason: 'r', decided_by: 'judge' },
    { mem0_id: 'd1', text: 'Date is 2026-04-15', category: 'ephemeral', keep: false, reason: 'r', decided_by: 'judge' },
  ];

  try {
    const r1 = await runApplyWrite({ memory, qc, collection, userId, rows: rows1, importedAt: '2026-06-27T00:00:00Z' });
    assert.equal(r1.written, 2);
    assert.equal(r1.count, 2, 'count == keepers');

    // (a) every kept point has surfaces=['mem0-import'] + a lane key + provenance
    const kept = await qc.scroll(collection, {
      filter: { must: [{ key: 'userId', match: { value: userId } }, { key: 'surfaces', match: { value: 'mem0-import' } }] },
      with_payload: true,
      limit: 50,
    });
    assert.equal(kept.points.length, 2);
    assert.ok(kept.points.every((p) => 'lane' in p.payload), 'imported points carry a lane');
    assert.ok(kept.points.every((p) => p.payload.mem0_id));

    // (b) second apply is a no-op (idempotent) + skip path taken (0 re-writes)
    const r2 = await runApplyWrite({ memory, qc, collection, userId, rows: rows1, importedAt: '2026-06-27T01:00:00Z' });
    assert.equal(r2.count, 2);
    assert.equal(r2.skippedUnchanged, 2, 'unchanged keepers skip embed+write');
    assert.equal(r2.written, 0);

    // (c) flip k2 -> keep:false -> re-apply -> its point is GONE, count == new keeper count
    const rows2 = rows1.map((r) => (r.mem0_id === 'k2' ? { ...r, keep: false, category: 'junk', decided_by: 'user' } : r));
    const r3 = await runApplyWrite({ memory, qc, collection, userId, rows: rows2, importedAt: '2026-06-27T02:00:00Z' });
    assert.equal(r3.count, 1, 'dropped keeper reconciled away');
    const after = await qc.scroll(collection, {
      filter: { must: [{ key: 'userId', match: { value: userId } }, { key: 'mem0_id', match: { value: 'k2' } }] },
      with_payload: true,
      limit: 5,
    });
    assert.equal(after.points.length, 0, 'k2 point deleted on drop');
  } finally {
    await qc.deleteCollection(collection).catch(() => {});
  }
});
