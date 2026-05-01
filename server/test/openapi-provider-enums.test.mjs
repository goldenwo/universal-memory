/**
 * Drift-detection test for OpenAPI provider enums (spec §3.1 #5).
 *
 * The OpenAPI doc's provider enums (EmbeddingProvider, SummarizerProvider,
 * FactsProvider) MUST derive from `lib/provider/registry.mjs` — never
 * hand-maintained. If someone adds a new provider to the registry, the enums
 * pick it up automatically. If someone hardcodes an enum in openapi.mjs, this
 * test fails on drift.
 *
 * Run with: node --test server/test/openapi-provider-enums.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSpec } from '../openapi.mjs';
import { providers, supportingProviders } from '../lib/provider/registry.mjs';

test('OpenAPI EmbeddingProvider enum derives from registry (no drift)', () => {
  const doc = buildSpec();
  const embedEnum = doc.components.schemas.EmbeddingProvider.enum;
  assert.deepEqual(
    [...embedEnum].sort(),
    supportingProviders('embeddings').sort(),
    'EmbeddingProvider.enum must match supportingProviders("embeddings")',
  );
});

test('OpenAPI SummarizerProvider enum derives from registry (no drift)', () => {
  const doc = buildSpec();
  const summEnum = doc.components.schemas.SummarizerProvider.enum;
  assert.deepEqual(
    [...summEnum].sort(),
    supportingProviders('summarizer').sort(),
    'SummarizerProvider.enum must match supportingProviders("summarizer")',
  );
});

test('OpenAPI FactsProvider enum derives from registry (no drift)', () => {
  const doc = buildSpec();
  const factsEnum = doc.components.schemas.FactsProvider.enum;
  assert.deepEqual(
    [...factsEnum].sort(),
    supportingProviders('facts').sort(),
    'FactsProvider.enum must match supportingProviders("facts")',
  );
});

test('OpenAPI provider enums are non-empty (registry must be populated)', () => {
  const doc = buildSpec();
  // Sanity floor — without this, an empty registry would silently pass the
  // deepEqual checks above (both sides empty arrays). Catch that mode here.
  assert.ok(
    doc.components.schemas.EmbeddingProvider.enum.length > 0,
    'EmbeddingProvider.enum must be non-empty',
  );
  assert.ok(
    doc.components.schemas.SummarizerProvider.enum.length > 0,
    'SummarizerProvider.enum must be non-empty',
  );
  assert.ok(
    doc.components.schemas.FactsProvider.enum.length > 0,
    'FactsProvider.enum must be non-empty',
  );
  // And the registry itself must not be empty either.
  assert.ok(Object.keys(providers).length > 0, 'registry must have at least one provider');
});

test('OpenAPI provider enums match expected v0.7 shape', () => {
  // Regression guard: if the registry composition changes (e.g. anthropic
  // gains an embeddings API), this assertion documents the v0.7 baseline so
  // the change shows up in a diff rather than silently flowing through.
  const doc = buildSpec();
  assert.deepEqual(
    [...doc.components.schemas.EmbeddingProvider.enum].sort(),
    ['google', 'ollama', 'openai'],
    'v0.7 baseline: embeddings = google + ollama + openai (anthropic excluded)',
  );
  assert.deepEqual(
    [...doc.components.schemas.SummarizerProvider.enum].sort(),
    ['anthropic', 'google', 'ollama', 'openai'],
    'v0.7 baseline: summarizer = all four providers',
  );
  assert.deepEqual(
    [...doc.components.schemas.FactsProvider.enum].sort(),
    ['anthropic', 'google', 'ollama', 'openai'],
    'v0.7 baseline: facts = all four providers',
  );
});
