/**
 * server/lib/pricing.mjs — USD-per-1k-token pricing table for all 4 v0.7 providers.
 *
 * @typedef {Object} PriceEntry
 * @property {number} in   - USD per 1k INPUT tokens
 * @property {number} out  - USD per 1k OUTPUT tokens (0 for embedding-type)
 * @property {'chat'|'embed'|'unknown'} type
 * @property {number} [dim] - vector dimension; only present for type:'embed'
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
    last_verified: '2026-04-27',
    models: {
      'gpt-4o-mini':              { in: 0.00015, out: 0.00060, type: 'chat'  },
      'gpt-4.1-nano-2025-04-14':  { in: 0.00010, out: 0.00040, type: 'chat'  },
      'text-embedding-3-small':   { in: 0.00002, out: 0,       type: 'embed', dim: 1536 },
      'text-embedding-3-large':   { in: 0.00013, out: 0,       type: 'embed', dim: 3072 },
    },
  },
  anthropic: {
    last_verified: '2026-04-27',
    models: {
      'claude-haiku-4-5-20251001': { in: 0.00100, out: 0.00500, type: 'chat' },
      'claude-sonnet-4-6':         { in: 0.00300, out: 0.01500, type: 'chat' },
    },
  },
  google: {
    last_verified: '2026-04-27',
    models: {
      'gemini-2.0-flash':     { in: 0.00010, out: 0.00040, type: 'chat'  },
      'text-embedding-004':   { in: 0.00001, out: 0,       type: 'embed', dim: 768 },
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
  const p = priceFor(provider, model);
  return (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out;
}
