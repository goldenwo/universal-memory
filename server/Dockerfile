# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches ./patches

# W6.2 image-size reduction (server/patches/mem0ai+2.4.6.patch).
# mem0ai@2.4.6 has 14 eager static imports of 11 unique unused-provider
# peerDep packages at module load. The patch converts those imports to
# fail-soft dynamic try/catch. The Dockerfile then surgically removes
# the 12 actually-skippable directories (better-sqlite3 stays — mem0
# instantiates `new SQLiteManager()` unconditionally in its `Memory`
# constructor for the history-manager subsystem, so it's a true runtime
# dep even though it's also a peerDep).
#
# W6.2-reconciliation-counts (canonical for mem0ai@2.4.6):
#   awaitImports=14    ← grep -c "await import(" on patched index.mjs
#   memPatchLogs=14    ← grep -c "[mem0-patch]"  on patched index.mjs
#   bootRuntimeWarns=12 ← grep -c "[mem0-patch]" in docker logs (better-sqlite3 ×2 succeed)
# The `sha256sum -c` step below pins the source — if mem0 publishes a
# mutated 2.4.6 tarball the build fails LOUDLY rather than silently
# applying the patch against a different source.
#
# Why surgical rm (not `npm ci --omit=peer`): the lockfile flags critical
# direct deps `openai`, `zod`, `@anthropic-ai/sdk`, `@google/genai`,
# `@qdrant/js-client-rest`, `ollama` as peer-satisfying (because mem0
# also declares them as peerDeps); `--omit=peer` would strip them.
# Surgical rm is explicit and reviews cleanly. `groq-sdk` is in the rm
# list because of a separate lockfile artifact (recorded as peer=false
# despite being declared a peerDep by mem0), which would keep it
# installed otherwise. `better-sqlite3` is a regular dep of mem0 so the
# same treatment would apply, but it's needed at runtime — see above.
#
# Reconciliation when mem0ai is bumped: see server/patches/README.md.
# CHANGELOG.md `### W6.2 — Image size reduction` is the durable reference
# for the post-upgrade boot-log change operators will see.
RUN npm ci --no-audit --no-fund \
 && computed=$(sha256sum node_modules/mem0ai/dist/oss/index.mjs | awk '{print $1}') \
 && expected=$(cat patches/mem0ai+2.4.6.source.sha256) \
 && { [ "$computed" = "$expected" ] || \
      { echo "FAIL: mem0ai source hash drift — expected=$expected got=$computed; see server/patches/README.md §Reconciliation"; exit 1; }; } \
 && npx patch-package \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/@azure/identity \
           node_modules/@azure/search-documents \
           node_modules/@cloudflare \
           node_modules/@langchain \
           node_modules/@mistralai \
           node_modules/@supabase \
           node_modules/cloudflare \
           node_modules/groq-sdk \
           node_modules/neo4j-driver \
           node_modules/pg \
           node_modules/redis \
           node_modules/@redis \
           node_modules/typescript \
           node_modules/js-tiktoken \
           node_modules/rxjs \
           node_modules/.cache \
 && find node_modules -name "*.d.ts" -delete 2>/dev/null \
 && find node_modules -name "*.map" -delete 2>/dev/null \
 && find node_modules -type d -empty -delete 2>/dev/null || true

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY mem0-mcp-http.mjs ./
COPY openapi.mjs ./
COPY lib/ ./lib/
COPY config/ ./config/
COPY entrypoint.sh ./
RUN chmod +x ./entrypoint.sh
EXPOSE 6335
USER node
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "mem0-mcp-http.mjs"]
