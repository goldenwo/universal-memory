const VALID_CLASSES = new Set(['PROVIDER_CONFIG', 'PROVIDER_UPSTREAM', 'PROVIDER_RATELIMIT']);

export class ProviderError extends Error {
  constructor({ class: errClass, provider, status, message, retryable, cause }) {
    super(message);
    if (!VALID_CLASSES.has(errClass)) {
      throw new Error(`ProviderError class must be one of ${[...VALID_CLASSES].join('|')}; got ${errClass}`);
    }
    this.name = 'ProviderError';
    this.class = errClass;
    this.provider = provider;
    this.status = status;
    this.retryable = retryable === true;
    this.cause = cause;
  }
}
