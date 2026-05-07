// Reindex swap-mechanic phases — extracted from cli/reindex.mjs in v0.8.
//
// Three phases ship together because they share a single mental model:
//   • Phase 4 writes the stamp into the NEW collection (before swap).
//   • Phase 5 atomically redirects the alias to the new collection.
//   • Phase 6 verifies the alias resolves to a stamped + correctly-sized
//     collection.
//
// The split was pure refactor — see git log for the v0.8 G2 history if a
// behavioral question surfaces.

/**
 * Phase 4 (stamp) — write the new embedding stamp into the NEW Qdrant
 * collection BEFORE the alias swap (spec §6.3, Round-4 Adv-1 ordering).
 *
 * The stamp records the active embedding shape ({provider, model, dim}) so
 * later boots and reindexes can verify the collection's contents match the
 * configured embedder. This call lands the stamp in `targetCollection` —
 * NOT in the alias — because the alias still points at the OLD collection
 * until phase 5 performs the swap. Writing the stamp into the alias here
 * would mutate the live readers' view before the new vectors are publicly
 * addressable.
 *
 * Atomic-phase-advance: when both `state` and `checkpoint` are provided, the
 * function advances `phase_completed: 4` in the same `checkpoint.write` call
 * that follows the stamp write. When either is absent (unit-test path), the
 * stamp write still happens but the checkpoint advance is skipped — the
 * caller is expected to be a test exercising the stamp mechanics in
 * isolation, not the full production pipeline.
 *
 * @param {object} params
 * @param {object} params.memory - Memory instance scoped to `targetCollection`.
 *   Forwarded to `stamp.write` so the underlying `writeStamp` writes against
 *   the NEW collection's vector store, not the alias-resolved one.
 * @param {{ write: (args: { memory: object, collection: string, stamp: object }) => Promise<void> }} params.stamp
 *   Stamp client; the `write` shape matches `server/lib/embedding-stamp.mjs`'s
 *   `writeStamp({ memory, collection, stamp })`. Tests pass a mock that
 *   captures the `collection` arg.
 * @param {string} params.targetCollection - The new sha8-derived collection name.
 * @param {object} params.newStampShape - `{ provider, model, dim }` for the new
 *   embedding model. Sourced from env+pricing in the production CLI; tests
 *   pass a literal.
 * @param {object} [params.state] - Mutable checkpoint state (optional).
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint] - Optional
 *   checkpoint client. When both `state` and `checkpoint` are present, the
 *   atomic phase-4 advance happens.
 * @returns {Promise<void>}
 */
export async function runPhase4Stamp({
  memory,
  stamp,
  targetCollection,
  newStampShape,
  state,
  checkpoint,
}) {
  // Write the stamp into the NEW collection. Per spec §6.3 ordering, this
  // MUST complete before phase 5's alias swap so the new collection is
  // self-describing the moment readers can reach it.
  await stamp.write({ memory, collection: targetCollection, stamp: newStampShape });

  // Atomic-phase-advance — only when production-mode args are present.
  // Tests exercising stamp.write order in isolation skip this branch.
  if (state && checkpoint) {
    state.phase_completed = 4;
    await checkpoint.write(state);
  }
}

/**
 * Phase 5 (swap) — perform the Qdrant alias swap (`alias → targetCollection`).
 *
 * Defensive resume read (Round-4 Adv-finding): the function reads the new
 * collection's stamp BEFORE swapping. If the stamp is missing — meaning
 * phase 4 either didn't run, ran partially, or was rolled back since the
 * checkpoint advanced — phase 5 throws with operator-actionable guidance to
 * `--resume from phase 4`. This narrows a corruption window that would
 * otherwise leave the alias pointing at an unstamped collection.
 *
 * Atomic-phase-advance: when both `state` and `checkpoint` are provided,
 * `phase_completed: 5` lands in the same write that occurs after the alias
 * swap completes. Tests omit these and observe only the swap mechanics.
 *
 * Old-collection retention is intentionally NOT performed here. The R10
 * mitigation default (`--keep-old=true`) keeps the old collection on disk
 * until the operator explicitly opts in to a drop; that drop happens in
 * phase 7's report/cleanup pass, not phase 5.
 *
 * @param {object} params
 * @param {{ updateAlias: (args: { alias: string, collection: string }) => Promise<void> }} params.qdrant
 *   Qdrant client; `updateAlias` performs an atomic alias-redirect.
 * @param {string} params.alias - Public alias name (e.g. `'memories'`).
 * @param {string} params.targetCollection - The new collection name to point at.
 * @param {{ read: (args: { collection: string }) => Promise<object|null> }} params.stamp
 *   Stamp client; only `read` is called. Returns `null` when no stamp exists.
 * @param {object} [params.state]
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint]
 * @returns {Promise<void>}
 */
export async function runPhase5Swap({
  qdrant,
  alias,
  targetCollection,
  stamp,
  state,
  checkpoint,
}) {
  // Defensive resume read — refuse if phase 4 didn't actually durabilize a
  // stamp. The error message MUST match `/no stamp.*rerun --resume from
  // phase 4/i` (test contract) so the CLI surface layer can recognize the
  // failure and print actionable resume guidance.
  const targetStamp = await stamp.read({ collection: targetCollection });
  if (!targetStamp) {
    throw new Error(
      `refusing alias swap: target collection ${targetCollection} has no stamp; rerun --resume from phase 4`,
    );
  }

  // Stamp present → swap is safe. The alias swap is atomic on Qdrant's side
  // (it's the whole reason we use an alias rather than mutating a fixed
  // collection name).
  await qdrant.updateAlias({ alias, collection: targetCollection });

  if (state && checkpoint) {
    state.phase_completed = 5;
    await checkpoint.write(state);
  }
}

/**
 * Phase 6 (verify) — confirm the alias swap landed by reading the stamp via
 * the alias and (optionally) sanity-checking the entry count.
 *
 * The plan tests don't cover phase 6 directly (DE12's e2e fills that role
 * against a real Qdrant). This implementation is intentionally conservative:
 *   • Read the alias-resolved stamp. Compare against `newStampShape` if
 *     provided; otherwise just confirm a stamp exists.
 *   • Optionally count entries in the alias and compare to `expectedCount`
 *     when both `qdrant.count` and `expectedCount` are available.
 *   • Return `{ matches, expected, actual, stamp }` so phase 7's report can
 *     surface a verification line for the operator.
 *
 * `matches` is `true` when the stamp resolves AND (when both sides are
 * present) the count matches; it is `false` if the stamp is missing or the
 * counts disagree. The function does NOT throw on mismatch — it returns the
 * shape so phase 7 can render a clear report. The caller (CLI orchestrator)
 * decides whether `matches: false` is fatal or just a warning.
 *
 * Atomic-phase-advance: same optional-state pattern as phases 4-5.
 *
 * @param {object} params
 * @param {object} [params.memory] - Memory instance scoped to the alias (for
 *   stamp.read via the public alias).
 * @param {{ read: (args: { collection: string }) => Promise<object|null> }} params.stamp
 * @param {object} [params.qdrant] - Optional client exposing `count(alias)`.
 * @param {string} params.alias - Public alias name.
 * @param {object} [params.newStampShape] - Expected `{ provider, model, dim }`.
 * @param {number} [params.expectedCount] - Expected entry count from snapshot.
 * @param {object} [params.state]
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint]
 * @returns {Promise<{ matches: boolean, expected: number|null, actual: number|null, stamp: object|null }>}
 */
export async function runPhase6Verify({
  memory,
  stamp,
  qdrant,
  alias,
  newStampShape,
  expectedCount,
  state,
  checkpoint,
}) {
  // Stamp readback — confirm the alias resolves to a stamped collection.
  const aliasStamp = await stamp.read({ collection: alias });

  // Stamp shape comparison — only when an expected shape was provided.
  let stampMatches = aliasStamp != null;
  if (stampMatches && newStampShape) {
    stampMatches =
      aliasStamp.provider === newStampShape.provider &&
      aliasStamp.model === newStampShape.model &&
      (newStampShape.dim == null ||
        aliasStamp.dim == null ||
        aliasStamp.dim === newStampShape.dim);
  }

  // Count comparison — only when both sides are available.
  let actualCount = null;
  let countMatches = true;
  if (qdrant && typeof qdrant.count === 'function' && typeof expectedCount === 'number') {
    actualCount = await qdrant.count(alias);
    countMatches = actualCount === expectedCount;
  }

  const matches = stampMatches && countMatches;

  if (state && checkpoint) {
    state.phase_completed = 6;
    state.verify = { matches, expected: expectedCount ?? null, actual: actualCount, stamp: aliasStamp };
    await checkpoint.write(state);
  }

  return {
    matches,
    expected: typeof expectedCount === 'number' ? expectedCount : null,
    actual: actualCount,
    stamp: aliasStamp,
  };
}
