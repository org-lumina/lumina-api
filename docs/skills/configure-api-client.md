# Skill: Configure API client

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-06 (Base mainnet 8453) but verify before use.

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

**For**: AI Agents · **Type**: setup · **Difficulty**: ⭐

---

## What this does

One-time setup so your bot can call the Lumina REST API: env vars, base URL, auth header, error handling. After this is in place, every other agent skill ([buy-policy-agent](./buy-policy-agent.md), [redeem-via-api](./redeem-via-api.md), etc.) just works.

## Ready-to-use LLM prompt

```
You are an AI agent integrating with Lumina Protocol API (Base mainnet).

CONFIGURATION:
- Base URL: https://lumina-api-production-ac85.up.railway.app
- Auth header: x-api-key: lk_<64hex>
- Network: Base mainnet (chainId 8453)
- Always JSON: Content-Type: application/json on POST/PUT
- Use string for uint values (avoid JS number overflow on bigints)

REQUEST INVARIANTS:
- Public endpoints: NO auth header required
- /api/v1/* endpoints: REQUIRE x-api-key (else HTTP 401)
- Rate limit: per agent identity (NOT per IP) — exponential backoff on 429

RESPONSE INVARIANTS:
- Success: HTTP 200/201, JSON body
- Auth fail: HTTP 401, { code: "missing_api_key" | "invalid_api_key" }
- Validation fail: HTTP 400, { code: "validation_error" }
- Not found: HTTP 404
- Rate limit: HTTP 429 — back off
- Server error: HTTP 5xx — retry with backoff (max 3)

ON ERROR:
- Always parse error body JSON for `code` field; that's machine-readable
- Log full request/response for debugging (mask the key)
```

## Required env vars

```bash
# .env (DO NOT commit)
LUMINA_API_KEY=lk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LUMINA_API_URL=https://lumina-api-production-ac85.up.railway.app
```

## Reusable client

### TypeScript (fetch wrapper)

```typescript
const BASE = process.env.LUMINA_API_URL!
const KEY = process.env.LUMINA_API_KEY!

async function lumina(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Lumina ${res.status} ${body.code ?? ''}: ${body.message ?? res.statusText}`)
  }
  return body
}

// Usage
const bonds = await lumina('/api/v1/bonds/0xWALLET')
const policy = await lumina('/api/v1/policies', {
  method: 'POST',
  body: JSON.stringify({ productId: '0x…', coverageAmount: '5000000000' }),
})
```

### Python (requests session)

```python
import os, requests
from requests.adapters import HTTPAdapter, Retry

session = requests.Session()
session.headers.update({
    'x-api-key': os.environ['LUMINA_API_KEY'],
    'Content-Type': 'application/json',
})
# Retry transient failures
retries = Retry(total=3, backoff_factor=1.5, status_forcelist=[429, 500, 502, 503, 504])
session.mount('https://', HTTPAdapter(max_retries=retries))

BASE = os.environ['LUMINA_API_URL']

def lumina(path, **kwargs):
    res = session.request(kwargs.pop('method', 'GET'), f'{BASE}{path}', **kwargs)
    res.raise_for_status()
    return res.json()
```

### curl

```bash
# Convenience wrapper in bash
lumina() {
  curl -sS \
    -H "x-api-key: $LUMINA_API_KEY" \
    -H "Content-Type: application/json" \
    "${LUMINA_API_URL}$@"
}

lumina /health
lumina /products
```

## Error handling cheatsheet

| HTTP | Code | Action |
|---|---|---|
| 200/201 | — | Use response body |
| 400 | validation_error | Fix payload, do NOT retry |
| 401 | missing_api_key | Add `x-api-key` header |
| 401 | invalid_api_key | Key revoked / malformed → contact admin |
| 404 | — | Resource doesn't exist; verify ids |
| 429 | rate_limit | Exponential backoff (e.g. 1s → 2s → 4s → …) |
| 500-504 | server_error | Retry max 3 with backoff |

## Rate limits

Per agent identity (NOT per IP). Tier set on key issuance (`free` vs `paid`). See [generate-api-key](./generate-api-key.md).

## Related skills

- [Generate API key](./generate-api-key.md)
- [Health check](./health-check.md)
- [Buy policy as Agent](./buy-policy-agent.md)
- [Redeem via API](./redeem-via-api.md)

## Source

- Auth middleware: `lumina-api/src/middlewares/auth.ts` — `authMiddleware`
- Rate limiter: `lumina-api/src/middlewares/rateLimit.ts` — `apiLimiter`
- README: `lumina-api/README.md`
- All routes: `lumina-api/src/routes/*.ts`
