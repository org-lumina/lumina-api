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
| POST | `/api/v1/policies` | Buy a policy via relayer. Body: `{ productName, coverageAmount, buyer }` (preferred — API resolves productId hash + per-shield asset literal). Legacy `{ productId, coverageAmount, asset, buyer }` still works. Optional `Idempotency-Key` header. |
| GET | `/api/v1/policies?owner=0x...` | List policies indexed by buyer. Defaults to caller's wallet. |
| POST | `/api/v1/oracle/sign-proof` | Returns an EIP-712 signed `PriceProof` for the chosen asset, suitable to pass into `CoverRouterV2.submitTrigger(productId, policyId, oracleProof)`. Body: `{ asset: "BTC" | "ETH" }`. The signer's address must equal `LuminaOracleV2.oracleKey()` on-chain. See [`docs/architecture/ORACLE-V2.md`](https://github.com/org-lumina/LUMINA-PROTOCOL/blob/main/docs/architecture/ORACLE-V2.md) in the protocol repo. |
| GET | `/api/v1/oracle/signer` | Returns the address whose private key signs `/sign-proof` outputs. Useful for clients that want to assert against `oracleKey()` before submitting a trigger. |

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

> ⚠️ Addresses below are a snapshot — the canonical source is `GET /health`.
> Always fetch from `/health` programmatically instead of hardcoding.

| Contract | Address |
|----------|---------|
| LuminaTokenV2 | `0x8A0FDc2126eb9b0c88D17711D62713A1c06CF7Ab` |
| ClaimBond | `0x3d2F5DB2505367D00ef81c51AD3cA66159271730` |
| BondVault | `0x101F92fC506C1e60A2A0dD01eA29597EBf222d2B` |
| PolicyManagerV2 | `0xd9732A8d6Cf5266Dd896B825E78E387B7Dd2c379` |
| CoverRouterV2 | `0xebC3A783477FbD2720C024e16A8d63B8Db983D84` |
| Marketplace | `0xfaC56692c626718aC8953A3d5fAE67fac2f1Be6E` |
| USDC (mock) | `0xD944d8e5D8329994D83950872Ec210891d3Ab6AE` |

## Payment model — agent pays, relayer signs

**The agent (buyer) pays the USDC premium. The relayer pays only the gas (in ETH).**

This matches a Stripe-style flow: the API/relayer is a delivery mechanism, not a sponsor of premiums. Concretely, on every `POST /api/v1/policies` the on-chain `CoverRouterV2.purchasePolicyFor(productId, coverage, asset, buyer)` call pulls USDC from the **`buyer`** address — never from `msg.sender`. The relayer's USDC balance is irrelevant.

### Agent pre-flight checklist

Before the first call, every agent **must**:

1. Hold enough USDC at `buyer` to cover at least one premium (premiums for V5.1 testnet shields are roughly 0.3% of coverage — e.g. 3.2 USDC for 1 000 USDC of coverage on FLASHBTC1H).
2. Approve **CoverRouterV2** to spend USDC from `buyer`. Suggested allowance is `type(uint256).max`:

   ```bash
   cast send 0x63D340AE7229BB464bC801f225651341ebcD3693 \
     "approve(address,uint256)" 0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316 \
     115792089237316195423570985008687907853269984665640564039457584007913129639935 \
     --rpc-url $RPC --private-key $AGENT_PRIVATE_KEY
   ```

3. Submit the purchase via the API:

   ```bash
   curl -X POST https://<api>/api/v1/policies \
     -H "x-api-key: lk_..." -H "Idempotency-Key: <uuid>" \
     -d '{"productName":"FLASHBTC1H-001","coverageAmount":"1000000000","buyer":"0x..."}'
   ```

   `productName` is the canonical product label — the API derives the bytes32
   `productId` hash AND the per-shield `asset` literal from it. Hardcoding
   `"asset":"USDC"` for every shield reverts 7-of-9 with `InvalidAsset`.

If the agent skips step 1 or 2 the API surfaces the on-chain revert as a structured `tx_submit_failed` 400 with the underlying ERC-20 reason.

### Relayer's role

The relayer wallet (controlled by the API host) is responsible for:

- Holding **only ETH** for gas — typically a few hundredths of a Sepolia ETH is enough.
- Being authorized once via `CoverRouterV2.setRelayer(<relayer>, true)` from the proxy owner.
- Signing the `purchasePolicyFor` tx on behalf of the agent.

It does **not** need a USDC balance and does **not** need to approve anything.

## Notes for operators

- The DB at `DB_PATH` holds API keys, agents, indexed policies, and idempotency cache. Back it up — on Railway with `DB_PATH=/tmp/...` it is wiped on every redeploy. For persistence across deploys, mount a Railway Volume and point `DB_PATH` at it.
- `helmet()` + `trust proxy=1` are enabled. If you put a proxy in front of Railway, `req.ip` will reflect the client.
