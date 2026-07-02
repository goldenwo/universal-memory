# `server/patches/` — patch-package vendored patches

This directory holds patches that `patch-package` applies to vendored
`node_modules/` upstream sources at Docker-build time. Each patch is
version-pinned by filename (`pkg+x.y.z.patch`) and accompanied by a
SHA-256 source-hash pin (`pkg+x.y.z.source.sha256`) that the Dockerfile
verifies before applying the patch. Hash drift = mem0 tarball mutated;
build fails loud.

## Files

- `mem0ai+2.4.6.patch` — 15 hunks against
  `node_modules/mem0ai/dist/oss/index.mjs`:
  - **W6.2 image-size reduction (14 hunks).** Converts eager static
    imports of 11 unique unused-provider peerDep packages (12 import
    statements skippable, 2 of better-sqlite3 retained because mem0
    unconditionally instantiates `SQLiteManager` for history) to
    fail-soft dynamic try/catch with `[mem0-patch] <pkg> not installed
    (peer-skipped) — expected on boot per W6.2` warn lines.
  - **Legacy-qdrant 400 "already exists" tolerance (1 hunk).** qdrant
    ≤1.7 returns HTTP 400 — not 409 — for a duplicate
    `createCollection`; mem0ai's `Qdrant.ensureCollection` catches only
    409/401/403, so against a legacy server with an existing collection
    (e.g. the Pi's `y0mg/qdrant-raspberry-pi` v1.7.3, used because the
    official image SIGABRTs on that host) init throws and the HTTP
    server never binds. The hunk adds a guarded case: a 400 whose body
    (`error.data.status.error`) says "already exists" is treated like a
    409 (falls into the existing dimension-verify branch); genuine 400s
    still throw. Contract-locked by
    `server/test/patch-contract.test.mjs`.
- `mem0ai+2.4.6.source.sha256` — single-line SHA-256 of the upstream
  `dist/oss/index.mjs` for mem0ai@2.4.6. Verified at Docker build time
  via `sha256sum` (see `server/Dockerfile`).

## Reconciliation procedure (when `server/package.json` bumps `mem0ai`)

The patch is **version-pinned**. A `mem0ai` version bump invalidates
both the `.patch` file and the `.sha256` pin and requires the procedure
below. The build-time hash-verify step ensures this can NEVER drift
silently — a mismatched hash fails the build with
`FAIL: mem0ai source hash drift`.

### Canonical counts (mem0ai@2.4.6)

The W6.2 patch produces these expected verification counts. **A
reconciliation pass MUST update all three to whatever the new version
emits:**

| Counter | Value | grep |
|---|---|---|
| `awaitImports` | **14** | `grep -c "await import(" node_modules/mem0ai/dist/oss/index.mjs` |
| `memPatchLogs` | **14** | `grep -c "[mem0-patch]" node_modules/mem0ai/dist/oss/index.mjs` |
| `bootRuntimeWarns` | **12** | `docker compose logs memory-server \| grep -c "[mem0-patch]"` (better-sqlite3 ×2 succeed at boot, leaving 12 fail-soft warns) |

### Step-by-step

1. **Bump `mem0ai` in `server/package.json`** to the new version
   (e.g., `2.5.0`) and run `npm install` to regenerate `package-lock.json`.

2. **Pre-flight: TLA-support probe.** Confirm the new emitted ESM
   accepts the dynamic-import shape we use:
   ```bash
   cp node_modules/mem0ai/dist/oss/index.mjs .tmp-tla-probe.mjs
   sed -i.bak 's|^import { Groq } from "groq-sdk";|let Groq; try { ({ Groq } = await import("groq-sdk")); } catch {}|' .tmp-tla-probe.mjs
   node --input-type=module -e "import('./.tmp-tla-probe.mjs').then(()=>console.log('OK')).catch(e=>{console.error('FAIL:',e.message);process.exit(1)})"
   rm .tmp-tla-probe.mjs .tmp-tla-probe.mjs.bak
   ```
   On FAIL: the new emitted bundle changed shape; fall back to option A
   (stubs) per spec, OR find the equivalent dynamic-import shape.

3. **Detect new statically-imported provider packages.** Compare the
   import list against the canonical list above:
   ```bash
   grep -nE "^import" node_modules/mem0ai/dist/oss/index.mjs > /tmp/new-imports.txt
   diff <(grep -E "^import" node_modules/mem0ai/dist/oss/index.mjs) <(git show HEAD:server/patches/mem0ai+2.4.6.patch | grep "^-import" | sed 's/^-//')
   ```
   New static imports of unused-provider packages need to be added to
   the patch shape table (see "Patch shape table" below).

4. **Author the new patch.** Apply each unused-provider import
   conversion using one of the three shapes (named, default, sub-path).
   Use the shape table at the bottom of this file. **Special-case any
   module-init destructure pattern** (`var { X } = patchedName;`
   immediately after a patched import) — initialize the variable to
   `{}` in the catch block to keep the destructure non-throwing. The
   only example in mem0@2.4.6 is `pg`:
   ```js
   let pkg = {}; try { pkg = (await import("pg")).default; } catch (e) { console.warn(...); }
   var { Client } = pkg;  // module-init destructure — needs pkg = {} default
   ```

5. **Re-apply the legacy-qdrant 400 hunk** to the new version's
   `Qdrant.ensureCollection` (see Files above), then **generate the
   patch file** via `npx patch-package mem0ai`. If upstream has widened
   its own catch to handle a 400 "already exists", drop the hunk and
   its contract test instead.

6. **Verify the patch applies cleanly with the expected counts** before
   step 7. **This order is critical: the hash-pin is the lock, not a
   checkpoint** — pinning before verifying could silently lock a broken
   patch to the new source.
   ```bash
   rm -rf node_modules && npm ci --prefer-offline && npx patch-package
   awaitImports=$(grep -c "await import(" node_modules/mem0ai/dist/oss/index.mjs)
   memPatchLogs=$(grep -c "\[mem0-patch\]" node_modules/mem0ai/dist/oss/index.mjs)
   eagerLeft=$(grep -cE "^import \{?.*from \"(groq-sdk|@mistralai/mistralai|better-sqlite3|cloudflare|@supabase/supabase-js|@langchain/core|@azure/identity|@azure/search-documents|neo4j-driver|pg|redis)\"" node_modules/mem0ai/dist/oss/index.mjs)
   # All three must match the new canonical counts; eagerLeft must be 0
   echo "awaitImports=$awaitImports memPatchLogs=$memPatchLogs eagerLeft=$eagerLeft"
   ```

7. **Bump the source-hash pin** AFTER step 6 passes:
   ```bash
   sha256sum node_modules/mem0ai/dist/oss/index.mjs | awk '{print $1}' > server/patches/mem0ai+<NEW_VERSION>.source.sha256
   ```

8. **Update the canonical counts table at the top of this README** to
   match what the new mem0 version emits.

9. **Update the `W6.2-reconciliation-counts` block in `server/Dockerfile`**
   to the new counts.

10. **Update `CHANGELOG.md`** under a new `### W6.2 — Image size reduction`
    entry: note the count of patched imports if changed.

11. **Cleanup prior-version artifacts** once green in CI:
    ```bash
    git rm server/patches/mem0ai+<OLD>.patch server/patches/mem0ai+<OLD>.source.sha256
    ```

## Known reconciliation hazards

Two hazards materialized when authoring the original W6.2 patch and
should be assumed for any future mem0 reconciliation:

1. **Module-init destructures of patched names.** If a patched import
   is followed at module top-level by `var { Foo } = patchedName;` (or
   any synchronous use that would throw on `undefined`), the catch
   block must initialize the variable to a safe default (typically
   `{}`) so the destructure is non-throwing at module load. Grep for
   the pattern:
   ```bash
   for varname in <list of patched names>; do
     grep -nE "^var \{[^}]*\} = ${varname}[;]" node_modules/mem0ai/dist/oss/index.mjs
   done
   ```
   In mem0@2.4.6 only `pg` triggers this; future versions might add
   more.

2. **`npm ci --omit=peer` is unsafe with this lockfile.** The lockfile
   flags critical direct deps (openai, zod, @anthropic-ai/sdk,
   @google/genai, @qdrant/js-client-rest, ollama) as peer-satisfying
   because mem0 also declares them as peerDeps. `--omit=peer` would
   strip them. The Dockerfile uses `npm prune --omit=dev` followed by
   surgical `rm -rf` of unused-provider directories; **this order
   matters because `npm prune` after `rm` reinstalls the tree to match
   the lockfile**. See `server/Dockerfile` for the canonical sequence.

## Patch shape table (use to author new hunks)

| Original shape | Pattern | Patched form |
|---|---|---|
| Named (`{ X }`) | `import { X } from "pkg";` | `let X; try { ({ X } = await import("pkg")); } catch (e) { console.warn("[mem0-patch] pkg not installed (peer-skipped) — expected on boot per W6.2"); }` |
| Named with rename | `import { X as Y } from "pkg";` | `let Y; try { ({ X: Y } = await import("pkg")); } catch (e) { console.warn("[mem0-patch] pkg ..."); }` |
| Default | `import X from "pkg";` | `let X; try { X = (await import("pkg")).default; } catch (e) { console.warn("[mem0-patch] pkg ..."); }` |
| Multi-line named | `import {\n A, B, C\n} from "pkg";` | `let A, B, C; try { ({ A, B, C } = await import("pkg")); } catch (e) { console.warn("[mem0-patch] pkg ..."); }` |
| Module-init destructure follow-up | `let X; try { X = (await import("pkg")).default; ...` followed by `var { Y } = X;` | Initialize `let X = {}` in declaration so destructure is non-throwing |

The `— expected on boot per W6.2` suffix is intentional: it makes the
warn-line grep-able to `CHANGELOG.md ### W6.2 — Image size reduction`,
giving operators a self-documenting trail when they tail logs.

## Anti-goals (preserved from W6.2 spec)

- **No runtime patch-package dep.** `patch-package` is `devDependencies`
  only; the Dockerfile installs the full tree (incl. devDeps) at build
  time, applies the patch, then `npm prune --omit=dev`.
- **No `postinstall` hook in `server/package.json`.** Host installs
  must NOT auto-patch; the Dockerfile is the canonical patch site.
  Tests that require the patched mem0 invoke `npx patch-package`
  explicitly via the npm test script or CI step.
