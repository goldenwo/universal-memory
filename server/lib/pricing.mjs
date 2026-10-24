/**
 * server/lib/pricing.mjs — USD-per-1k-token pricing table for all 4 v0.7 providers.
 *
 * @typedef {Object} PriceEntry
 * @property {number} in   - USD per 1k INPUT tokens
 * @property {number} out  - USD per 1k OUTPUT tokens (0 for embedding-type)
 * @property {'chat'|'embed'|'unknown'} type
 * @property {number} [dim] - vector dimension; only present for type:'embed'
 * @property {{overTokensIn: number, in: number, out: number}} [longPrompt] - rates for a request
 *   whose input exceeds overTokensIn (the whole request is billed at them, not just the excess)
 *
 * @typedef {Object} ProviderPricing
 * @property {string} last_verified - ISO date or 'n/a' for self-hosted
 * @property {Object<string, PriceEntry>} models
 *
 * Units convention: ALL rates are USD per 1k tokens.
 * Rationale: matches OpenAI's published convention; computeCost divides token counts
 * by 1000 before multiplying. If you change the unit basis (e.g. per-million),
 * update both PRICING and computeCost in lockstep.
 *
 * Spec ref: design §8.1.
 *
 * @type {Object<string, ProviderPricing>}
 */
export const PRICING = {
  openai: {
    // 2026-10-23: rates read from developers.openai.com/api/docs/pricing (standard tier,
    // short context). gpt-4.1-nano was shut down that day; gpt-4o-mini and gpt-4.1-mini
    // shut down 2027-01-14. Retired ids stay listed so a .env that still pins one boots
    // (boot FATALs on an unpriced configured model — startup-validation validateModelExists).
    last_verified: '2026-10-23',
    models: {
      'gpt-6-luna':               { in: 0.00010, out: 0.00050, type: 'chat'  },
      'gpt-5.6-luna':             { in: 0.00020, out: 0.00120, type: 'chat'  },
      'gpt-4.1-mini':             { in: 0.00040, out: 0.00160, type: 'chat'  },
      'gpt-4o-mini':              { in: 0.00015, out: 0.00060, type: 'chat'  },
      'gpt-4.1-nano-2025-04-14':  { in: 0.00010, out: 0.00040, type: 'chat'  }, // retired 2026-10-23
      'text-embedding-3-small':   { in: 0.00002, out: 0,       type: 'embed', dim: 1536 },
      'text-embedding-3-large':   { in: 0.00013, out: 0,       type: 'embed', dim: 3072 },
    },
  },
  anthropic: {
    last_verified: '2026-10-20',
    models: {
      'claude-haiku-5-5':          { in: 0.00010, out: 0.00050, type: 'chat',
                                     longPrompt: { overTokensIn: 100_000, in: 0.00050, out: 0.00250 } },
      'claude-haiku-4-5-20251001': { in: 0.00100, out: 0.00500, type: 'chat' },
      'claude-sonnet-4-6':         { in: 0.00300, out: 0.01500, type: 'chat' },
    },
  },
  google: {
    // 2026-10-23: rates read from ai.google.dev/gemini-api/docs/pricing (paid tier,
    // standard). gemini-3.6-flash's rates double on 2027-01-01 ($1.50 / $7.50 per MTok) —
    // re-verify then. gemini-embedding-2 returns 3072 dims when no outputDimensionality is
    // sent (google.mjs embed sends none). gemini-2.0-flash (shut down 2026-06-01) and
    // text-embedding-004 (2026-01-14) stay listed so a pinning .env still boots.
    last_verified: '2026-10-23',
    models: {
      'gemini-3.6-flash':     { in: 0.00075, out: 0.00375, type: 'chat'  },
      'gemini-embedding-2':   { in: 0.00020, out: 0,       type: 'embed', dim: 3072 },
      'gemini-2.0-flash':     { in: 0.00010, out: 0.00040, type: 'chat'  }, // retired 2026-06-01
      'text-embedding-004':   { in: 0.00001, out: 0,       type: 'embed', dim: 768 }, // retired 2026-01-14
    },
  },
  ollama: {
    last_verified: 'n/a',
    models: {},
  },
};

export function priceFor(provider, model) {
  return PRICING[provider]?.models?.[model] ?? { in: 0, out: 0, type: 'unknown' };
}

export function computeCost(provider, model, tokensIn, tokensOut) {
  const base = priceFor(provider, model);
  const p = base.longPrompt && tokensIn > base.longPrompt.overTokensIn ? base.longPrompt : base;
  return (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out;
}
