// server/eval/lib/rrf.mjs — weighted Reciprocal Rank Fusion for the #188 eval.
//
// score(doc) = Σ_arms weight_arm / (k + rank_arm(doc)), rank 1-based, k=60 (spec §5.5).
// A doc missing from an arm contributes nothing from that arm (NOT 1/(k+0) — that would
// silently reward absence).
//
// Frozen weights for this eval are 1.0 : 1.0 (vector : lexical). The `weight 0 ⇒ fusion
// === that arm alone` property is a pre-registered NEGATIVE CONTROL (spec §5.3): both
// fusion arms share this module, so a shared misconception here would move them the same
// direction and satisfy G2's retention relation while measuring nothing.
//
// No live calls — importing this stays fully offline.

export const RRF_K = 60;

/**
 * @param {{ranking: string[], weight?: number}[]} arms — each `ranking` is doc ids, best first
 * @param {{k?: number, limit?: number}} opts
 * @returns {{id: string, score: number}[]} descending; ties broken by id for determinism
 */
export function fuse(arms, { k = RRF_K, limit = Infinity } = {}) {
  const acc = new Map();
  for (const arm of arms ?? []) {
    const weight = arm.weight ?? 1;
    if (weight === 0) continue; // contributes nothing — see negative control above
    arm.ranking?.forEach((id, i) => {
      acc.set(id, (acc.get(id) || 0) + weight / (k + i + 1)); // i+1 ⇒ 1-based rank
    });
  }
  return [...acc]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit === Infinity ? undefined : limit);
}
