export const ERROR_CODES = {
  AUTH_REQUIRED:        { http: 401, retryable: false },
  AUTH_INVALID:         { http: 401, retryable: false },
  INPUT_INVALID:        { http: 400, retryable: false },
  INPUT_TOO_LARGE:      { http: 413, retryable: false },
  STATE_NOT_FOUND:      { http: 404, retryable: false },
  STATE_ALREADY_EXISTS: { http: 409, retryable: false },
  STATE_LOCK_CONTENTION:{ http: 503, retryable: true  },
  LIMIT_RATE_EXCEEDED:  { http: 429, retryable: true  },
  UPSTREAM_FAILURE:     { http: 502, retryable: true  },
  SERVER_INTERNAL:      { http: 500, retryable: false },
};

export function errorResponse(code, message, extra = {}) {
  const spec = ERROR_CODES[code];
  if (!spec) throw new Error(`unknown error code: ${code}`);
  return { ok: false, error: { ...extra, code, message, retryable: spec.retryable } };
}

export function httpStatusFor(code) {
  const spec = ERROR_CODES[code];
  if (!spec) throw new Error(`unknown error code: ${code}`);
  return spec.http;
}
