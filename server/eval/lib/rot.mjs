// server/eval/lib/rot.mjs
// Pure scorers for the memory-rot longitudinal eval (#15). No live calls — importing
// this stays fully offline. Status-level reads come from qdrant payload.status; the
// scorers here are pure functions over already-collected snapshots.

/**
 * Status-level chain purity at one depth.
 * @param {Record<number,'current'|'superseded'>} chainStatuses status per seeded factIdx (0..latestIdx)
 * @param {number} latestIdx the just-seeded fact's index (= depth-1)
 * @returns {{staleSurvivors:number, latestCurrent:boolean, latestOnly:boolean}}
 */
export function chainPurity(chainStatuses, latestIdx) {
  let staleSurvivors = 0;
  for (let i = 0; i < latestIdx; i++) if (chainStatuses[i] === 'current') staleSurvivors++;
  const latestCurrent = chainStatuses[latestIdx] === 'current';
  return { staleSurvivors, latestCurrent, latestOnly: staleSurvivors === 0 && latestCurrent };
}
