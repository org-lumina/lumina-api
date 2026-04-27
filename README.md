# Lumina API

REST API for the Lumina Protocol V5.1 deployment on **Base Sepolia (chainId 84532)**.
Express 4 + TypeScript + ethers v6 + SQLite. Designed for deployment on Railway.

## Features

- **Public read endpoints** for products, policies, quotes — no key required
- **Authenticated relayer pattern** (`POST /api/v1/policies`) — agents pay nothing in ETH; the API relayer signs `purchasePolicyFor(...)` on-chain
- **API keys** stored as SHA-256 hashes (plaintext shown once at issue), max **3 active per wallet**
- **Tier-based rate limiting** (`free`: 10 req/min, `paid`: 100 req/min)
- **Idempotency** via `Idempotency-Key` header on writes
- **Strict validation** (zod) and structured logging (pino)

## Quick start

```bash
# 1. Install deps
npm install

# 2. Configure env
cp .env.example .env
# fill in RPC_URL, RELAYER_PRIVATE_KEY, ADMIN_TOKEN

# 3. Run dev server
npm run dev

# 4. Smoke test against the live Sepolia deploy (read-only)
npm run smoke

# 5. Run unit + integration tests
npm test
```

## Deployment to Railway

1. Push the repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo → org-lumina/lumina-api**.
3. Set the env vars from `.env.example` in the Railway dashboard. **`RELAYER_PRIVATE_KEY`** and **`ADMIN_TOKEN`** are secrets.
4. Health check is configured via `railway.toml` to hit `/health`.
5. Fund the relayer wallet with Base Sepolia ETH so it can submit txs.

> **Important**: the relayer wallet must be authorized in `CoverRouter`. From the deployer, call:
> ```solidity
> CoverRouterV2(0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316).setRelayer(<RELAYER_ADDRESS>, true);
> ```
> The API will refuse to submit purchase txs and return `503 relayer_unauthorized` until this is done.

## Endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service status, RPC connectivity, relayer balance, contract addresses |
| GET | `/products` | List all 9 shields registered in CoverRouter |
| GET | `/products/:productId` | Single product config (productId is bytes32 hex) |
| GET | `/products/:productId/quote?coverageAmount=N` | Quote premium + payout for a coverage amount in USDC base units |
| GET | `/policies/:productId/:policyId` | Read on-chain policy by composite key |

### Authenticated (`x-api-key: lk_<...>`)

| Method | Path | Tier limits |
|--------|------|-------------|
| POST | `/api/v1/policies` | Buy a policy via relayer. Body: `{ productId, coverageAmount, asset, buyer }`. Optional `Idempotency-Key` header. |
| GET | `/api/v1/policies?owner=0x...` | List policies indexed by buyer. Defaults to caller's wallet. |

### Admin (`x-admin-token`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/keys/generate` | Issue a new API key for a wallet. Body: `{ wallet, label? }`. Plaintext returned **once**. |
| DELETE | `/api/v1/keys/:id` | Revoke a key by id |

## Project structure

```
src/
  app.ts             — Express app composition
  server.ts          — entry point
  routes/            — Express routers (health, products, policies, keys)
  services/          — business logic (products, policies, keys)
  middlewares/       — auth, admin, error, rateLimit
  utils/             — config (zod), logger (pino), ethers (provider/relayer/contracts)
  db/                — SQLite schema + queries
abis/                — forge-built artifacts copied from LUMINA-PROTOCOL/out
tests/
  unit/              — pure unit tests
  integration/       — supertest-driven app tests with ethers mocked
scripts/
  smoke.ts           — read-only smoke test against the live Sepolia deploy
Dockerfile           — multi-stage production build
railway.toml         — Railway deploy config
```

## Smart contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| LuminaTokenV2 | `0x17db45491561F7538e4E14449DCC34799758465D` |
| ClaimBond | `0x5304f6732a51995651f1B666525CFeC5Af74A541` |
| BondVault | `0x1747CDA7F84BEc4f2002ff0dcdb3c51c1C02cf6A` |
| PolicyManagerV2 | `0x04f94Bc24aAA87aDFA643EE1e55a35C683f30804` |
| CoverRouterV2 | `0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316` |
| Marketplace | `0x863A7fB4A676106db4b03449b01AC5615c6C9D51` |
| USDC (mock) | `0x63D340AE7229BB464bC801f225651341ebcD3693` |

## Notes for operators

- The DB at `DB_PATH` holds API keys, agents, indexed policies, and idempotency cache. Back it up.
- `purchasePolicyFor` requires the buyer to have approved USDC to CoverRouter beforehand. The API does **not** do this approval — agents must approve USDC themselves (or use a meta-tx flow added later).
- `helmet()` + `trust proxy=1` are enabled. If you put a proxy in front of Railway, `req.ip` will reflect the client.
