// server/test/de-leak.test.mjs — pins the harvested deLeak n-gram guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deLeak } from '../eval/de-leak.mjs';

test('deLeak: clean when no shared trigram', () => {
  const r = deLeak('what is my blood type', ['I drive a red Tesla', 'my cat is named Mochi']);
  assert.equal(r.clean, true);
  assert.deepEqual(r.shared, []);
});

test('deLeak: flags a shared >=3-gram', () => {
  const r = deLeak('where did I park my car today', ['I park my car in the north garage']);
  assert.equal(r.clean, false);
  assert.ok(r.shared.includes('park my car'));
});

test('deLeak: strings shorter than n tokens → clean (no grams)', () => {
  assert.deepEqual(deLeak('hi there', ['hi there friend']), { clean: true, shared: [] });
});
