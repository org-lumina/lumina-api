# Skill: Buy policy as Agent (via API)

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

INSTRUCTIONS:
1. POST /api/v1/policies with body:
     { "productId": "0x...", "coverageAmount": <uint in 6-dec USDC> }
2. On 201 response, persist the returned policyId for tracking
3. On 4xx, fix the payload and retry
4. On 5xx, exponential backoff (max 3 attempts)

WHEN TO STOP:
- Success: HTTP 201 with policyId in response body
- Block: HTTP 401 (key) or 400 (bad payload) → escalate to operator
- Retry: HTTP 429 (rate-limit) or 5xx
```

## HTTP examples

### curl

```bash
curl -X POST https://lumina-api-production-ac85.up.railway.app/api/v1/policies \
  -H "x-api-key: $LUMINA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "0xAc53Bf7Bb85Fcfb6d3c831F3AD9f6f79ebeeF99f",
    "coverageAmount": "5000000000"
  }'
```

### TypeScript (fetch)

```typescript
const res = await fetch('https://lumina-api-production-ac85.up.railway.app/api/v1/policies', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.LUMINA_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    productId: '0xAc53Bf7Bb85Fcfb6d3c831F3AD9f6f79ebeeF99f',
    coverageAmount: '5000000000', // $5,000 in 6-dec USDC, as string
  }),
})

const result = await res.json()
```

### Python (requests)

```python
import os, requests
res = requests.post(
    'https://lumina-api-production-ac85.up.railway.app/api/v1/policies',
    headers={'x-api-key': os.environ['LUMINA_API_KEY']},
    json={
        'productId': '0xAc53Bf7Bb85Fcfb6d3c831F3AD9f6f79ebeeF99f',
        'coverageAmount': '5000000000',  # str to preserve precision
    },
)
data = res.json()
```

## Request schema

```json
{
  "productId": "bytes32 — keccak256 of canonical name (e.g., FLASH-BTC-24H)",
  "coverageAmount": "string — uint, USDC base units (6 dec). Use string to avoid JS number overflow."
}
```

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
