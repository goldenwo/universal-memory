/**
 * Unit tests for server/lib/jsonrpc-errors.mjs (Task B.13).
 *
 * Pins:
 *   - Every stable error code from lib/error-envelope.mjs has a numeric mapping.
 *   - Numeric codes live inside the JSON-RPC 2.0 server-error band
 *     (-32000 to -32099) OR are one of the two standard reuses
 *     (-32602 invalid params, -32603 internal error).
 *   - toJsonRpcError() produces a well-formed JSON-RPC error object that
 *     preserves the inner envelope's stable_code + retryable in `data`.
 *   - Unknown / malformed envelopes degrade to -32603 instead of throwing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSONRPC_CODE_MAP, toJsonRpcError } from '../lib/jsonrpc-errors.mjs';
import { ERROR_CODES, errorResponse } from '../lib/error-envelope.mjs';

test('JSONRPC_CODE_MAP covers every stable code in ERROR_CODES (no orphans)', () => {
  for (const code of Object.keys(ERROR_CODES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(JSONRPC_CODE_MAP, code),
      `JSONRPC_CODE_MAP missing entry for stable code ${code}`,
    );
  }
});

test('JSONRPC_CODE_MAP values live in -32xxx range (server-error band or std reuse)', () => {
  for (const [code, num] of Object.entries(JSONRPC_CODE_MAP)) {
    assert.ok(
      num <= -32000 && num >= -32999,
      `${code} → ${num} is outside JSON-RPC server-error band (-32000..-32999)`,
    );
  }
});

test('JSONRPC_CODE_MAP reuses standard JSON-RPC codes for INPUT_INVALID and SERVER_INTERNAL', () => {
  // -32602 = "Invalid params" (standard). INPUT_INVALID is our caller-shape code.
  // -32603 = "Internal error" (standard). SERVER_INTERNAL is our unhandled-exception code.
  // The spec REUSE keeps generic JSON-RPC clients (no awareness of our string codes)
  // working correctly — they'll display the standard meaning.
  assert.equal(JSONRPC_CODE_MAP.INPUT_INVALID, -32602);
  assert.equal(JSONRPC_CODE_MAP.SERVER_INTERNAL, -32603);
});

test('toJsonRpcError translates a unified envelope to a JSON-RPC error object', () => {
  const envelope = errorResponse('STATE_NOT_FOUND', 'doc not in vault');
  const rpcErr = toJsonRpcError(envelope);
  assert.equal(rpcErr.code, JSONRPC_CODE_MAP.STATE_NOT_FOUND);
  assert.equal(rpcErr.message, 'doc not in vault');
  assert.equal(rpcErr.data.stable_code, 'STATE_NOT_FOUND');
  assert.equal(rpcErr.data.retryable, false);
});

test('toJsonRpcError preserves retryable=true for retryable codes (UPSTREAM_FAILURE)', () => {
  const envelope = errorResponse('UPSTREAM_FAILURE', 'qdrant down');
  const rpcErr = toJsonRpcError(envelope);
  assert.equal(rpcErr.code, JSONRPC_CODE_MAP.UPSTREAM_FAILURE);
  assert.equal(rpcErr.data.retryable, true);
});

test('toJsonRpcError falls back to -32603 (internal error) for unknown stable codes', () => {
  const fakeEnvelope = { ok: false, error: { code: 'TOTALLY_UNKNOWN_CODE', message: 'oops' } };
  const rpcErr = toJsonRpcError(fakeEnvelope);
  assert.equal(rpcErr.code, -32603, 'unknown stable code must degrade to internal error, not throw');
  assert.equal(rpcErr.message, 'oops');
  assert.equal(rpcErr.data.stable_code, 'TOTALLY_UNKNOWN_CODE');
});

test('toJsonRpcError handles null/missing envelope shape gracefully (no crash)', () => {
  const rpcErr = toJsonRpcError(null);
  assert.equal(rpcErr.code, -32603);
  assert.equal(rpcErr.message, 'unknown error');
  assert.equal(rpcErr.data.stable_code, undefined);
});

test('toJsonRpcError handles envelope with empty error object', () => {
  const rpcErr = toJsonRpcError({ ok: false, error: {} });
  assert.equal(rpcErr.code, -32603);
  assert.equal(rpcErr.message, 'unknown error');
});
