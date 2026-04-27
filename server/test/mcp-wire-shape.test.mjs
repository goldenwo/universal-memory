/**
 * HTTP wire-shape integration test for the MCP memory_search tool.
 *
 * Companion to api-list-wire-shape.test.mjs (REST coverage). Closes the
 * final sweep site from the Phase A review — before this test, MCP
 * memory_search was the only list-shape surface that re-wrapped
 * `listEnvelope(items)` without forwarding the upstream extras, silently
 * dropping §4.1 siblings (e.g., `provider`, `latency_ms`) on the wire.
 *
 * Contract pinned:
 *   1. The MCP tool reply is a JSON-RPC `tools/call` response whose
 *      `result.content[0].text` is a JSON string.
 *   2. That JSON string parses to a §4.1 list envelope: `{ results: [...],
 *      ...siblings }`.
 *   3. Additive siblings on the memory-client envelope propagate through
 *      doSearch → handleToolCall → `/mcp` POST → the JSON text block.
 *
 * Mirrors the DI pattern used by api-list-wire-shape.test.mjs: a stub
 * memory client is injected via `createRequestHandler({ memory })`, which
 * now also threads ctx through to handleMcpMessage → handleToolCall →
 * doSearch so the stub is honored on the MCP code path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// Test harness — ephemeral-port server per test, ctx.memory injected.
// Same pattern as api-list-wire-shape.test.mjs for consistency.
// ---------------------------------------------------------------------------

async function startServer(ctx) {
  const handler = createRequestHandler(ctx);
  const srv = createServer(handler);
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// 1. MCP memory_search returns a §4.1 envelope inside a text content block.
//
// Exercises the JSON-RPC → text content block → inner JSON path end-to-end.
// Without the line-463 fix, the inner JSON would be a fresh envelope with
// no siblings; with the fix, upstream extras survive.
// ---------------------------------------------------------------------------
test('MCP tools/call memory_search returns §4.1 envelope with siblings in text content block', async () => {
  const fakeMemory = {
    search: async (_query, _opts) => ({
      results: [
        {
          id: 'mem0-uuid-1',
          memory: 'the quick brown fox',
          metadata: { id: 'mcp-search-doc-1', title: 'MCP Search Doc One' },
          score: 0.91,
        },
      ],
      provider: 'mem0',
      latency_ms: 42,
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'test', limit: 5 } },
      }),
    });
    assert.equal(res.status, 200, 'HTTP status must be 200');
    assert.equal(res.headers.get('content-type'), 'application/json');

    // JSON-RPC envelope — the transport wrapper.
    const rpcResponse = JSON.parse(await res.text());
    assert.equal(rpcResponse.jsonrpc, '2.0');
    assert.equal(rpcResponse.id, 1);
    assert.ok(rpcResponse.result, 'rpc result must be present');
    assert.ok(Array.isArray(rpcResponse.result.content), 'result.content must be an array');
    assert.equal(rpcResponse.result.content.length, 1);
    assert.equal(rpcResponse.result.content[0].type, 'text', 'content block must be type=text per MCP spec');
    assert.ok(!rpcResponse.result.isError, 'must not be an error response');

    // Inner JSON — the §4.1 envelope lives inside the text block.
    const text = rpcResponse.result.content[0].text;
    assert.equal(typeof text, 'string');
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed, 'object', 'inner payload must be a JSON object');
    assert.ok(!Array.isArray(parsed), 'inner payload must not be a bare array');
    assert.ok(Array.isArray(parsed.results), 'parsed.results must be an array (envelope shape)');
    assert.equal(parsed.results.length, 1, 'one matching doc from the stub');

    // Compact projection: MCP default is full=false so items are { id, title, score, snippet }.
    const first = parsed.results[0];
    assert.equal(first.id, 'mcp-search-doc-1');
    assert.equal(first.title, 'MCP Search Doc One');
    assert.ok('score' in first);
    assert.ok(typeof first.snippet === 'string' && first.snippet.length > 0);

    // Load-bearing: siblings must propagate through the MCP surface.
    // Before the fix, these assertions failed because listEnvelope(items)
    // was called without responseExtras, producing a fresh envelope.
    assert.equal(parsed.provider, 'mem0', 'provider sibling must propagate through MCP memory_search');
    assert.equal(parsed.latency_ms, 42, 'latency_ms sibling must propagate through MCP memory_search');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 2. MCP memory_search with full=true also propagates siblings.
//
// Covers the second return path through handleToolCall — when the client
// requests full bodies (clientFull=true), the compact-projection step is
// skipped but the final listEnvelope() still runs. Both paths must
// preserve the upstream extras.
// ---------------------------------------------------------------------------
test('MCP tools/call memory_search with full=true preserves siblings through the full-shape path', async () => {
  const fakeMemory = {
    search: async (_query, _opts) => ({
      results: [
        {
          id: 'mem0-uuid-2',
          memory: 'full-shape body content',
          metadata: { id: 'mcp-full-doc-1', title: 'MCP Full Doc One' },
          score: 0.75,
        },
      ],
      provider: 'mem0',
      latency_ms: 7,
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'test', limit: 5, full: true } },
      }),
    });
    assert.equal(res.status, 200);
    const rpcResponse = JSON.parse(await res.text());
    const parsed = JSON.parse(rpcResponse.result.content[0].text);
    assert.ok(Array.isArray(parsed.results));
    assert.equal(parsed.results.length, 1);
    // Full shape: body preserved (compact projection skipped).
    const first = parsed.results[0];
    assert.equal(first.id, 'mcp-full-doc-1');
    assert.equal(first.body, 'full-shape body content', 'full=true must preserve raw memory as body');
    // Siblings survive the full-shape path as well.
    assert.equal(parsed.provider, 'mem0');
    assert.equal(parsed.latency_ms, 7);
  } finally {
    await close();
  }
});
