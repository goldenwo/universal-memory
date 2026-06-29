import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runDump } from '../mem0-import.mjs';

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
