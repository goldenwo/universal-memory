import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSummarizerConfig } from '../lib/startup-validation.mjs';

test('info-log when summarizer fallback is cross-provider', () => {
  const logs = [];
  const log = { info: (obj, msg) => logs.push({ obj, msg }) };
  validateSummarizerConfig({ UM_SUMMARIZER_PROVIDER: 'anthropic', UM_SUMMARIZER_FALLBACK: 'openai' }, log);
  assert.ok(logs.some(l => (l.msg || JSON.stringify(l.obj)).includes('cross-provider')));
});

test('no info log when fallback empty', () => {
  const logs = [];
  const log = { info: (obj, msg) => logs.push({ obj, msg }) };
  validateSummarizerConfig({ UM_SUMMARIZER_PROVIDER: 'openai' }, log);
  assert.equal(logs.length, 0);
});

test('no info log when fallback matches primary (same provider)', () => {
  const logs = [];
  const log = { info: (obj, msg) => logs.push({ obj, msg }) };
  validateSummarizerConfig({ UM_SUMMARIZER_PROVIDER: 'openai', UM_SUMMARIZER_FALLBACK: 'openai' }, log);
  assert.equal(logs.length, 0);
});
