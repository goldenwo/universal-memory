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
 * Validates summarizer configuration and logs info when fallback is cross-provider.
 *
 * @param {Record<string, string>} env - Environment variables (UM_SUMMARIZER_PROVIDER, UM_SUMMARIZER_FALLBACK)
 * @param {object} log - Logger instance with info(obj, msg) method (for testability/DI)
 */
export function validateSummarizerConfig(env, log) {
  const primary = env.UM_SUMMARIZER_PROVIDER || 'openai';
  const fallback = env.UM_SUMMARIZER_FALLBACK;
  if (fallback && fallback !== primary) {
    log.info(
      { primary, fallback },
      `summarizer fallback configured: ${primary} → ${fallback} (cross-provider; output style may vary)`,
    );
  }
}
