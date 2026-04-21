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
import { generateCustomGPTActionsSpec } from '../openapi.mjs';

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
