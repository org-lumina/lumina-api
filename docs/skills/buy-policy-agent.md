# Skill: Buy policy as Agent (via API)

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

**For**: AI Agents · **Type**: write · **Difficulty**: ⭐⭐

---

## What this does

Agent posts an authenticated request to the Lumina API. The API's relayer signs and sends `purchasePolicyFor` on-chain — the agent does NOT pay gas, does NOT need a wallet UI, and does NOT need to approve USDC themselves. The relayer's wallet is a pre-authorized address registered via `CoverRouterV2.setRelayer`.

## Ready-to-use LLM prompt

```
You are an AI agent buying parametric insurance on Lumina Protocol
(Base Sepolia, chainId 84532) via the relayer pattern.

YOUR GOAL: Purchase a policy on the agent's behalf.

CONTEXT:
- API base URL: https://lumina-api-production-ac85.up.railway.app
- Endpoint: POST /api/v1/policies (authenticated)
- Auth header: x-api-key: lk_<64hex>  (your agent key, see generate-api-key.md)
- The relayer pays gas. You pay only the premium in USDC (held by relayer/agent
  per the API's funding model — see lumina-api README).

PREREQUISITES:
1. You have a valid x-api-key bound to your wallet
2. The protocol is not auto-paused (check via /products or RPC)
3. You know the productId (bytes32) of the shield you want
4. The buyer wallet holds USDC and has approved the relayer-side spender

INSTRUCTIONS:
1. POST /api/v1/policies with all four required fields:
     {
       "productId":      "0x..."  (bytes32 hex — 64 hex chars),
       "coverageAmount": "uint string in USDC base units (6 dec)",
       "asset":          "0x..."  (bytes32 hex — encodeBytes32String("USDC")),
       "buyer":          "0x..."  (20-byte address — wallet that consents to pay premium)
     }
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

### curl (copy-paste ready, $50 cover on FlashBTC1h)

```bash
curl -X POST https://lumina-api-production-ac85.up.railway.app/api/v1/policies \
  -H "x-api-key: $LUMINA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "productId": "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd",
    "coverageAmount": "50000000",
    "asset": "0x5553444300000000000000000000000000000000000000000000000000000000",
    "buyer": "0xYourWalletAddress"
  }'
```

> `coverageAmount: "50000000"` = $50 (USDC has 6 decimals → multiply USD by 1_000_000).
> `asset` is `ethers.encodeBytes32String("USDC")` — the right-padded 32-byte hex of the ASCII string `USDC`.
> `buyer` MUST be the wallet that consents to pay the premium — the relayer pays gas, the buyer's wallet provides the USDC.

### TypeScript (fetch + viem)

```typescript
import { padHex, toHex } from 'viem'
import { randomUUID } from 'crypto'

// asset: bytes32 of "USDC" — encodeBytes32String equivalent
const USDC_BYTES32 = padHex(toHex('USDC'), { size: 32, dir: 'right' })
// → 0x5553444300000000000000000000000000000000000000000000000000000000

const res = await fetch('https://lumina-api-production-ac85.up.railway.app/api/v1/policies', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.LUMINA_API_KEY!,
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID(),
  },
  body: JSON.stringify({
    productId: '0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd', // FlashBTC1h
    coverageAmount: '50000000',  // $50 in USDC base units (×10^6); string to avoid JS number overflow
    asset: USDC_BYTES32,         // bytes32 of "USDC"
    buyer: '0xYourWalletAddress', // wallet that consents to pay the premium
  }),
})

const result = await res.json()
```

If you use ethers v6, the `asset` value is simply:

```typescript
import { encodeBytes32String } from 'ethers'
const USDC_BYTES32 = encodeBytes32String('USDC')
// → 0x5553444300000000000000000000000000000000000000000000000000000000
```

### Python (requests)

```python
import os, uuid, requests
from eth_abi.packed import encode_packed  # or use a static constant

# asset: bytes32 of "USDC" (right-padded). Static value works just as well:
USDC_BYTES32 = '0x5553444300000000000000000000000000000000000000000000000000000000'

res = requests.post(
    'https://lumina-api-production-ac85.up.railway.app/api/v1/policies',
    headers={
        'x-api-key': os.environ['LUMINA_API_KEY'],
        'Idempotency-Key': str(uuid.uuid4()),
    },
    json={
        'productId': '0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd',
        'coverageAmount': '50000000',          # $50 in USDC base units (str preserves precision)
        'asset': USDC_BYTES32,                 # bytes32 of "USDC"
        'buyer': '0xYourWalletAddress',        # wallet paying the premium
    },
)
data = res.json()
```

## Request schema

```json
{
  "productId": "string — bytes32 hex (regex /^0x[0-9a-fA-F]{64}$/), keccak256 of the canonical product name (e.g., FlashBTC1h)",
  "coverageAmount": "string — positive integer in USDC base units (6 decimals → multiply USD by 1_000_000). Use string to avoid JS number overflow.",
  "asset": "string — bytes32 hex; for USDC use encodeBytes32String(\"USDC\") = 0x5553444300000000000000000000000000000000000000000000000000000000",
  "buyer": "string — 0x-prefixed 20-byte address; the wallet that holds USDC and consents to pay the premium. The relayer pays gas; this wallet provides the USDC."
}
```

Optional header: `Idempotency-Key: <uuidv4>` — strongly recommended. The same key replays the same response without double-spending.

### Field deep-dive

- `coverageAmount` is in **USDC base units** (USDC has 6 decimals). For $50 coverage send `"50000000"`. For $5,000 send `"5000000000"`. Always pass as a string to preserve precision in JSON.
- `asset` is a **bytes32 hex string**, not an address. For USDC it's `ethers.encodeBytes32String("USDC")` (or with viem: `padHex(toHex('USDC'), { size: 32, dir: 'right' })`). Both produce `0x5553444300000000000000000000000000000000000000000000000000000000`.
- `buyer` is the **wallet that consents to pay the premium**. The relayer pays the gas for the on-chain `purchasePolicyFor` call, but the USDC for the premium comes out of the `buyer` wallet's balance/allowance. Ensure that wallet holds enough USDC and has approved the appropriate spender.
- `productId` is the **bytes32 keccak hash of the canonical product name** — 64 hex chars after `0x`. The 20-byte addresses you might see in older docs were a documentation bug; productIds are 32 bytes.

## Response schema (201)

Shape returned by the route handler. Includes the on-chain `policyId` and the relayer tx hash for verification.

## Error codes

| HTTP | Code | Why | Retry? |
|---|---|---|---|
| 400 | validation_error | productId/cover wrong | No |
| 401 | missing_api_key | header absent | No |
| 401 | invalid_api_key | revoked/malformed | No |
| 422 | shield_paused | shield.paused or protocol auto-paused | Maybe later |
| 422 | exceeds_capacity | BondVault.availableCapacityUSD insufficient | Maybe later |
| 429 | rate_limit | tier cap hit | Yes, backoff |
| 500 | server_error | RPC down / gas spike | Yes, max 3 |

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

- API endpoint: `src/routes/policies.ts:45` — `policiesAuthRouter.post("/", authMiddleware, apiLimiter, …)`
- Mount: `src/app.ts:29` — `app.use("/api/v1/policies", authIpLimiter, policiesAuthRouter)`
- Auth: `src/middlewares/auth.ts` — `authMiddleware` (validates `lk_…` keys)
- Underlying contract: `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol:158` — `purchasePolicyFor` (relayer-only)
