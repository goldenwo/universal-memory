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
COPY lib/ ./lib/
EXPOSE 6335
USER node
CMD ["node", "mem0-mcp-http.mjs"]
