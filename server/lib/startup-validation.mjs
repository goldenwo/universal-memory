/**
 * startup-validation.mjs — Boot-time validation module for provider-neutral startup.
 *
 * Host module for validators run at application startup. C3 introduces
 * `validateSummarizerConfig` (R8 visibility — info-log when fallback is cross-provider).
 * DE6 adds `validateProviderSupport` (R9 mitigation — refuse unsupported
 * (provider, surface) combos at boot, e.g. anthropic-as-embedder).
 * DE7 adds `validateModelExists` (Adv-5 mitigation — refuse models not in
 * PRICING for the active provider, e.g. UM_EMBEDDING_PROVIDER=google with
 * UM_EMBEDDING_MODEL=text-embedding-3-small; ollama exempt for local pulls).
 *
 * Cite: design §5.5 step 2 (R9 mitigation), §10.5 R8 (cross-provider fallback
 * visibility), Round-4 plan-doc Adv-5 (model-existence pre-validation).
 */

import { getProvider, supportingProviders } from './provider/registry.mjs';
import { PRICING } from './pricing.mjs';

/**
 * Validates summarizer configuration and logs:
 *   - deprecation warn when legacy UM_SUMMARIZER (v0.6) is set
 *   - conflict warn when both UM_SUMMARIZER and UM_SUMMARIZER_PROVIDER are set with different values
 *   - info when fallback is cross-provider
 *
 * @param {Record<string, string>} env - Environment variables
 * @param {object} log - Logger instance with info(obj, msg) and warn(obj, msg) methods (DI for testability)
 */
export function validateSummarizerConfig(env, log) {
  // Deprecation warning: UM_SUMMARIZER is the v0.6 env name; v0.7 prefers UM_SUMMARIZER_PROVIDER
  if (env.UM_SUMMARIZER && !env.UM_SUMMARIZER_PROVIDER) {
    log.warn(
      { legacy: 'UM_SUMMARIZER', current: 'UM_SUMMARIZER_PROVIDER', value: env.UM_SUMMARIZER },
      `UM_SUMMARIZER is the v0.6 env name; v0.7 prefers UM_SUMMARIZER_PROVIDER. Set UM_SUMMARIZER_PROVIDER=${env.UM_SUMMARIZER} to silence this warning.`,
    );
  }
  // Conflict warning: both set with different values — resolution order picks UM_SUMMARIZER (legacy)
  if (env.UM_SUMMARIZER && env.UM_SUMMARIZER_PROVIDER && env.UM_SUMMARIZER !== env.UM_SUMMARIZER_PROVIDER) {
    log.warn(
      { legacy: env.UM_SUMMARIZER, current: env.UM_SUMMARIZER_PROVIDER },
      `Conflict: UM_SUMMARIZER=${env.UM_SUMMARIZER} but UM_SUMMARIZER_PROVIDER=${env.UM_SUMMARIZER_PROVIDER}. Resolution order picks UM_SUMMARIZER (legacy). Remove UM_SUMMARIZER to use the new var.`,
    );
  }
  // Cross-provider fallback info
  const primary = env.UM_SUMMARIZER_PROVIDER || env.UM_SUMMARIZER || 'openai';
  const fallback = env.UM_SUMMARIZER_FALLBACK;
  if (fallback && fallback !== primary) {
    log.info(
      { primary, fallback },
      `summarizer fallback configured: ${primary} → ${fallback} (cross-provider; output style may vary)`,
    );
  }
}

/**
 * R9 mitigation — refuse unsupported (provider, surface) combinations at startup.
 *
 * Inspects each surface env var that is actually set (skip-on-missing — no
 * default synthesis) and verifies the named provider declares support for that
 * surface. Throws on first violation with a message that includes:
 *   - the surface name (embeddings|summarizer|facts)
 *   - the offending provider name
 *   - for known-but-unsupported: the list of valid providers for that surface
 *   - for unknown: the registry's `unknown provider: <name>; valid: ...` form
 *
 * @param {Record<string, string>} env - Environment variables (typically process.env)
 * @throws {Error} when any (provider, surface) combination is invalid
 */
export function validateProviderSupport(env) {
  const surfaces = [
    { envVar: 'UM_EMBEDDING_PROVIDER', surface: 'embeddings' },
    { envVar: 'UM_SUMMARIZER_PROVIDER', surface: 'summarizer' },
    { envVar: 'UM_FACTS_PROVIDER', surface: 'facts' },
  ];
  for (const { envVar, surface } of surfaces) {
    const name = env[envVar];
    if (!name) continue; // skip-on-missing: only validate explicitly set surfaces
    // getProvider throws "unknown provider: <name>; valid: ..." for unknown names —
    // that message already satisfies test 3's regex, so let it propagate.
    const provider = getProvider(name);
    if (!provider.supports?.[surface]) {
      throw new Error(
        `${name} does not support ${surface} (valid: ${supportingProviders(surface).join(', ')})`,
      );
    }
  }
}

/**
 * Gap-3 OAuth boot validation — refuse startup when UM_OAUTH_ENABLED=true
 * but UM_PUBLIC_BASE_URL is unset, empty, or not a valid http/https URL.
 *
 * No-op when OAuth is off (UM_OAUTH_ENABLED unset or !== 'true').
 *
 * @param {Record<string, string>} env - Environment variables
 * @throws {Error} when OAuth is enabled but base URL is missing or invalid
 */
export function validateOAuthConfig(env) {
  if ((env.UM_OAUTH_ENABLED ?? 'false') !== 'true') return;
  // Trailing-slash URLs are accepted here and normalized at use sites
  // (createRequestHandler hoists oauthBase with .replace(/\/+$/, '')).
  const OAUTH_URL_HINT = 'UM_OAUTH_ENABLED=true requires UM_PUBLIC_BASE_URL (canonical public origin, e.g. https://host.example)';
  const base = env.UM_PUBLIC_BASE_URL;
  if (!base || base.trim() === '') {
    throw new Error(OAUTH_URL_HINT);
  }
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(
      `UM_PUBLIC_BASE_URL is not a valid URL: "${base}" — ${OAUTH_URL_HINT}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `UM_PUBLIC_BASE_URL scheme must be http or https, got "${parsed.protocol.replace(/:$/, '')}" — ${OAUTH_URL_HINT}`,
    );
  }
  // Social-login IdP trio: all-or-nothing. A half-configured provider (1 or 2 of
  // 3 set) is a config mistake — refuse to boot rather than silently disable login.
  const idpTrioSet = [
    env.UM_OAUTH_IDP_GITHUB_CLIENT_ID,
    env.UM_OAUTH_IDP_GITHUB_CLIENT_SECRET,
    env.UM_OAUTH_OPERATOR_GITHUB,
  ].filter((v) => (v ?? '').trim() !== '').length;
  if (idpTrioSet > 0 && idpTrioSet < 3) {
    throw new Error(
      'UM_OAUTH_IDP_GITHUB_* requires all of CLIENT_ID, CLIENT_SECRET, and UM_OAUTH_OPERATOR_GITHUB (no half-enabled provider)',
    );
  }
}

/**
 * Adv-5 mitigation — refuse a model name not present in PRICING for the
 * configured provider, before any SDK call. Friendly error lists the known
 * model alternatives so operators can self-correct.
 *
 * Iterates the three surface (provider, model) pairs that are explicitly set
 * (skip-on-missing). Providers that declare `defaults.skipModelValidation`
 * (e.g. ollama — pulled models are user-managed locally and not enumerated
 * in PRICING) are exempt; future LM Studio / llama.cpp / vllm modules can
 * opt in via the same registry flag rather than touching this validator.
 * Unknown providers are silently skipped — `validateProviderSupport` (DE6)
 * owns the unknown-provider error path; this keeps DE7 self-contained and
 * order-independent. Reads PRICING[provider].models[model] directly (matches
 * actual export shape; see pricing.mjs §8.1).
 *
 * @param {Record<string, string>} env - Environment variables (typically process.env)
 * @throws {Error} when a configured (provider, model) is not in PRICING
 */
export function validateModelExists(env) {
  const surfaces = [
    { surface: 'embedding',  providerVar: 'UM_EMBEDDING_PROVIDER',  modelVar: 'UM_EMBEDDING_MODEL'  },
    { surface: 'summarizer', providerVar: 'UM_SUMMARIZER_PROVIDER', modelVar: 'UM_SUMMARIZER_MODEL' },
    { surface: 'facts',      providerVar: 'UM_FACTS_PROVIDER',      modelVar: 'UM_FACTS_MODEL'      },
  ];
  for (const { surface, providerVar, modelVar } of surfaces) {
    const provider = env[providerVar];
    const model = env[modelVar];
    if (!provider || !model) continue; // skip-on-missing
    if (!PRICING[provider]) continue; // unknown provider — DE6/registry owns its own error
    // Registry-driven exemption: ollama-class providers (skipModelValidation: true)
    // bypass the PRICING-table check because their model catalogue is user-managed.
    // try/catch matches DE6 fix-pass pattern (commit ea246e0): unknown providers
    // fall through safely without depending on validation order.
    const providerDef = (() => { try { return getProvider(provider); } catch { return null; } })();
    if (providerDef?.defaults?.skipModelValidation) continue;
    const known = PRICING[provider]?.models;
    if (!known || !known[model]) {
      const list = Object.keys(known || {}).join(', ');
      throw new Error(
        `${surface}: model '${model}' is not in PRICING for provider '${provider}'; ` +
        `either update server/lib/pricing.mjs (if ${provider} added a new model) ` +
        `or set ${modelVar} to one of: ${list}`,
      );
    }
  }
}
