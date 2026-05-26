# Skill: Buy policy as Agent (via API)

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

**For**: AI Agents · **Type**: write · **Difficulty**: ⭐⭐

---

## What this does

Agent posts an authenticated request to the Lumina API. The API's relayer signs and sends `purchasePolicyFor` on-chain — the agent does NOT pay gas, does NOT need a wallet UI, and does NOT need to approve USDC themselves. The relayer's wallet is a pre-authorized address registered via `CoverRouterV2.setRelayer`.

## ⚡ TL;DR — pass `productName` and the API resolves everything

SDK 0.3.0+ and the latest `/api/v1/policies` accept `productName` (a canonical
product label) and auto-resolve both the bytes32 `productId` AND the per-shield
`asset` literal. **Do this** unless you have a specific reason not to.

```ts
const policy = await lumina.policies.purchase({
  productName: 'FLASHBTC1H-001',   // SDK derives productId hash + asset='BTC'
  buyer: '0xYourWalletAddress',
  coverageAmount: '100000000',      // $100 in 6-dec USDC (on-chain minimum)
})
```

## ⚠️ The asset is per-shield, not a global "USDC"

Every shield validates `params.asset` against a **hardcoded literal**.
Hardcoding `asset: 'USDC'` for the flash shields reverts with
`InvalidAsset(bytes32("USDC"))` (FlashBTC* expect `BTC`, FlashETH* expect
`ETH`). The payment token is always USDC; the asset is the *what-it-covers* tag.

| Name (keccak input) | productId (bytes32) | Expected `asset` | Duration |
|---|---|---|---|
| `FLASHBTC1H-001` | `0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd` | `BTC` | 1 h |
| `FLASHBTC24-001` | `0xdc5bcc7d6e2e9ca89d46d4f6672db80985d5e86509243dcca44a4e87d871a7b9` | `BTC` | 24 h |
| `FLASHBTC48-001` | `0xb630608784616003f974941232dd618003e5a182176cc14010db95cda2ab1ee8` | `BTC` | 48 h |
| `FLASHETH1H-001` | `0x6cedbccfc3dc131aec7bdd9a9761ac0a8e665daa87763328ffca700f9b678915` | `ETH` | 1 h |
| `FLASHETH24-001` | `0xcc03aef924fc23ad01e6391af37bcfdb9ad40cce7c76218e51be62c38167f240` | `ETH` | 24 h |
| `FLASHETH48-001` | `0x89a37df7cf246013d58a6b121e57b1e6417cea854b354183025ed0b41663712d` | `ETH` | 48 h |

> ⏸️ `RATESHOCK-001` (`0x8ae1e4140e1713abfdbbba9bc4cbf4afdc0d60e3f98687bd02d6dad5a60a347f`, asset `USDC`) exists on-chain but is **paused (`active: false`) — purchases revert.** `FLASHBTC4H-001` and `MICRODEPEG-001` are **retired / not deployed.**

Full reference + failure modes: <https://docs.lumina-org.com/agents/products-and-assets>.

⚠️ The 20-byte addresses you may see in old docs were a documentation bug — `productId` is **always** 32 bytes (a hash), not an address.

## Ready-to-use LLM prompt

```
You are an AI agent buying parametric insurance on Lumina Protocol
(Base Sepolia, chainId 84532) via the relayer pattern.

YOUR GOAL: Purchase a policy on the agent's behalf.

CONTEXT:
- API base URL: https://lumina-api-production-ac85.up.railway.app
- Endpoint: POST /api/v1/policies (authenticated)
- Auth header: x-api-key: lk_<64hex>  (your agent key, see generate-api-key.md)
- The relayer pays gas. You pay only the premium in USDC.

PREREQUISITES:
1. You have a valid x-api-key bound to your wallet (see generate-api-key.md)
2. The protocol is not auto-paused (check via /health)
3. You know the productName — pick from the table in this skill (e.g. "FLASHBTC24-001")
4. The buyer wallet holds USDC and has approved the relayer-side spender

INSTRUCTIONS:
1. POST /api/v1/policies with productName + coverageAmount + buyer:
     {
       "productName":    "FLASHBTC24-001"  (canonical name; API derives productId hash AND per-shield asset),
       "coverageAmount": "uint string in USDC base units (6 dec)",
       "buyer":          "0x..."  (20-byte address — wallet that consents to pay premium)
     }
   The asset literal is per-shield (BTC for FlashBTC, ETH for FlashETH).
   DO NOT hardcode `"asset": "USDC"` for the flash shields — that reverts
   with InvalidAsset(bytes32("USDC")).
   When you omit `asset`, the API resolves the correct literal from the registry.
   Optional header: Idempotency-Key: <uuidv4> (strongly recommended for retries).
2. On 201 response, persist the returned policyId for tracking
3. On 4xx, fix the payload and retry
4. On 5xx, exponential backoff (max 3 attempts)

WHEN TO STOP:
- Success: HTTP 201 with policyId in response body
- Block: HTTP 401 (key) or 400 (bad payload) → escalate to operator
- Retry: HTTP 429 (rate-limit) or 5xx
```

## HTTP examples

### curl (copy-paste ready, $100 cover on FLASHBTC24-001)

```bash
curl -X POST https://lumina-api-production-ac85.up.railway.app/api/v1/policies \
  -H "x-api-key: $LUMINA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "productName":    "FLASHBTC24-001",
    "coverageAmount": "100000000",
    "buyer":          "0xYourWalletAddress"
  }'
```

> `coverageAmount: "100000000"` = $100 (USDC has 6 decimals → multiply USD by 1_000_000). **Minimum $100 enforced on-chain** by `CoverRouterV2`; anything below reverts with `coverage_below_minimum`.
> `productName` is the canonical product label — the API derives the bytes32 `productId` hash AND the per-shield `asset` literal from it (FlashBTC → `BTC`, FlashETH → `ETH`).
> `buyer` MUST be the wallet that consents to pay the premium — the relayer pays gas, the buyer's wallet provides the USDC.

### TypeScript (ethers v6, recommended)

```typescript
import { randomUUID } from 'crypto'

const res = await fetch('https://lumina-api-production-ac85.up.railway.app/api/v1/policies', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.LUMINA_API_KEY!,
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID(),
  },
  body: JSON.stringify({
    productName: 'FLASHBTC24-001',  // API resolves productId hash + asset='BTC'
    coverageAmount: '100000000',     // $100 in USDC base units (on-chain minimum)
    buyer: '0xYourWalletAddress',
  }),
})

const result = await res.json()
console.log('policyId:', result.policy?.id)
```

### Lumina SDK (smallest possible call)

```typescript
import { LuminaClient } from '@lumina-org/sdk'   // v0.3.0+

const lumina = new LuminaClient({ apiKey: process.env.LUMINA_API_KEY! })

const policy = await lumina.policies.purchase({
  productName: 'FLASHBTC24-001',  // SDK resolves productId hash + asset='BTC'
  buyer: '0xYourWalletAddress',
  coverageAmount: '100000000',
})

console.log('policyId:', policy.policyId)
```

### viem variant of the asset bytes32 (ONLY if you must override the auto-resolved literal)

The API resolves `asset` for you when `productName` is supplied. Build one yourself only when intentionally bypassing the registry. Pass the **covered asset** (BTC/ETH), NOT the premium token:

```typescript
import { padHex, toHex } from 'viem'
// FlashBTC* → 'BTC'
const BTC_BYTES32  = padHex(toHex('BTC'),  { size: 32, dir: 'right' })  // 0x4254430000…
// FlashETH* → 'ETH'
const ETH_BYTES32  = padHex(toHex('ETH'),  { size: 32, dir: 'right' })  // 0x4554480000…
```

### Python (requests)

```python
import os, uuid, requests

res = requests.post(
    'https://lumina-api-production-ac85.up.railway.app/api/v1/policies',
    headers={
        'x-api-key': os.environ['LUMINA_API_KEY'],
        'Idempotency-Key': str(uuid.uuid4()),
    },
    json={
        # API derives productId hash AND per-shield asset literal from productName.
        'productName': 'FLASHBTC24-001',
        'coverageAmount': '100000000',
        'buyer': '0xYourWalletAddress',
    },
)
data = res.json()
```

## Request schema

```json
{
  "productName": "string — canonical name (e.g. \"FLASHBTC24-001\"). Optional alias for productId; the API derives the bytes32 hash and the asset literal from it.",
  "productId": "string — bytes32 hex (regex /^0x[0-9a-fA-F]{64}$/), keccak256 of the canonical product name. Required when productName is omitted.",
  "coverageAmount": "string — positive integer in USDC base units (6 decimals → multiply USD by 1_000_000). String to avoid JS number overflow.",
  "asset": "string — bytes32 hex. OPTIONAL since 2026-05-06: if omitted, the API auto-resolves the per-shield literal from the registry (BTC for FlashBTC*, ETH for FlashETH*). Override only when intentional.",
  "buyer": "string — 0x-prefixed 20-byte address; the wallet that holds USDC and consents to pay the premium."
}
```

At least one of `productName` or `productId` must be supplied. Optional
header: `Idempotency-Key: <uuidv4>` — strongly recommended. Replays return
the same response without double-spending.

### Field deep-dive

- `productName` is the **preferred input**. The API derives the keccak256 productId AND the per-shield asset literal from it; you cannot accidentally pair `FLASHBTC1H-001` with `USDC`.
- `productId` is the **bytes32 keccak256 of the canonical product name** — see the table above. Required only when `productName` is absent.
- `coverageAmount` is in **USDC base units** (USDC has 6 decimals). **Minimum: $100 = `"100000000"`** (enforced on-chain by `CoverRouterV2`: `coverageAmount >= 100e6`, else `InvalidCoverage`). For $1,000 send `"1000000000"`. Always pass as a string to preserve precision in JSON.
- `asset` is **optional**. When omitted the API resolves it from the registry (FlashBTC* → `BTC`, FlashETH* → `ETH`). To override, pass a bytes32 hex; sending the wrong literal reverts with `InvalidAsset(bytes32)`.
- `buyer` is the **wallet that consents to pay the premium**. The relayer pays gas; this wallet provides the USDC.

## Response schema (201)

Includes the on-chain `policyId` and the relayer tx hash for verification. Shape:

```json
{
  "ok": true,
  "policy": {
    "id": "<onchain policyId>",
    "productId": "0x…",
    "buyer": "0x…",
    "coverageAmount": "100000000",
    "premiumPaid": "<USDC base units>",
    "txHash": "0x…"
  }
}
```

## Error codes

| HTTP | Code | Why | Retry? |
|---|---|---|---|
| 400 | `validation_error` | productId / cover / asset / buyer wrong shape | No |
| 401 | `missing_api_key` | header absent | No |
| 401 | `invalid_api_key` | revoked / malformed | No |
| 422 | `shield_paused` | shield.paused or protocol auto-paused | Maybe later |
| 422 | `exceeds_capacity` | BondVault.availableCapacityUSD insufficient | Maybe later |
| 429 | `rate_limit` | tier cap hit | Yes, backoff |
| 500 | `server_error` | RPC down / gas spike | Yes, max 3 |

## Rate limits

`apiLimiter` middleware applied per agent identity (NOT per IP). Audit fix #33 RL-1 ensures `req.agent.id` is set BEFORE the limiter runs.

## Important: relayer vs direct

This skill uses the relayer (agent UX). For human direct-from-wallet, see [buy-policy-human](./buy-policy-human.md). Both end up calling `CoverRouterV2`:

- Human → `purchasePolicy(...)` (msg.sender = buyer)
- Agent → relayer calls `purchasePolicyFor(productId, cover, asset, buyer)` where buyer = agent's wallet

The on-chain effect is identical; only `tx.origin` differs.

## Related skills

- [Generate API key](./generate-api-key.md)
- [Quote via API](./quote-via-api.md)
- [Track policies](./track-policies.md)

## Source

- API endpoint: `src/routes/policies.ts` — `policiesAuthRouter.post("/", authMiddleware, apiLimiter, …)`
- Mount: `src/app.ts` — `app.use("/api/v1/policies", authIpLimiter, policiesAuthRouter)`
- Auth: `src/middlewares/auth.ts` — `authMiddleware` (validates `lk_…` keys)
- Underlying contract: `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol` — `purchasePolicyFor` (relayer-only)
