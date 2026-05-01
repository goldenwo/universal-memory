/**
 * server/lib/provider/errors.mjs — unified error taxonomy for provider modules.
 *
 * Each provider's `normalizeError` (see design §3.2) wraps its native error
 * shape into one of three classes:
 *   PROVIDER_CONFIG    — 4xx other than 429 (bad key, malformed model, missing
 *                        field). Not retryable; surface to operator.
 *   PROVIDER_UPSTREAM  — 5xx + network failures. Retryable.
 *   PROVIDER_RATELIMIT — 429. Retryable with backoff (caller honours
 *                        `Retry-After` if present on `cause`).
 *
 * Class enum is enforced at construction; an unknown class throws synchronously
 * to fail-loud on typos. `retryable` is strict `=== true` so providers must
 * opt in explicitly — `undefined` and truthy non-bools both yield `false`.
 */

const VALID_CLASSES = new Set(['PROVIDER_CONFIG', 'PROVIDER_UPSTREAM', 'PROVIDER_RATELIMIT']);

export class ProviderError extends Error {
  constructor({ class: errClass, provider, status, message, retryable, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    if (!VALID_CLASSES.has(errClass)) {
      throw new Error(`ProviderError class must be one of ${[...VALID_CLASSES].join('|')}; got ${errClass}`);
    }
    this.name = 'ProviderError';
    this.class = errClass;
    this.provider = provider;
    this.status = status;
    this.retryable = retryable === true;
    // No explicit `this.cause = cause` — super() handled it as a non-enumerable own property
    // (matches native Error semantics; prevents pino/JSON-stringify from leaking cause into logs).
  }
}
