/**
 * ranking.mjs — scoring/re-ranking helpers for universal-memory search results.
 *
 * Exports:
 *   applyTemporalDecay(results, halfLifeDays) → sorted results[]
 *
 * Temporal decay formula: score = originalScore * exp(-ageDays / halfLifeDays)
 *   where ageDays = (Date.now() - dateOf(result)) / 86400000
 *   and dateOf prefers metadata.valid_from, falls back to created_at.
 *   Items with neither field are returned with their original score (unchanged).
 *
 * Enabled via UM_TEMPORAL_DECAY=true (wired in mem0-mcp-http.mjs).
 * Half-life from UM_DECAY_HALF_LIFE_DAYS (default 30).
 */

/**
 * Apply temporal decay re-ranking to a list of search results.
 *
 * @param {Array<object>} results  - Search result objects with optional score,
 *                                   metadata.valid_from, and/or created_at fields.
 * @param {number}        halfLifeDays - Half-life in days for the decay factor.
 * @returns {Array<object>} New array sorted by decayed score descending.
 *                          Input array and its items are NOT mutated.
 */
export function applyTemporalDecay(results, halfLifeDays) {
  const now = Date.now();
  const decayed = results.map((r) => {
    // Prefer metadata.valid_from; fall back to created_at
    const vf = r.metadata?.valid_from || r.created_at;
    if (!vf) {
      // No date available — return a shallow copy with score unchanged
      return { ...r };
    }
    const ageDays = (now - new Date(vf).getTime()) / 86400000;
    const factor = Math.exp(-ageDays / halfLifeDays);
    return { ...r, score: (r.score || 1) * factor };
  });

  // Sort descending by score; items missing score sort last (treat as 0)
  decayed.sort((a, b) => (b.score || 0) - (a.score || 0));
  return decayed;
}
