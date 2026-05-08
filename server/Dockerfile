# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches ./patches

# W6.2 image-size reduction (server/patches/mem0ai+2.4.6.patch). mem0ai@2.4.6
# eagerly static-imports 11 unused-provider peerDeps at module load. We:
#   1. install full tree (incl. devDeps) so patch-package is available
#   2. apply the patch — converts those eager imports to fail-soft dynamic
#      imports, so module load survives without those packages installed
#   3. prune devDeps
#   4. rm the unused-provider directories that the patch no longer needs
#
# Why the surgical rm (not `npm ci --omit=peer`): the lockfile flags critical
# direct deps like `openai`, `zod`, `@anthropic-ai/sdk` as peer-satisfying
# (because mem0 also declares them as peerDeps), so `--omit=peer` would
# strip them. Surgical rm is explicit about what's removed and reviews
# cleanly. groq-sdk is included in the rm list because of a separate
# lockfile artifact (peer=false) that keeps it installed otherwise.
#
# Reconciliation when mem0ai version changes: see W6.2 spec §Patch
# reconciliation procedure. CHANGELOG.md `### W6.2 — Image size reduction`
# is the durable reference.
RUN npm ci --no-audit --no-fund \
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
