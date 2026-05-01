import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../../lib/provider/errors.mjs';

test('ProviderError carries class, provider, status, retryable', () => {
  const err = new ProviderError({
    class: 'PROVIDER_RATELIMIT',
    provider: 'openai',
    status: 429,
    message: 'rate limited',
    retryable: true,
    cause: new Error('upstream'),
  });
  assert.equal(err.name, 'ProviderError');
  assert.equal(err.class, 'PROVIDER_RATELIMIT');
  assert.equal(err.provider, 'openai');
  assert.equal(err.status, 429);
  assert.equal(err.retryable, true);
  assert.equal(err.message, 'rate limited');
  assert.ok(err.cause instanceof Error);
});

test('ProviderError class enum is enforced', () => {
  assert.throws(() => new ProviderError({ class: 'BOGUS', provider: 'x', message: '' }), /class must be/);
});

test('ProviderError retryable defaults to false when omitted', () => {
  const err = new ProviderError({ class: 'PROVIDER_CONFIG', provider: 'x', message: 'bad config' });
  assert.equal(err.retryable, false);
});

test('ProviderError retryable uses strict === true (truthy non-bool yields false)', () => {
  const err = new ProviderError({ class: 'PROVIDER_CONFIG', provider: 'x', message: '', retryable: 1 });
  assert.equal(err.retryable, false);
});
