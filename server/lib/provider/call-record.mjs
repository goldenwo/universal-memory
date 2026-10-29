// server/lib/provider/call-record.mjs — the R1 call record (model migration Phase B, spec R1).
//
// Each provider's summarizer, judge and grader invoke returns what it sent and how the call
// ended: requestParams, servedModel, systemFingerprint, reasoningTokens and stopReason. The
// dispatchers (contradiction-judge, answer-grader, extraction-grader, summarize) pass the five
// through unchanged, for the eval harnesses; production callers ignore them.

export const R1_FIELDS = Object.freeze(['requestParams', 'servedModel', 'systemFingerprint', 'reasoningTokens', 'stopReason']);

/**
 * The R1 fields of an invoke's return, copied as they are. A field the provider does not return
 * is left out, not set to undefined, so a provider without the record (google, ollama, a test
 * stub) leaves its caller's return shape exactly as before.
 */
export function r1Record(raw) {
  return Object.fromEntries(R1_FIELDS.filter((k) => raw?.[k] !== undefined).map((k) => [k, raw[k]]));
}
