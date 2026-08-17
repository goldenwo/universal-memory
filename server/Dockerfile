# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches ./patches

# W6.2-lineage image-size reduction, reconciled for mem0ai@3.1.6 (#231;
# server/patches/mem0ai+3.1.6.patch). mem0 3.x made nearly every provider
# an OPTIONAL peer (npm installs none), collapsing the old 14-hunk import
# patch to ONE import hunk: `pg` — a REQUIRED peer we remove from the
# image, so its static import becomes fail-soft dynamic. The other rm
# targets below need no patch: they are never imported at runtime by the
# ESM bundle (type-only packages, natural/compromise — whose `__require`
# loader always throws under ESM and is try/catch'd — and their
# exclusive data/dep trees). `better-sqlite3` stays: mem0's default
# sqlite history manager AND UM's own counters db need it.
#
# W6.2-reconciliation-counts (canonical for mem0ai@3.1.6):
#   awaitImports=7     ← grep -c "await import(" on patched index.mjs (6 upstream + pg)
#   memPatchLogs=1     ← grep -c "[mem0-patch]"  on patched index.mjs (pg warn)
#   bootRuntimeWarns=1 ← grep -c "[mem0-patch]" in docker logs (pg is rm'd → warn fires)
# The sha256 verify below pins the PRISTINE dist/oss/index.mjs — if the
# published file mutates, the build fails LOUDLY rather than silently
# applying the patch against a different source.
#
# Why surgical rm (not `npm ci --omit=peer`): the lockfile flags critical
# direct deps (`@anthropic-ai/sdk`, `@google/genai`,
# `@qdrant/js-client-rest`, `ollama`, `better-sqlite3`) as peer-satisfying
# (mem0 also declares them as peers); `--omit=peer` would strip them.
# Surgical rm is explicit and reviews cleanly. `groq-sdk` persists as the
# known lockfile artifact (recorded peer=false, optional=true) so a fresh
# `npm ci` still installs it — it stays in the rm list. The rm list names
# the FAT, exclusively-junk directories; a few MB of orphaned micro-deps
# (bson/kareem/sift/pg-* helpers) deliberately remain rather than risk
# rm'ing a shared package (e.g. safe-stable-stringify is pino's).
#
# Reconciliation when mem0ai is bumped: see server/patches/README.md —
# that README is the durable reference for the operator-visible boot-log
# behavior (the in-repo CHANGELOG was scrubbed 2026-07-28, never
# recreated; release-facing deltas ride GH release notes).
#
# ⚠ FAIL-LOUD (v1.8.1). This chain previously ended in a bare `|| true`, which
# shell precedence applies to the WHOLE `&&` chain — so npm ci, the sha256
# pin's `exit 1`, patch-package and npm prune could all fail and still produce
# a "successful" image. v1.8.0 shipped an arm64 image whose node_modules/mem0ai
# had been removed during prune under QEMU emulation; the build went green and
# the server crash-looped on ERR_MODULE_NOT_FOUND in production. Each cleanup
# `find` is now individually tolerant, nothing else is, and a post-prune
# integrity gate re-verifies the runtime deps AFTER the destructive steps —
# the pre-prune hash check cannot see damage that prune does later.
RUN npm ci --no-audit --no-fund \
 && computed=$(sha256sum node_modules/mem0ai/dist/oss/index.mjs | awk '{print $1}') \
 && expected=$(cat patches/mem0ai+3.1.6.source.sha256) \
 && { [ "$computed" = "$expected" ] || \
      { echo "FAIL: mem0ai source hash drift — expected=$expected got=$computed; see server/patches/README.md §Reconciliation"; exit 1; }; } \
 && npx patch-package \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/@cloudflare \
           node_modules/@types \
           node_modules/afinn-165 \
           node_modules/afinn-165-financialmarketnews \
           node_modules/compromise \
           node_modules/groq-sdk \
           node_modules/mongoose \
           node_modules/natural \
           node_modules/pg \
           node_modules/stopwords-iso \
           node_modules/typescript \
           node_modules/wordnet-db \
           node_modules/.cache \
 && { find node_modules -name "*.d.ts" -delete 2>/dev/null || true; } \
 && { find node_modules -name "*.map" -delete 2>/dev/null || true; } \
 && { find node_modules -type d -empty -delete 2>/dev/null || true; } \
 && node --input-type=module -e "\
import fs from 'node:fs'; \
const need = ['mem0ai','openai','zod','@anthropic-ai/sdk','@google/genai','@qdrant/js-client-rest','ollama','better-sqlite3','pino']; \
const missing = need.filter(p => !fs.existsSync('node_modules/' + p + '/package.json')); \
if (missing.length) { console.error('FAIL post-prune integrity: missing runtime deps -> ' + missing.join(', ')); process.exit(1); } \
if (!fs.existsSync('node_modules/mem0ai/dist/oss/index.mjs')) { console.error('FAIL post-prune integrity: mem0ai/dist/oss/index.mjs is gone'); process.exit(1); } \
try { import.meta.resolve('mem0ai/oss'); } catch (e) { console.error('FAIL post-prune integrity: mem0ai/oss does not resolve -> ' + e.message); process.exit(1); } \
console.log('post-prune integrity OK (' + need.length + ' runtime deps present, mem0ai/oss resolves)');"

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY mem0-mcp-http.mjs ./
COPY openapi.mjs ./
COPY lib/ ./lib/
COPY config/ ./config/
COPY assets/ ./assets/
COPY entrypoint.sh ./
RUN chmod +x ./entrypoint.sh
EXPOSE 6335
USER node
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "mem0-mcp-http.mjs"]
