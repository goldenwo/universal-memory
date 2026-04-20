/**
 * Tests for server/openapi.mjs — OpenAPI 3.1 spec generator.
 *
 * Run with: node --test server/test/openapi.test.mjs
 *
 * These tests assert that:
 *   1. The generated spec is a valid OpenAPI 3.1 document (structurally
 *      and referentially) by round-tripping through @apidevtools/swagger-parser.
 *   2. Every HTTP route exposed by server/mem0-mcp-http.mjs is represented
 *      in the spec's `paths` section.
 *
 * If this test fails after you change the runtime, the spec has drifted from
 * the runtime — fix the spec, not the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import YAML from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';

import { generateOpenAPISpec } from '../openapi.mjs';

// ---------------------------------------------------------------------------
// 1. Structural + referential validity (OpenAPI 3.1)
// ---------------------------------------------------------------------------

test('openapi spec is valid 3.1', async () => {
  const yamlText = generateOpenAPISpec();
  assert.equal(typeof yamlText, 'string', 'generateOpenAPISpec() must return a string');
  assert.ok(yamlText.length > 0, 'spec must not be empty');

  const parsed = YAML.parse(yamlText);
  assert.equal(parsed.openapi, '3.1.0', 'openapi version must be 3.1.0');

  // SwaggerParser mutates its input while dereferencing; pass a copy so the
  // test can still inspect the original structure if needed.
  const toValidate = JSON.parse(JSON.stringify(parsed));
  await SwaggerParser.validate(toValidate);
});

// ---------------------------------------------------------------------------
// 2. All runtime routes are represented in the spec
// ---------------------------------------------------------------------------

test('openapi spec includes all expected routes', () => {
  const yamlText = generateOpenAPISpec();
  const parsed = YAML.parse(yamlText);

  const expectedPaths = [
    '/health',
    '/mcp',
    '/api/search',
    '/api/add',
    '/api/list',
    '/api/reindex',
    '/api/state/{project}',
    '/api/delete',
    '/api/{id}',
    '/openapi.yaml',
  ];

  for (const p of expectedPaths) {
    assert.ok(
      parsed.paths && parsed.paths[p],
      `spec is missing path: ${p}`
    );
  }

  // Spot-check a few expected methods
  assert.ok(parsed.paths['/api/search'].post, '/api/search must support POST');
  assert.ok(parsed.paths['/api/search'].get, '/api/search must support GET');
  assert.ok(parsed.paths['/api/delete'].post, '/api/delete must support POST');
  assert.ok(parsed.paths['/api/{id}'].delete, '/api/{id} must support DELETE');
  assert.ok(parsed.paths['/mcp'].post, '/mcp must support POST');
  assert.ok(parsed.paths['/openapi.yaml'].get, '/openapi.yaml must support GET');
});

// ---------------------------------------------------------------------------
// 3. Components — shared ErrorResponse schema
// ---------------------------------------------------------------------------

test('openapi spec defines a reusable ErrorResponse schema', () => {
  const yamlText = generateOpenAPISpec();
  const parsed = YAML.parse(yamlText);

  assert.ok(parsed.components?.schemas?.ErrorResponse, 'components.schemas.ErrorResponse missing');
  const err = parsed.components.schemas.ErrorResponse;
  assert.equal(err.type, 'object');
  assert.ok(err.properties?.error, 'ErrorResponse must have an `error` property');
});
