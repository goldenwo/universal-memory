# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

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
