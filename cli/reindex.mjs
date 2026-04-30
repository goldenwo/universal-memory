/**
 * cli/reindex.mjs — Reindex CLI host module (multi-phase pipeline).
 *
 * Spec ref: §6.4 (state schema), §6.5 (phase pipeline). The CLI walks the user
 * through a 5-phase reindex (validate → snapshot → embed-new → swap → cleanup)
 * with checkpointed resumability. Each phase advances `phase_completed` exactly
 * once and writes the full updated state atomically (single writeCheckpoint
 * call per phase boundary) so a crash leaves the checkpoint either fully at
 * phase N or fully at phase N+1, never torn.
 *
 * DE9 lands phase 1 (validate). DE10–DE11 add subsequent phases to this same
 * file. Each phase exports a `runPhaseN*` function with explicit dependency
 * injection so phases can be unit-tested in isolation without touching real
 * Qdrant, the live server, or the user's vault.
 *
 * Phase 1 (validate) — three pre-flight gates before the operator commits to
 * reindexing:
 *   1. Stamp-vs-env mismatch gate — refuse if the active stamp already matches
 *      env (`UM_EMBEDDING_PROVIDER`/`UM_EMBEDDING_MODEL`); reindex would be a
 *      no-op (test 2).
 *   2. Server-responsive gate — refuse if the API server answers /api/state at
 *      `serverProbeUrl`; the server holds connections to the source collection
 *      and a concurrent reindex risks split state (test 3). Operators can pass
 *      `--no-server-probe` to bypass when the probe URL is wrong but they're
 *      certain the server is stopped (test 5).
 *   3. Estimate-and-confirm gate — print {entries, tokens, cost_usd} and (in
 *      interactive mode) prompt before proceeding so operators see the cost
 *      before any embedding API calls (test 6).
 *
 * Atomic-phase-advance contract (echoed in DE10–DE11): on success, the SAME
 * `checkpoint.write` call persists BOTH the phase outputs AND
 * `phase_completed: 1`. Don't write outputs first then bump phase in a separate
 * call — that opens a crash window where the next CLI run sees an incomplete
 * phase but a bumped counter, falsely skipping replay.
 *
 * Public API:
 *   - runPhase1Validate({ ... }) → { proceed, estimate, fromStamp, toShape }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';

const SCHEMA_VERSION = 1;
const DEFAULT_SERVER_PROBE_URL = 'http://localhost:6335';
// Conservative per-entry token estimate used until snapshot phase (DE10) walks
// real fact bodies. Phase 1's job is to give an order-of-magnitude cost preview
// before the operator consents; the real cost is recomputed in phase 3 against
// actual embedding API token usage.
const ESTIMATE_TOKENS_PER_ENTRY = 200;

/**
 * Default interactive prompt — reads a single line from stdin. Replaced in
 * tests via the `prompt` DI parameter so test runs never block.
 *
 * @param {string} question - The prompt text shown to the operator.
 * @returns {Promise<string>} The trimmed line the operator typed (lowercased).
 */
export async function readUserConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return String(answer ?? '').trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/**
 * Derive the target Qdrant collection name for a given (provider, model). The
 * server uses sha8(provider:model) to namespace collections per embedding
 * shape so concurrent collections don't collide. DE11 (swap) writes the new
 * stamp into this collection; DE9 records it on the checkpoint so resume after
 * crash uses the same name.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {string} `memories_<8 hex chars>`
 */
function deriveTargetCollection(provider, model) {
  const hash = createHash('sha256').update(`${provider}:${model}`).digest('hex').slice(0, 8);
  return `memories_${hash}`;
}

/**
 * Count `.md` files under the configured vault. Used by phase 1 to estimate
 * how many entries the reindex will process; the snapshot phase (DE10) will
 * replace this with a real listing of fact-bearing entries.
 *
 * Skips silently (returns 0) when the vault dir doesn't exist or isn't
 * configured — phase 1 should still produce an estimate object so the operator
 * sees the cost format even when the vault is empty.
 *
 * @param {string|undefined} vaultDir - Absolute path; typically `env.UM_VAULT_DIR`.
 * @returns {Promise<number>}
 */
async function countVaultMarkdownFiles(vaultDir) {
  if (!vaultDir) return 0;
  try {
    await fs.access(vaultDir);
  } catch {
    return 0;
  }
  let count = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Fail-soft on unreadable subdirs (EACCES, EPERM, etc.). Phase 1's
      // estimate is intentionally an order-of-magnitude preview; the real
      // count comes from the snapshot phase. A single permission error
      // shouldn't kill the entire validate gate.
      process.stderr.write(`[reindex] could not read ${dir}: ${err.code}; estimate may be low\n`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // Match server/lib/vault.mjs: ignore symlinks defensively, recurse dirs,
      // count regular .md files.
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count += 1;
      }
    }
  }
  await walk(vaultDir);
  return count;
}

/**
 * Probe the API server at `<serverProbeUrl>/api/state`. Returns true if the
 * server responded (any HTTP response — even 4xx/5xx counts as "responsive"
 * because something is listening), false if the connection failed or the
 * fetch threw. Phase 1 refuses to proceed when the probe says responsive.
 *
 * @param {Function} fetchFn
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function probeServer(fetchFn, url) {
  try {
    await fetchFn(`${url.replace(/\/$/, '')}/api/state`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase 1 (validate) — see file header for the three gates.
 *
 * @param {object} params
 * @param {{ read: () => Promise<object|null> }} params.stamp
 *   Stamp client; only `read()` is called in phase 1.
 * @param {Record<string, string|undefined>} params.env
 *   Env vars (typically `process.env`). Reads
 *   `UM_EMBEDDING_PROVIDER`/`UM_EMBEDDING_MODEL`/`UM_VAULT_DIR`.
 * @param {{ priceFor: (provider: string, model: string) => { in: number, out: number, type: string, dim?: number } }} params.pricing
 *   Pricing module; `priceFor(provider, model)` shape matches `server/lib/pricing.mjs`.
 * @param {string} [params.serverProbeUrl='http://localhost:6335']
 * @param {boolean} params.noServerProbe
 * @param {boolean} params.confirmInteractive
 *   `true` means `--confirm` was passed; the operator pre-approved the run, so
 *   skip the prompt. `false` means run interactively and call `prompt(...)`.
 * @param {Function} [params.fetch=global.fetch]
 *   Probe HTTP client (DI for tests).
 * @param {(question: string) => Promise<string>} [params.prompt=readUserConfirm]
 * @param {{ write: (state: object) => Promise<void> }} params.checkpoint
 *   Checkpoint client; phase 1 calls `write(state)` exactly once on success.
 * @returns {Promise<{ proceed: boolean, estimate: object, fromStamp: object|null, toShape: object }>}
 */
export async function runPhase1Validate({
  stamp,
  env,
  pricing,
  serverProbeUrl = DEFAULT_SERVER_PROBE_URL,
  noServerProbe,
  confirmInteractive,
  fetch = globalThis.fetch,
  prompt = readUserConfirm,
  checkpoint,
}) {
  // 1. Read current stamp; derive expected shape from env.
  const fromStamp = await stamp.read();
  const toProvider = env.UM_EMBEDDING_PROVIDER;
  const toModel = env.UM_EMBEDDING_MODEL;
  // pricing.priceFor returns { in, out, type, dim? }; dim may be undefined for
  // stub pricing modules used in tests. The no-op gate below compares dim only
  // when present on both sides (skip-null), so missing dim falls back to
  // provider+model equality. Dim is also recorded on the checkpoint for DE11's
  // swap phase.
  const toPrice = pricing.priceFor(toProvider, toModel);
  const toShape = { provider: toProvider, model: toModel, dim: toPrice?.dim };

  // No-op gate: stamp already matches env on (provider, model[, dim]). Refuse —
  // there is nothing to reindex.
  //
  // Dim handling uses skip-null pattern: if EITHER side lacks dim (e.g., test
  // pricing stub omits dim, or stamp predates dim recording), we fall back to
  // provider+model equality. When BOTH sides report dim, we require equality —
  // this catches the OpenAI text-embedding-3-small dim-truncation case (native
  // 1536 vs explicit 512), where provider+model match but the user legitimately
  // wants a reindex into a different-shape collection.
  if (
    fromStamp &&
    fromStamp.provider === toProvider &&
    fromStamp.model === toModel &&
    (toShape.dim == null || fromStamp.dim == null || fromStamp.dim === toShape.dim)
  ) {
    throw new Error(
      `no-op: stamp matches env (${toProvider}/${toModel}); nothing to reindex`,
    );
  }

  // 2. Server-responsive gate (skippable via --no-server-probe).
  if (!noServerProbe) {
    const responsive = await probeServer(fetch, serverProbeUrl);
    if (responsive) {
      throw new Error(
        `server is responsive at ${serverProbeUrl}; stop it before reindex (the server holds connections to the source collection)`,
      );
    }
    // Unreachable: refuse with explicit choices.
    throw new Error(
      `could not probe server at ${serverProbeUrl}; pass --server-url=<url> to point at the right port, or --no-server-probe to skip the probe entirely (only safe if you have stopped the server manually)`,
    );
  }

  // 3. Walk vault + count Qdrant entries → estimate.
  // DE9 simplification: we count `.md` files under UM_VAULT_DIR as a proxy for
  // entries. Real fact counts come from the snapshot phase (DE10), which will
  // also count Qdrant entries via a real client. Tests don't assert specific
  // numbers — only types — so 0 from a missing vault is acceptable here.
  const vaultEntries = await countVaultMarkdownFiles(env.UM_VAULT_DIR);
  // DE9: Qdrant count deferred to DE10 snapshot phase (requires a running
  // Qdrant instance and a client — out of scope for the validate gate).
  const qdrantEntries = 0;
  const entries = vaultEntries + qdrantEntries;
  const tokens = entries * ESTIMATE_TOKENS_PER_ENTRY;
  const cost_usd = (tokens / 1000) * (toPrice?.in ?? 0);
  const estimate = { entries, tokens, cost_usd };

  // 4. Print estimate + prompt (interactive mode only). When --confirm was
  // passed (confirmInteractive===true), skip the prompt entirely — the
  // operator pre-approved the run.
  if (!confirmInteractive) {
    process.stdout.write(
      `Reindex estimate: ${entries} entries, ~${tokens} tokens, ~$${cost_usd.toFixed(4)} USD\n` +
      `From: ${fromStamp ? `${fromStamp.provider}/${fromStamp.model}/${fromStamp.dim}` : '(no stamp)'}\n` +
      `To:   ${toShape.provider}/${toShape.model}/${toShape.dim ?? '?'}\n`,
    );
    const answer = await prompt('proceed? [y/N]: ');
    if (String(answer).trim().toLowerCase() !== 'y') {
      throw new Error('reindex cancelled by operator (answered no at confirm prompt)');
    }
  }

  // 5. Atomic-phase-advance: persist phase-1 outputs AND phase_completed=1 in
  // a single write. Crash before this returns → next run sees no checkpoint
  // and replays from phase 1; crash after → next run sees phase_completed=1
  // and skips to phase 2.
  const target_collection = deriveTargetCollection(toShape.provider, toShape.model);
  const state = {
    schema_version: SCHEMA_VERSION,
    started_at: new Date().toISOString(),
    from: fromStamp,
    to: toShape,
    target_collection,
    phase_completed: 1,
    estimate,
    processed_ids: [],
    last_error: null,
  };
  await checkpoint.write(state);

  return { proceed: true, estimate, fromStamp, toShape };
}
