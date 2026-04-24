// AsyncLocalStorage wrapper for request_id propagation.
// Spec §4.2.0: cumulative cost budget per request 100 µs.
// /health opts out — caller MUST NOT wrap /health handler in withRequestContext.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const als = new AsyncLocalStorage();

export async function withRequestContext(ctx, fn) {
  const bound = { ...ctx, id: ctx.id ?? randomUUID() };
  return als.run(bound, fn);
}

export function currentRequestId() {
  const s = als.getStore();
  return s ? s.id : null;
}

export function _alsForTest() { return als; }
