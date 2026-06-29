import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runDump, runJudge, runApplyPreflights } from '../mem0-import.mjs';

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
