#!/usr/bin/env node
// server/eval/lib/positive-control-seed.mjs — #297 plan T6 step 2 helper (LOCAL RIG ONLY).
//
// Seeds N dated, recallable points into the rig's collection under the rig's MEM0_USER_ID so a
// server booted with UM_TEMPORAL_DECAY=true can reach `mode: relative` (≥ UNDATED_MIN_COHORT
// dated points — spec §10 / plan T6 step 2), or removes them again (`--cleanup`). Every point
// carries metadata.project = '297-positive-control' so the cleanup is a filter, never a guess.
//
//   node --env-file=.env eval/lib/positive-control-seed.mjs --yes [--count 24]   # seed N points, ages 1..N d
//   node --env-file=.env eval/lib/positive-control-seed.mjs --cleanup            # delete them
//
// Refuses to run against anything that is not loopback qdrant — this is a verification-rig tool —
// and refuses to SEED without an explicit --yes, printing the resolved target first (code review
// 2026-09-04: it writes recallable dated points into whatever collection/userId the env names).

import { QdrantClient } from '@qdrant/js-client-rest';
import { Memory } from 'mem0ai/oss';
import { wrapMem0Read } from '../../lib/mem0-read.mjs';
import { umAdd } from '../../lib/add.mjs';
import { getEmbedderConfig } from '../../lib/embed.mjs';
import { getFactsLlmConfig } from '../../lib/facts.mjs';

const PROJECT = '297-positive-control';
const host = process.env.QDRANT_HOST ?? 'localhost';
const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
const collection = process.env.QDRANT_COLLECTION || 'memories';
const userId = process.env.MEM0_USER_ID;
if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`refusing: QDRANT_HOST=${host} is not loopback`);
if (!userId) throw new Error('MEM0_USER_ID is required');

const client = new QdrantClient({ host, port, checkCompatibility: false });
const filter = { must: [{ key: 'project', match: { value: PROJECT } }, { key: 'userId', match: { value: userId } }] };

if (process.argv.includes('--cleanup')) {
  const before = await client.count(collection, { filter, exact: true });
  await client.delete(collection, { wait: true, filter });
  const after = await client.count(collection, { filter, exact: true });
  console.log(JSON.stringify({ cleanup: true, removed: before.count - after.count, remaining: after.count }));
  process.exit(0);
}

const argv = process.argv.slice(2);
const countIdx = argv.indexOf('--count');
const count = countIdx >= 0 ? parseInt(argv[countIdx + 1], 10) : 24;
if (!Number.isInteger(count) || count <= 0) throw new Error(`--count needs a positive integer, got '${argv[countIdx + 1]}'`);
console.log(JSON.stringify({ target: { host, port, collection, userId, count, project: PROJECT } }));
if (!argv.includes('--yes')) {
  console.error('refusing to seed without --yes (this writes recallable dated points into the collection above)');
  process.exit(2);
}
const memory = wrapMem0Read(new Memory({
  embedder: getEmbedderConfig(process.env),
  llm: getFactsLlmConfig(process.env),
  vectorStore: { provider: 'qdrant', config: { host, port, collectionName: collection } },
}));
const now = Date.now();
let stored = 0;
for (let i = 1; i <= count; i++) {
  const validFrom = new Date(now - i * 86400000).toISOString();
  const res = await umAdd({
    memory, userId, infer: false, surface: 'eval',
    text: `297 positive-control point ${i}: the ${i}-day-old dated marker for the relative-imputation rig boot (${validFrom})`,
    metadata: { project: PROJECT, type: 'fact', valid_from: validFrom },
    _qdrantClient: client,
  });
  const ev = res?.results?.[0]?.event;
  if (ev === 'ADD') stored++;
}
const total = await client.count(collection, { filter, exact: true });
console.log(JSON.stringify({ seeded: stored, requested: count, presentWithMarker: total.count, userId, collection }));
