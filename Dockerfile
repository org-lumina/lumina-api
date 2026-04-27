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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 lumina
COPY --from=build --chown=lumina:lumina /app/node_modules ./node_modules
COPY --from=build --chown=lumina:lumina /app/dist ./dist
COPY --from=build --chown=lumina:lumina /app/abis ./abis
COPY --from=build --chown=lumina:lumina /app/package.json ./package.json
USER lumina
EXPOSE 3000
CMD ["node", "dist/server.js"]
