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

/**
 * Retrieval-level purity at one depth — identical definition for UM and mem0.
 * @param {string[]} resultBodies normalized top-K result bodies, in rank order
 * @param {string[]} chainFacts normalized full chain facts
 * @param {number} depth facts[0..depth-1] are seeded; latest = chainFacts[depth-1]
 */
export function retrievalPurity(resultBodies, chainFacts, depth) {
  const latest = chainFacts[depth - 1];
  const present = new Set(resultBodies);
  let staleSurfaced = 0;
  for (let i = 0; i < depth - 1; i++) if (present.has(chainFacts[i])) staleSurfaced++;
  const latestSurfaced = present.has(latest);
  const latestTop1 = resultBodies[0] === latest;
  return { staleSurfaced, latestSurfaced, latestTop1, onlyCurrent: latestSurfaced && staleSurfaced === 0 };
}
