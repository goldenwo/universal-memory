/**
 * JSON-RPC error code mapping for Task B.13 (§5.1 dual-shape).
 *
 * Maps stable string codes (from `lib/error-envelope.mjs`) to JSON-RPC 2.0
 * numeric codes. The -32000 to -32099 range is reserved for "implementation-
 * defined server errors" per the JSON-RPC 2.0 spec; we live inside it.
 *
 * Two codes reuse standard JSON-RPC reserved codes for caller-action parity:
 *   -32602 ("invalid params")  for INPUT_INVALID — JSON-RPC's canonical
 *                                bad-shape signal so generic clients still
 *                                handle it correctly without our code map.
 *   -32603 ("internal error")  for SERVER_INTERNAL — same rationale.
 *
 * The §5.1 wire envelope (string code, retryable bool, message) lives in the
 * INNER `text` content block of the tool result. The OUTER JSON-RPC `error`
 * object carries the numeric mapping — `data.stable_code` and `data.retryable`
 * preserve the inner envelope's metadata so JSON-RPC consumers can reason
 * about retry without parsing the inner blob.
 */
export const JSONRPC_CODE_MAP = {
  AUTH_REQUIRED:         -32001,
  AUTH_INVALID:          -32002,
  INPUT_INVALID:         -32602, // standard "invalid params"
  INPUT_TOO_LARGE:       -32003,
  STATE_NOT_FOUND:       -32004,
  STATE_ALREADY_EXISTS:  -32005,
  STATE_LOCK_CONTENTION: -32006,
  LIMIT_RATE_EXCEEDED:   -32007,
  UPSTREAM_FAILURE:      -32008,
  SERVER_INTERNAL:       -32603, // standard "internal error"
};

/**
 * Translate a v0.6 unified error envelope into a JSON-RPC 2.0 `error` object.
 *
 * Unknown / missing stable codes fall back to -32603 (internal error). This
 * keeps the dual-shape resilient when an envelope sneaks through with a code
 * we haven't registered yet — better to surface as "internal" than to throw.
 *
 * @param {{ ok: false, error: { code?: string, message?: string, retryable?: boolean } }} envelope
 * @returns {{ code: number, message: string, data: { stable_code: string|undefined, retryable: boolean|undefined } }}
 */
export function toJsonRpcError(envelope) {
  const stable = envelope?.error?.code;
  const num = (stable && JSONRPC_CODE_MAP[stable]) ?? -32603;
  return {
    code: num,
    message: envelope?.error?.message ?? 'unknown error',
    data: { stable_code: stable, retryable: envelope?.error?.retryable },
  };
}
