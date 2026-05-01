import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSummarizerConfig } from '../lib/startup-validation.mjs';

function makeLog() {
  const entries = [];
  return {
    log: {
      info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
    },
    entries,
  };
}

test('info-log when summarizer fallback is cross-provider', () => {
  const { log, entries } = makeLog();
  validateSummarizerConfig({ UM_SUMMARIZER_PROVIDER: 'anthropic', UM_SUMMARIZER_FALLBACK: 'openai' }, log);
  assert.ok(entries.some(l => l.level === 'info' && (l.msg || '').includes('cross-provider')));
});

test('no info log when fallback empty', () => {
  const { log, entries } = makeLog();
  validateSummarizerConfig({ UM_SUMMARIZER_PROVIDER: 'openai' }, log);
  assert.equal(entries.length, 0);
});

test('no info log when fallback matches primary (same provider)', () => {
  const { log, entries } = makeLog();
  validateSummarizerConfig({ UM_SUMMARIZER_PROVIDER: 'openai', UM_SUMMARIZER_FALLBACK: 'openai' }, log);
  assert.equal(entries.length, 0);
});

test('deprecation warn when only legacy UM_SUMMARIZER is set', () => {
  const { log, entries } = makeLog();
  validateSummarizerConfig({ UM_SUMMARIZER: 'anthropic' }, log);
  const warn = entries.find(l => l.level === 'warn');
  assert.ok(warn, 'expected a warn entry');
  assert.ok((warn.msg || '').includes('v0.6'), `expected v0.6 in message, got: ${warn.msg}`);
  assert.equal(warn.obj?.legacy, 'UM_SUMMARIZER');
});

test('conflict warn when both UM_SUMMARIZER and UM_SUMMARIZER_PROVIDER set with different values', () => {
  const { log, entries } = makeLog();
  validateSummarizerConfig({ UM_SUMMARIZER: 'openai', UM_SUMMARIZER_PROVIDER: 'anthropic' }, log);
  const warn = entries.find(l => l.level === 'warn');
  assert.ok(warn, 'expected a warn entry');
  assert.ok((warn.msg || '').includes('Conflict'), `expected Conflict in message, got: ${warn.msg}`);
  assert.equal(warn.obj?.legacy, 'openai');
  assert.equal(warn.obj?.current, 'anthropic');
});
