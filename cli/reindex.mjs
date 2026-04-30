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
 * DE9 lands phase 1 (validate). DE10 adds phase 2 (snapshot) and phase 3
 * (rebuild). Each phase exports a `runPhaseN*` function with explicit dependency
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
 * Phase 2 (snapshot) — enumerate the entries to rebuild. Walks the configured
 * vault for `.md` files (file-backed entries) AND queries the source Qdrant
 * collection for fact-only payloads (entries without a vault file). Writes
 * `state.snapshot = { vault_paths, fact_ids }` atomically with phase_completed=2
 * so a crash either replays the snapshot or skips it cleanly. DE12's e2e test
 * exercises this path; DE10 ships the implementation alongside the phase 3
 * tests so the snapshot dependency is in place before phase 3's resume tests.
 *
 * Phase 3 (rebuild) — replay the snapshot through the new Memory instance with
 * `infer: false` (we already extracted facts on the original write; we just need
 * fresh embeddings). Three rules govern the rebuild loop:
 *   • Resume-safe: entries already in `state.processed_ids` are skipped on
 *     replay. The CLI tolerates being re-run after a crash without re-embedding
 *     completed entries (the dominant cost driver).
 *   • Rate-limit retries: on `PROVIDER_RATELIMIT` class errors, retry with
 *     exponential backoff up to `maxRetries`. On exhaustion, write a checkpoint
 *     and surface the error with `--resume` instructions so the operator can
 *     wait for quota recovery and continue from the last good entry.
 *   • Atomic phase-advance (Adv-4 contract): the FINAL entry's
 *     `state.processed_ids.push(id)` AND `state.phase_completed = 3` MUST be
 *     persisted in the SAME `checkpoint.write(state)` call. A naive
 *     "push-then-record-then-write-twice" pattern opens a crash window where
 *     phase 3 finishes but phase_completed stays at 2 — `--resume` then re-runs
 *     the entire phase from scratch (idempotent on processed_ids, but expensive).
 *
 * Atomic-phase-advance contract (echoed in DE10–DE11): on success, the SAME
 * `checkpoint.write` call persists BOTH the phase outputs AND
 * `phase_completed: N`. Don't write outputs first then bump phase in a separate
 * call — that opens a crash window where the next CLI run sees an incomplete
 * phase but a bumped counter, falsely skipping replay.
 *
 * Public API:
 *   - runPhase1Validate({ ... }) → { proceed, estimate, fromStamp, toShape }
 *   - runPhase2Snapshot({ ... }) → { vault_paths, fact_ids }
 *   - runPhase3Rebuild({ ... })  → { processed }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { ProviderError } from '../server/lib/provider/errors.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_SERVER_PROBE_URL = 'http://localhost:6335';
// Conservative per-entry token estimate used until snapshot phase (DE10) walks
// real fact bodies. Phase 1's job is to give an order-of-magnitude cost preview
// before the operator consents; the real cost is recomputed in phase 3 against
// actual embedding API token usage.
const ESTIMATE_TOKENS_PER_ENTRY = 200;
// Phase 3 rebuild defaults — kept as named constants so CLI flag wiring (and
// future tuning) has a single source of truth. Tests override via DI to avoid
// real wall-clock waits.
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_PROGRESS_EVERY = 100;
const DEFAULT_RETRY_BASE_MS = 100;

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

/**
 * Walk a vault directory and return all `.md` file paths (relative to the
 * vault root). Mirrors `countVaultMarkdownFiles` but collects paths instead of
 * counting. Symlinks are skipped to match `server/lib/vault.mjs`. Permission
 * errors on subdirs are reported once to stderr and skipped — phase 2 should
 * not abort on a single unreadable subtree (the operator will see the warning;
 * partial coverage is better than a full halt mid-snapshot).
 *
 * @param {string|undefined} vaultDir - Absolute vault root.
 * @returns {Promise<string[]>}        - Vault-relative `.md` paths.
 */
async function listVaultMarkdownPaths(vaultDir) {
  if (!vaultDir) return [];
  try {
    await fs.access(vaultDir);
  } catch {
    return [];
  }
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      process.stderr.write(`[reindex] could not read ${dir}: ${err.code}; some entries may be missing from the snapshot\n`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(vaultDir, abs).split(path.sep).join('/'));
      }
    }
  }
  await walk(vaultDir);
  return out;
}

/**
 * Phase 2 (snapshot) — enumerate everything that needs to be rebuilt.
 *
 * Two sources contribute to the snapshot:
 *   1. The vault directory — every `.md` file is a vault-backed entry whose
 *      body+frontmatter will be re-embedded under the new model in phase 3.
 *   2. The OLD Qdrant collection — fact-only payloads (entries that have NO
 *      vault file because they were stored as facts via `infer:true`). The
 *      `oldMemory` client is expected to expose a `listFactIds()` method that
 *      returns IDs whose payloads do not correspond to a vault file. DE12's
 *      e2e test exercises this against a real Qdrant; the DI shape here lets
 *      future tests fake it cheaply.
 *
 * Atomic phase-advance: the snapshot AND `phase_completed: 2` are persisted
 * in a single `checkpoint.write` call so a crash between writing the snapshot
 * and bumping the phase counter is impossible.
 *
 * @param {object} params
 * @param {{ dir?: string }} params.vault - Vault config; `dir` is the absolute
 *   path under which to walk for `.md` files.
 * @param {{ listFactIds?: () => Promise<string[]> }} [params.oldMemory]
 *   Optional source for fact-only IDs. Phase 2 tolerates a missing client
 *   (no facts contributed). DE12 wires the real client.
 * @param {object} params.state - Mutable checkpoint state. Phase 2 mutates
 *   `state.snapshot` and `state.phase_completed`.
 * @param {{ write: (s: object) => Promise<void> }} params.checkpoint
 * @returns {Promise<{ vault_paths: string[], fact_ids: string[] }>}
 */
export async function runPhase2Snapshot({ vault, oldMemory, state, checkpoint }) {
  const vault_paths = await listVaultMarkdownPaths(vault?.dir);
  // Fact-only IDs: prefer an explicit listFactIds() method on the old memory
  // client. Returning [] when the client isn't available keeps the e2e test
  // (DE12) the source of truth for the live-Qdrant path while letting unit
  // tests stub the snapshot directly without a Qdrant.
  let fact_ids = [];
  if (oldMemory && typeof oldMemory.listFactIds === 'function') {
    fact_ids = await oldMemory.listFactIds();
  }
  state.snapshot = { vault_paths, fact_ids };
  state.phase_completed = 2;
  await checkpoint.write(state);
  return { vault_paths, fact_ids };
}

/**
 * Sleep for `ms` milliseconds. Lifted to a named function so tests that want
 * to override timing (none in DE10 — the tests stub on attempt count, not
 * wall-clock) have a single seam.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Re-embed a single entry through the new Memory instance. Pulls the source
 * text via `vault.read(id)` and calls `newMemory.add(body, { metadata, infer:false })`.
 *
 * Per the DE10 test contract: vault.read is called for every entry, regardless
 * of whether it originated from `vault_paths` or `fact_ids`. Real-world
 * deployments back this with a vault implementation that knows how to materialize
 * a fact-only payload as `{ frontmatter: { id }, body: <fact memory text> }`;
 * tests stub it directly.
 */
async function rebuildOne(newMemory, vault, id) {
  const { frontmatter, body } = await vault.read(id);
  await newMemory.add(body, {
    metadata: { id: frontmatter.id, ...frontmatter },
    infer: false,
  });
}

/**
 * Phase 3 (rebuild) — replay the snapshot through the new Memory with
 * `infer: false`.
 *
 * Resume contract: entries already in `state.processed_ids` are filtered out
 * before the loop runs. After a successful add, `state.processed_ids.push(id)`
 * runs synchronously so the in-memory state matches what we will persist at
 * the next checkpoint write.
 *
 * Retry contract (Adv-4): on `PROVIDER_RATELIMIT`-class errors we retry with
 * exponential backoff (`baseMs * 2^attempt`) up to `maxRetries`. On exhaustion
 * we write the checkpoint (so the operator's next `--resume` skips everything
 * we already processed) and throw a fresh `ProviderError` whose message
 * includes `--resume` so the CLI surface layer can print actionable guidance.
 * Non-rate-limit errors propagate immediately — phase 3 doesn't second-guess
 * the operator on configuration or data-shape failures.
 *
 * Atomic phase-advance contract: the FINAL entry's `processed_ids.push` AND
 * `phase_completed = 3` are bundled into a single terminal
 * `checkpoint.write(state)` call. Any per-entry progress writes triggered by
 * `progressEvery` happen BEFORE this terminal write — they NEVER set
 * `phase_completed = 3`. This avoids the crash window where phase 3's last
 * entry succeeds but the next CLI run sees `phase_completed = 2` and replays
 * the entire phase from scratch (idempotent, but expensive on a 10k-entry vault).
 *
 * @param {object} params
 * @param {{ add: (text: string, opts: object) => Promise<void> }} params.newMemory
 * @param {{ snapshot: { vault_paths: string[], fact_ids: string[] }, processed_ids: string[] }} params.state
 *   Mutable. Phase 3 pushes to `processed_ids` and sets `phase_completed`.
 * @param {{ write: (s: object) => Promise<void> }} params.checkpoint
 * @param {{ read: (id: string) => Promise<{ frontmatter: object, body: string }> }} params.vault
 * @param {number} [params.maxRetries=3]    - Per-entry retry budget on PROVIDER_RATELIMIT.
 * @param {number} [params.progressEvery=100] - Write a progress checkpoint every N entries.
 * @param {number} [params.retryBaseMs=100] - Base delay for exponential backoff. Tests pass 0.
 * @returns {Promise<{ processed: number }>}
 */
export async function runPhase3Rebuild({
  newMemory,
  state,
  checkpoint,
  vault,
  maxRetries = DEFAULT_MAX_RETRIES,
  progressEvery = DEFAULT_PROGRESS_EVERY,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
}) {
  const snapshot = state.snapshot || { vault_paths: [], fact_ids: [] };
  // Iterate vault entries first, then fact-only IDs. Order is incidental for
  // correctness (each add is independent), but stable for log readability.
  const allIds = [...(snapshot.vault_paths || []), ...(snapshot.fact_ids || [])];
  // Resume: skip anything already processed. Use Set for O(1) membership.
  const done = new Set(state.processed_ids || []);
  const todo = allIds.filter((id) => !done.has(id));

  // processed_ids may be a Set on a resumed state (the checkpoint client
  // upgrades it on first addProcessedId call). Re-canonicalize to Array here
  // so the final write surfaces the shape the tests assert and the JSON
  // serializer round-trips cleanly. addProcessedId is intentionally NOT used
  // — its Set upgrade trips assert.deepEqual against an Array.
  if (!Array.isArray(state.processed_ids)) {
    state.processed_ids = [...(state.processed_ids ?? [])];
  }

  let processedThisRun = 0;
  for (let i = 0; i < todo.length; i++) {
    const id = todo[i];
    const isLast = i === todo.length - 1;

    // Per-entry retry loop. Exponential backoff on PROVIDER_RATELIMIT only;
    // every other error class propagates immediately.
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await rebuildOne(newMemory, vault, id);
        break;
      } catch (err) {
        const isRateLimit = err instanceof ProviderError && err.class === 'PROVIDER_RATELIMIT';
        if (!isRateLimit) throw err;
        if (attempt >= maxRetries) {
          // Exhausted the budget. Persist whatever we managed to complete so
          // the next --resume picks up exactly where we left off, then throw
          // a fresh PROVIDER_RATELIMIT with --resume guidance baked in.
          try { await checkpoint.write(state); } catch (_e) { /* best-effort */ }
          throw new ProviderError({
            class: 'PROVIDER_RATELIMIT',
            provider: err.provider,
            status: err.status,
            message: `phase-3 rate-limit retries exhausted (${maxRetries} attempts) on entry "${id}": ${err.message}; pass --resume to continue from the last completed entry once the provider quota recovers`,
            retryable: true,
            cause: err,
          });
        }
        const delay = retryBaseMs > 0 ? retryBaseMs * Math.pow(2, attempt) : 0;
        if (delay > 0) await sleep(delay);
        attempt += 1;
      }
    }

    state.processed_ids.push(id);
    processedThisRun += 1;

    if (isLast) {
      // Terminal atomic write — Adv-4 contract: phase_completed AND the final
      // processed_id MUST land in the same writeCheckpoint call.
      state.phase_completed = 3;
      await checkpoint.write(state);
    } else if (processedThisRun % progressEvery === 0) {
      // Progress checkpoint — phase_completed deliberately NOT bumped here.
      await checkpoint.write(state);
    }
  }

  // Edge case: snapshot was empty or fully covered by processed_ids on resume.
  // Still need to advance phase_completed = 3 so phase 4 can run; do it in one
  // write to honour the atomic contract.
  if (todo.length === 0 && state.phase_completed !== 3) {
    state.phase_completed = 3;
    await checkpoint.write(state);
  }

  return { processed: processedThisRun };
}
