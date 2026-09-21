/**
 * Drift gate for plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml.
 *
 * The checked-in YAML file must always match the output of
 * generateCustomGPTActionsSpec() byte-for-byte. If this test fails, regenerate:
 *
 *   cd server && node -e "
 *     import('./openapi.mjs').then(m => {
 *       process.stdout.write(m.generateCustomGPTActionsSpec());
 *     });
 *   " > ../plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml
 *
 * Run with: node --test server/test/custom-gpt-actions.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateCustomGPTActionsSpec, buildSpec } from '../openapi.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTIONS_YAML = resolve(__dirname, '../../plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml');

test('actions-trimmed.yaml matches generator output byte-for-byte', () => {
  const checkedIn = readFileSync(ACTIONS_YAML, 'utf8');
  const generated = generateCustomGPTActionsSpec();
  assert.strictEqual(checkedIn, generated, 'actions-trimmed.yaml drift — regenerate via openapi.mjs');
});

test('GET /api/recent/{project} is present in the Custom-GPT spec (?gpt=1 equivalent)', () => {
  const spec = generateCustomGPTActionsSpec();
  assert.match(spec, /\/api\/recent\/\{project\}/, 'new recent endpoint missing from Custom-GPT spec');
});

test('POST /api/append-turn (memory_append_turn) is present in the Custom-GPT spec', () => {
  const spec = generateCustomGPTActionsSpec();
  assert.match(spec, /\/api\/append-turn/, '/api/append-turn missing from Custom-GPT spec');
  assert.match(spec, /memory_append_turn/, 'memory_append_turn operationId missing from Custom-GPT spec');
});

test('POST /api/checkpoint (memory_checkpoint) is present in the Custom-GPT spec', () => {
  const spec = generateCustomGPTActionsSpec();
  assert.match(spec, /\/api\/checkpoint/, '/api/checkpoint missing from Custom-GPT spec');
  assert.match(spec, /memory_checkpoint/, 'memory_checkpoint operationId missing from Custom-GPT spec');
});

// ---------------------------------------------------------------------------
// #309 T4: accepted mode is stripped from the GPT mirror.
//
// The drift gate above already pins this indirectly — a leaked `mode` would
// change the file and fail it — but that failure would read as "regenerate the
// mirror", which is the WRONG remedy here. These assert the property directly,
// and each carries a POSITIVE CONTROL against the full spec so it cannot pass
// by the flag having vanished everywhere.
// ---------------------------------------------------------------------------

test('#309: `mode` is absent from the Custom-GPT mirror but PRESENT in the full spec', () => {
  const gpt = generateCustomGPTActionsSpec();
  assert.doesNotMatch(gpt, /^\s+mode:/m,
    'accepted mode must never be offered to a Custom GPT — an LLM picking it at runtime would read the empty 202 as a completed checkpoint');
  // Positive control: the strip must be GPT-only, not a global deletion.
  const full = JSON.stringify(buildSpec());
  assert.ok(full.includes('"mode"'),
    'positive control failed — `mode` is missing from the FULL spec too, so the negative assertion above proves nothing');
});

test('#309: the 202 response is absent from the Custom-GPT mirror but PRESENT in the full spec', () => {
  const gpt = generateCustomGPTActionsSpec();
  assert.doesNotMatch(gpt, /^\s+202:/m,
    'a 202 whose only trigger was stripped is incoherent, and invites the model to narrate acceptance as completion');
  const fullCheckpoint = buildSpec().paths['/api/checkpoint'].post.responses;
  assert.ok(fullCheckpoint[202],
    'positive control failed — the full spec has no 202 either, so the negative assertion above proves nothing');
});
