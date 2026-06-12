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

import { generateOpenAPISpec, generateCustomGPTActionsSpec, capDescriptions } from '../openapi.mjs';

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
    '/api/recent/{project}',
    '/api/append-turn',
    '/api/checkpoint',
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

test('custom GPT actions spec includes only the 7 trimmed routes with operationIds', () => {
  const yamlText = generateCustomGPTActionsSpec();
  const parsed = YAML.parse(yamlText);

  // Exactly these 7 paths — no more, no less.
  const expectedPaths = new Set([
    '/api/search',
    '/api/state/{project}',
    '/api/add',
    '/api/delete',
    '/api/recent/{project}',
    '/api/append-turn',
    '/api/checkpoint',
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
  assert.equal(parsed.paths['/api/recent/{project}'].get.operationId, 'memory_recent');
  assert.equal(parsed.paths['/api/append-turn'].post.operationId, 'memory_append_turn');
  assert.equal(parsed.paths['/api/checkpoint'].post.operationId, 'memory_checkpoint');

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
    'CompactMemoryResult',
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

// ---------------------------------------------------------------------------
// 5. Phase-0 defect fixes (Gap-3 OAuth PR-1)
// ---------------------------------------------------------------------------

// 5a. servers[0].url derives from UM_PUBLIC_BASE_URL (full spec)
test('full spec servers[0].url uses UM_PUBLIC_BASE_URL when set', () => {
  const saved = process.env.UM_PUBLIC_BASE_URL;

  // With env set — trailing slash stripped
  process.env.UM_PUBLIC_BASE_URL = 'https://um.example.ts.net/';
  const yamlWithSlash = generateOpenAPISpec();
  const parsedWithSlash = YAML.parse(yamlWithSlash);
  assert.equal(
    parsedWithSlash.servers[0].url,
    'https://um.example.ts.net',
    'trailing slash must be stripped from UM_PUBLIC_BASE_URL'
  );

  // Without trailing slash
  process.env.UM_PUBLIC_BASE_URL = 'https://um.example.ts.net';
  const yamlNoSlash = generateOpenAPISpec();
  const parsedNoSlash = YAML.parse(yamlNoSlash);
  assert.equal(
    parsedNoSlash.servers[0].url,
    'https://um.example.ts.net',
    'servers[0].url must equal UM_PUBLIC_BASE_URL'
  );

  // Without env set — must fall back to localhost
  delete process.env.UM_PUBLIC_BASE_URL;
  const yamlFallback = generateOpenAPISpec();
  const parsedFallback = YAML.parse(yamlFallback);
  assert.equal(
    parsedFallback.servers[0].url,
    'http://localhost:6335',
    'servers[0].url must fall back to localhost when UM_PUBLIC_BASE_URL is unset'
  );

  // Restore
  if (saved !== undefined) process.env.UM_PUBLIC_BASE_URL = saved;
  else delete process.env.UM_PUBLIC_BASE_URL;
});

// 5b. GPT spec: NO description string exceeds 300 chars (ChatGPT hard limit)
test('custom GPT actions spec: all description strings are ≤300 chars', () => {
  const yamlText = generateCustomGPTActionsSpec();
  const parsed = YAML.parse(yamlText);

  const violations = [];
  function walkDescriptions(obj, path) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walkDescriptions(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'description' && typeof v === 'string' && v.length > 300) {
        violations.push({ path: `${path}.${k}`, length: v.length, excerpt: v.slice(0, 60) });
      }
      walkDescriptions(v, `${path}.${k}`);
    }
  }
  walkDescriptions(parsed, 'gpt');

  assert.deepEqual(
    violations,
    [],
    `GPT spec has description(s) exceeding 300 chars:\n${violations.map(v => `  ${v.path} (${v.length}): "${v.excerpt}..."`).join('\n')}`
  );
});

// 5b-2. capDescriptions() throws on un-curated descriptions >300 chars (fail-loud enforcement)
test('capDescriptions() throws for un-curated descriptions exceeding 300 chars', () => {
  // Construct a minimal doc with a description that is exactly 301 chars — must throw.
  const longDesc = 'x'.repeat(301);
  const doc = {
    paths: {
      '/api/test': {
        post: {
          description: longDesc,
          responses: {},
        },
      },
    },
  };

  assert.throws(
    () => capDescriptions(doc),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error instance');
      assert.ok(
        err.message.includes('300-char limit'),
        `error message must mention "300-char limit"; got: ${err.message}`
      );
      assert.ok(
        err.message.includes('301 chars'),
        `error message must report the actual length (301 chars); got: ${err.message}`
      );
      assert.ok(
        err.message.includes('GPT_DESCRIPTION_OVERRIDES'),
        `error message must direct the author to GPT_DESCRIPTION_OVERRIDES; got: ${err.message}`
      );
      return true;
    },
    'capDescriptions() must throw when an un-curated description exceeds 300 chars'
  );

  // A description of exactly 300 chars must NOT throw.
  const borderDesc = 'y'.repeat(300);
  const safeDoc = { description: borderDesc };
  assert.doesNotThrow(
    () => capDescriptions(safeDoc),
    'capDescriptions() must not throw for descriptions of exactly 300 chars'
  );
});

// 5c. GPT spec delete operation body schema has type:'object' (no bare oneOf)
test('custom GPT actions spec: delete body schema has top-level type:object', () => {
  const yamlText = generateCustomGPTActionsSpec();
  const parsed = YAML.parse(yamlText);

  // Resolve inline — the body may use $ref to DeleteRequest or be inlined
  const deletePost = parsed.paths['/api/delete']?.post;
  assert.ok(deletePost, '/api/delete POST must exist in trimmed spec');

  let bodySchema = deletePost.requestBody?.content?.['application/json']?.schema;
  assert.ok(bodySchema, 'delete POST must have a requestBody application/json schema');

  // If it's a $ref, resolve it from components
  if (bodySchema.$ref) {
    const refName = bodySchema.$ref.replace('#/components/schemas/', '');
    bodySchema = parsed.components?.schemas?.[refName];
    assert.ok(bodySchema, `$ref schema '${refName}' must exist in trimmed components`);
  }

  assert.equal(
    bodySchema.type,
    'object',
    'delete body schema must have top-level type:"object" (not a bare oneOf) for ChatGPT validator'
  );
  assert.ok(
    bodySchema.properties && typeof bodySchema.properties === 'object',
    'delete body schema must have a properties object'
  );
  // Union of both variants: metadata (from DeleteByMetadataId) + id (from DeleteByUuid)
  assert.ok(
    'metadata' in bodySchema.properties,
    'delete body schema properties must include "metadata" (from DeleteByMetadataId variant)'
  );
  assert.ok(
    'id' in bodySchema.properties,
    'delete body schema properties must include "id" (from DeleteByUuid variant)'
  );
});
