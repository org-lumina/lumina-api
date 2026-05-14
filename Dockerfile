# syntax=docker/dockerfile:1.6
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci || npm install
# [Sprint K] indexer/ is a sub-package with its own deps (Ponder, viem, hono).
# Install separately so Docker layer caching doesn't invalidate the API
# install when only indexer code changes.
COPY indexer/package.json indexer/package-lock.json* ./indexer/
RUN cd indexer && (npm ci || npm install)

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/indexer/node_modules ./indexer/node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# gosu lets a root-owned entrypoint drop privileges to a non-root user AFTER
# fixing volume permissions at boot. Railway mounts persistent volumes owned
# by root; without this dance, the lumina user cannot write to /data and
# better-sqlite3 fails with SQLITE_CANTOPEN.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 lumina
COPY --from=build --chown=lumina:lumina /app/node_modules ./node_modules
COPY --from=build --chown=lumina:lumina /app/dist ./dist
COPY --from=build --chown=lumina:lumina /app/abis ./abis
COPY --from=build --chown=lumina:lumina /app/package.json ./package.json
# [Sprint K] indexer artifacts: source TS (Ponder runs via TS at runtime, not
# pre-compiled) + node_modules + ABI JSON. Ponder doesn't have a `npm run build`
# step — it transpiles on the fly with esbuild internally.
COPY --from=build --chown=lumina:lumina /app/indexer ./indexer
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# [Sprint BB.1] Reactivated `concurrent` (boots API + Ponder indexer side-by-side
# via the `concurrently` runner). PR #30 superjson@2.2.0 override is in place;
# this verifies the indexer no longer crashes on startup.
CMD ["npm", "run", "concurrent"]
