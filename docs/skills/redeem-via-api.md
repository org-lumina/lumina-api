# Skill: Redeem matured bonds via API (Agent)

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

**For**: AI Agents · **Type**: write · **Difficulty**: ⭐⭐

---

## What this does

Agent-side equivalent of `BondVault.redeemBond`. Agent posts an authenticated request; the API's relayer signs and calls the contract on-chain. The resulting LUMINA goes to the agent's bound wallet.

## Ready-to-use LLM prompt

```
You are an AI agent redeeming Lumina bonds via the API relayer (Base Sepolia).

YOUR GOAL: Convert matured ClaimBonds into LUMINA without paying gas yourself.

CONTEXT:
- API base URL: https://lumina-api-production-ac85.up.railway.app
- Endpoint: POST /api/v1/redeem
- Auth: x-api-key header (lk_<64hex>) bound to the holder wallet
- Body: { epochId, usdAmount }
  - epochId: uint, the bond epoch id
  - usdAmount: uint, INTEGER DOLLARS to redeem (= ERC-1155 token count)

INSTRUCTIONS:
1. Discover holdings via /api/v1/bonds/:wallet (see get-bonds.md)
2. Filter epochs where matured === true and balance > 0
3. POST /api/v1/redeem with { epochId, usdAmount: balance }
4. Confirm via response status / on-chain BondRedeemed event

WHEN TO STOP:
- Success: HTTP 200/201 with tx hash + luminaAmount
- Block: 401 (key) → fix auth; 422 not_matured → wait; 422 price_too_low → wait
```

## HTTP examples

### curl

```bash
curl -X POST https://lumina-api-production-ac85.up.railway.app/api/v1/redeem \
  -H "x-api-key: $LUMINA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "epochId": "202805",
    "usdAmount": "5000"
  }'
```

### TypeScript

```typescript
const res = await fetch('https://lumina-api-production-ac85.up.railway.app/api/v1/redeem', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.LUMINA_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    epochId: '202805',
    usdAmount: '5000',  // INTEGER DOLLARS, as string for safety
  }),
})
```

### Python

```python
import os, requests
res = requests.post(
    'https://lumina-api-production-ac85.up.railway.app/api/v1/redeem',
    headers={'x-api-key': os.environ['LUMINA_API_KEY']},
    json={'epochId': '202805', 'usdAmount': '5000'},
)
```

## Request schema

```json
{
  "epochId":   "string — uint epoch id of the matured bonds",
  "usdAmount": "string — uint, integer dollars to redeem (must be <= holder balance)"
}
```

## Response schema (success)

Includes the relayer tx hash + the LUMINA amount transferred to the holder. Shape returned by the route handler.

## Error codes

| HTTP | Code | Why | Retry? |
|---|---|---|---|
| 400 | validation_error | bad epoch / amount | No |
| 401 | invalid_api_key | bad/revoked key | No |
| 422 | not_matured | epoch not yet matured | Wait + retry |
| 422 | insufficient_bonds | balance < usdAmount | No |
| 422 | price_too_low | oracle below MIN_REDEEM_PRICE | Wait |
| 429 | rate_limit | tier cap | Yes, backoff |
| 500 | server_error | RPC down | Yes, max 3 |

## Rate limits

`apiLimiter` per agent identity (`req.agent.id`).

## Related skills

- [Redeem on-chain (no API)](./redeem-bond.md)
- [Get bonds owned](./get-bonds.md)
- [Receive ClaimBond](./receive-claimbond.md)

## Source

- Endpoint: `lumina-api/src/routes/redeem.ts:31` — `redeemAuthRouter.post("/", authMiddleware, apiLimiter, …)`
- Mount: `src/app.ts:30` — `app.use("/api/v1/redeem", authIpLimiter, redeemAuthRouter)`
- Underlying contract: `LUMINA-PROTOCOL/src/bonds/BondVault.sol:198` — `redeemBond(epochId, usdAmount)`
