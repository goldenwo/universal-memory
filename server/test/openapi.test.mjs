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

import { generateOpenAPISpec, generateCustomGPTActionsSpec } from '../openapi.mjs';

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

// ---------------------------------------------------------------------------
// 4. Custom GPT Actions (trimmed) spec — Phase D Task D2
// ---------------------------------------------------------------------------

test('custom GPT actions spec is valid 3.1', async () => {
  const yamlText = generateCustomGPTActionsSpec();
  assert.equal(typeof yamlText, 'string', 'generateCustomGPTActionsSpec() must return a string');
  assert.ok(yamlText.length > 0, 'trimmed spec must not be empty');

  const parsed = YAML.parse(yamlText);
  assert.equal(parsed.openapi, '3.1.0', 'openapi version must be 3.1.0');

  const toValidate = JSON.parse(JSON.stringify(parsed));
  await SwaggerParser.validate(toValidate);
});

test('custom GPT actions spec includes only the 4 trimmed routes with operationIds', () => {
  const yamlText = generateCustomGPTActionsSpec();
  const parsed = YAML.parse(yamlText);

  // Exactly these 4 paths — no more, no less.
  const expectedPaths = new Set([
    '/api/search',
    '/api/state/{project}',
    '/api/add',
    '/api/delete',
  ]);
  const actualPaths = new Set(Object.keys(parsed.paths || {}));
  assert.deepEqual(actualPaths, expectedPaths, 'trimmed spec paths mismatch');

  // Each kept operation must carry the Custom-GPT-ready operationId.
  // Custom GPT surfaces operationId as the tool name to the model, so these
  // have to exactly match the names the Instructions / rubric reference.
  assert.equal(parsed.paths['/api/search'].post.operationId, 'memory_search');
  assert.equal(parsed.paths['/api/state/{project}'].get.operationId, 'memory_state');
  assert.equal(parsed.paths['/api/add'].post.operationId, 'memory_add');
  assert.equal(parsed.paths['/api/delete'].post.operationId, 'memory_delete');

  // The GET form of /api/search must be absent — Custom GPT only gets the
  // POST form (which supports filters.project).
  assert.equal(parsed.paths['/api/search'].get, undefined, 'GET /api/search must be stripped');

  // 5xx responses must be stripped from every kept operation — Custom GPT
  // Actions validators flag server-error schemas on many operation shapes.
  for (const [pathKey, methods] of Object.entries(parsed.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      for (const code of Object.keys(op.responses || {})) {
        assert.ok(
          !/^5\d\d$/.test(code),
          `trimmed spec: ${method.toUpperCase()} ${pathKey} must not contain ${code} response`
        );
      }
    }
  }

  // Schemas must be pruned — none of the MCP-only or reindex-only schemas
  // should leak into the trimmed spec.
  const schemaNames = Object.keys(parsed.components?.schemas || {});
  for (const forbidden of [
    'JsonRpcRequest',
    'JsonRpcResponse',
    'ReindexRequest',
    'ReindexResponse',
    'HealthResponse',
    'DeleteByUuidResponse',
    'McpWriteGatedResponse',
  ]) {
    assert.ok(
      !schemaNames.includes(forbidden),
      `trimmed spec leaks unused schema: ${forbidden}`
    );
  }

  // But the schemas the kept paths actually reference must survive.
  for (const required of [
    'ErrorResponse',
    'SearchRequest',
    'SearchResponse',
    'SearchFilters',
    'MemoryResult',
    'MemoryMetadata',
    'AddRequest',
    'AddResponse',
    'StateResponse',
    'DeleteRequest',
    'DeleteResponse',
  ]) {
    assert.ok(
      schemaNames.includes(required),
      `trimmed spec missing required schema: ${required}`
    );
  }
});
