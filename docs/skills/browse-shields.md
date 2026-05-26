# Skill: Browse the Shields catalog

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

This skill works for both humans (web interface) and AI agents (API).

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~1 minute

### What this does

Lumina has 9 parametric insurance products ("shields") on Base Sepolia. Each shield protects against a specific market event (BTC flash crash, USDT depeg, etc.). This skill shows you the full catalog so you can pick what to insure against.

### Step by step

1. **Open the Lumina app** at https://lumina-org.com/app
2. Click **"Enter as Human"** on the role selector
3. You land on `/app/human/products` — the catalog
4. Use the filter chips at the top to narrow by asset: **ALL · BTC · ETH · STABLES**
5. Each card shows: asset icon, product name, trigger condition, cover range, multiplier, and the live premium for $1,000 cover

### What you'll see when it works

A grid of 9 cards. Each card shows a green "● ACTIVE" pill (or grey "PAUSED" if the shield is temporarily disabled) and a "Get protected" button.

### Common issues

- **No premium showing** → On-chain quote is loading. Wait a couple seconds.
- **All cards greyed out as "PAUSED"** → The protocol auto-paused (LUMINA price below floor). Try later.

### What to do next

- Pick a card → **Get protected** → see [Buy policy as Human](./buy-policy-human.md)
- Want to know more about one trigger? → see [Read shield specs](./read-shield-specs.md)

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐

### What this does

Returns the catalog of all 9 V5.1 shields with their canonical metadata (productId, name, asset, contract address). Use this once at startup to build your routing table.

### Ready-to-use LLM prompt

```
You are an AI agent operating on Lumina Protocol (Base Sepolia, chainId 84532).

YOUR GOAL: Discover the available parametric insurance products.

CONTEXT:
- API base URL: https://lumina-api-production-ac85.up.railway.app
- Authentication: x-api-key header (format lk_<64hex>)
- 6 active flash shields exist (RATESHOCK-001 is paused); productId is bytes32 keccak256 of the canonical name

INSTRUCTIONS:
1. GET /products to list all active shields
2. Cache the productId list for use in quote/purchase calls
3. Match user requests to the closest shield by asset and duration

WHEN TO STOP:
- Success: response.length === 9 and you have all productIds cached
- Failure: HTTP error >= 500, retry with backoff
```

### HTTP examples

#### curl

```bash
curl https://lumina-api-production-ac85.up.railway.app/products \
  -H "x-api-key: $LUMINA_API_KEY"
```

#### TypeScript (fetch)

```typescript
const res = await fetch('https://lumina-api-production-ac85.up.railway.app/products', {
  headers: { 'x-api-key': process.env.LUMINA_API_KEY! },
})
const products = await res.json()
```

#### Python (requests)

```python
import os, requests
res = requests.get(
    'https://lumina-api-production-ac85.up.railway.app/products',
    headers={'x-api-key': os.environ['LUMINA_API_KEY']},
)
products = res.json()
```

### Response schema

Returns an array of product entries (shape from `src/services/products.ts` — see source).

### Error codes

| HTTP | Meaning | Retry? |
|---|---|---|
| 401 | missing/invalid x-api-key | No |
| 429 | rate limited | Yes, backoff |
| 500 | server error | Yes, max 3 |

### Related skills

- [Read shield specs](./read-shield-specs.md)
- [Quote policy on-chain](./quote-policy.md)
- [Quote via API](./quote-via-api.md)

## Source

- API endpoint: `src/routes/products.ts:10` — `productsRouter.get("/")`
- Mount: `src/app.ts:21` — `app.use("/products", publicIpLimiter, productsRouter)`
- Shield contracts: `LUMINA-PROTOCOL/src/products/{Flash*Shield*,MicroDepegShield,RateShockShield}.sol`
