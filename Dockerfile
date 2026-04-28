# syntax=docker/dockerfile:1.6
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci || npm install

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# gosu lets a root-owned entrypoint drop privileges to a non-root user AFTER
# fixing volume permissions at boot. Railway mounts persistent volumes owned
# by root; without this dance, the lumina user cannot write to /data and
# better-sqlite3 fails with SQLITE_CANTOPEN.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 lumina
COPY --from=build --chown=lumina:lumina /app/node_modules ./node_modules
COPY --from=build --chown=lumina:lumina /app/dist ./dist
COPY --from=build --chown=lumina:lumina /app/abis ./abis
COPY --from=build --chown=lumina:lumina /app/package.json ./package.json
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
