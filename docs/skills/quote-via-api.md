# Skill: Quote via REST API

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-06 (Base Sepolia 84532) but verify before use.

> 💵 **Premium is always paid in USDC**, regardless of the `asset` field. The `asset` parameter on `POST /api/v1/policies` is the **covered asset** — what the policy insures against — not the payment token. Discover it via `GET /products` (`coveredAsset` field, added 2026-05-06).

## Products at a glance

| Symbol         | coveredAsset | paymentAsset | What it insures                              |
|----------------|--------------|--------------|----------------------------------------------|
| FLASHBTC1H-001 | BTC          | USDC         | BTC rapid price crashes within 1h            |
| FLASHBTC24-001 | BTC          | USDC         | BTC rapid price crashes within 24h           |
| FLASHBTC48-001 | BTC          | USDC         | BTC rapid price crashes within 48h           |
| FLASHETH1H-001 | ETH          | USDC         | ETH rapid price crashes within 1h            |
| FLASHETH24-001 | ETH          | USDC         | ETH rapid price crashes within 24h           |
| FLASHETH48-001 | ETH          | USDC         | ETH rapid price crashes within 48h           |

All 6 products use `payoutRatioBps = 8000` (80% payout on trigger, 20% deductible).

> ⏸️ **`RATESHOCK-001`** exists on-chain but is currently **paused (`active: false`) — not purchasable.** `FLASHBTC4H-001` and `MICRODEPEG-001` are **retired / not deployed** — do not attempt to buy them.

**For**: AI Agents · **Type**: read · **Difficulty**: ⭐

---

## What this does

Same quote as `CoverRouterV2.quotePremium`, but served by the public lumina-api endpoint. No wallet, no RPC node needed — useful for off-chain calculators, dashboards, and agent strategies that should not pay gas (or rate-limit a personal RPC) just to read a price.

## Ready-to-use LLM prompt

```
You are an AI agent quoting Lumina policies (Base Sepolia, chainId 84532).

YOUR GOAL: Quote a premium without making an on-chain call.

CONTEXT:
- API base URL: https://lumina-api-production-ac85.up.railway.app
- Endpoint: GET /products/:productId/quote?cover=<int>&duration=<seconds>
- Auth: NONE (public endpoint). Rate-limited per IP.
- Returns: { premium, payout } (USDC 6-dec)

INSTRUCTIONS:
1. Identify productId (bytes32) from the catalog
2. Choose cover in 6-decimal USDC base units (e.g., 5000_000000 for $5,000)
3. GET /products/{productId}/quote?cover=5000000000&duration=86400
4. Read premium and payout from response

WHEN TO STOP:
- Success: HTTP 200 with both fields
- Block: HTTP 400 → fix productId/cover; HTTP 429 → backoff
```

## HTTP examples

### curl

```bash
PRODUCT_ID="0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd"  # FlashBTC1h
curl "https://lumina-api-production-ac85.up.railway.app/products/${PRODUCT_ID}/quote?cover=5000000000&duration=86400"
```

### TypeScript (fetch)

```typescript
const productId = '0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd' // FlashBTC1h
const cover = 5_000_000_000 // $5,000 in 6-dec USDC

const res = await fetch(
  `https://lumina-api-production-ac85.up.railway.app/products/${productId}/quote?cover=${cover}&duration=86400`,
)
const { premium, payout } = await res.json()
```

### Python (requests)

```python
import requests
product_id = '0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd'
res = requests.get(
    f'https://lumina-api-production-ac85.up.railway.app/products/{product_id}/quote',
    params={'cover': 5_000_000_000, 'duration': 86400},
)
data = res.json()
```

## Request schema

```
GET /products/:productId/quote
Query params:
  cover    — integer, 6-dec USDC base units (e.g., 5000000000 = $5,000)
  duration — seconds (informational; pricing is governed by productId itself)
```

## Response schema (success)

Shape returned by the route handler — see source.

## Error codes

| HTTP | Meaning | Retry? |
|---|---|---|
| 400 | Bad productId or cover param | No — fix payload |
| 404 | Product not configured on-chain | No |
| 429 | Rate limited | Yes, backoff |
| 500 | Server / RPC error | Yes, max 3 |

## Rate limits

`publicIpLimiter` middleware applied at mount time (`src/app.ts:21`). Per-IP, not per-key.

## Related skills

- [Quote on-chain (no API)](./quote-policy.md)
- [Buy policy as Agent](./buy-policy-agent.md)
- [Configure API client](./configure-api-client.md)

## Source

- Endpoint: `src/routes/products.ts:34` — `productsRouter.get("/:productId/quote", …)`
- Mount: `src/app.ts:21` — `app.use("/products", publicIpLimiter, productsRouter)`
- Underlying contract call: `CoverRouterV2.sol:284` — `quotePremium`
