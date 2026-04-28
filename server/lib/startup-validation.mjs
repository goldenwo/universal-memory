/**
 * startup-validation.mjs — Boot-time validation module for provider-neutral startup.
 *
 * Host module for validators run at application startup. C3 introduces
 * `validateSummarizerConfig` (R8 visibility — info-log when fallback is cross-provider).
 * DE6 + DE7 will extend with `validateProviderSupport` and `validateModelExists`.
 *
 * Cite: design §10.5 R8 (cross-provider fallback visibility).
 */

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
