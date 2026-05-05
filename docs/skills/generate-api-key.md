# Skill: Generate API Key

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

> **Skill ID**: `generate-api-key` · **Audience**: Agent · **Difficulty**: ⭐⭐ Medium

## What this does

API keys let an AI agent authenticate against the Lumina REST API. Each key is bound to one Ethereum wallet address; the relayer pays gas on behalf of the agent.

## Status

🔒 **Currently admin-only.** Self-service issuance is on the roadmap. To request a key today:

- Email **labs@lumina-org.com** with your wallet address (one per agent), OR
- Open an issue on `org-lumina/lumina-api`.

## How keys work

Confirmed by source:

- **Format**: `lk_<64 hex chars>` — generated via `randomBytes(32)` then prefixed with `lk_`. ([`src/middlewares/auth.ts`](https://github.com/org-lumina/lumina-api/blob/main/src/middlewares/auth.ts) — `generateApiKey()`).
- **Storage**: only the **SHA-256 hash** is persisted in the database. The plaintext is shown to the operator exactly **once** at issuance (`keys.ts:21` `warning: "Store the apiKey now. It will not be shown again."`).
- **Binding**: each key references one wallet address (validated as a `0x…` Ethereum address via `ethers.isAddress`).
- **Tier**: each key has a tier (`free` or `paid`) which gates rate limits.
- **Cap**: max 3 keys per wallet (enforced in `services/keys.ts`).
- **Revocable**: admin can revoke by `keyId`; a revoked key is rejected immediately on the next request.

## Endpoint (admin-only)

### Issue a key

```
POST /api/v1/keys/generate
Headers:
  x-admin-token: <admin secret>     # admin auth, not user-facing
Body (application/json):
  {
    "wallet": "0xAbC1234…dEf",       # required, valid 0x address
    "label":  "production-bot-001"   # optional, max 64 chars
  }
```

**Response (201)** — returned ONLY at this moment:

```json
{
  "ok": true,
  "keyId": 42,
  "apiKey": "lk_5f23a7b9c8…1d4e",
  "wallet": "0xAbC1234…dEf",
  "tier": "free",
  "label": "production-bot-001",
  "createdAt": "2026-05-04T13:47:12.034Z",
  "warning": "Store the apiKey now. It will not be shown again."
}
```

### Revoke a key

```
DELETE /api/v1/keys/:id
Headers:
  x-admin-token: <admin secret>
```

Returns `204 No Content` on success.

## How to use a key (agent side)

Once you have a key, every authenticated request must include the `x-api-key` header. The middleware validates the format (`lk_` prefix, ≥ 10 chars), looks up the SHA-256 hash, and attaches `req.agent` (with `id`, `wallet`, `tier`, `keyId`) to the request.

### TypeScript example

```ts
const apiKey = process.env.LUMINA_API_KEY! // store in .env, never commit

const res = await fetch('https://lumina-api-production-ac85.up.railway.app/api/v1/policies', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
  },
  body: JSON.stringify({
    productId: '0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd', // FlashBTC1h
    coverageAmount: 5000_000000, // $5,000 in 6-dec USDC
  }),
})
```

### curl

```bash
curl https://lumina-api-production-ac85.up.railway.app/health \
  -H "x-api-key: $LUMINA_API_KEY"
```

## Rate limits

Each key is rate-limited per agent identity (NOT per IP). The middleware sets `req.agent.id` BEFORE the rate limiter runs (audit fix #33 RL-1) so multiple IPs sharing a key do not bypass the cap.

Tiers (current defaults — subject to change):
- `free`: lower throughput
- `paid`: higher throughput + priority

## Errors

| HTTP | Code | Why |
|---|---|---|
| 401 | `missing_api_key` | `x-api-key` header absent |
| 401 | `invalid_api_key` | Key malformed (no `lk_` prefix) or revoked |
| 429 | rate-limit | Too many requests for your tier |

## Security

- ❌ **Never commit a key**. Store in env vars / secret manager.
- 🔄 **Rotate** if leaked: open an issue or contact admin to revoke + reissue.
- 🚫 **No grace period** on revocation — revoked keys reject on the very next request.

## Related skills

- [Configure API client](./configure-api-client.md)
- [Buy policy as Agent](./buy-policy-agent.md)
- [Health check](./health-check.md)

## Source

- Issue / revoke routes: [`src/routes/keys.ts`](https://github.com/org-lumina/lumina-api/blob/main/src/routes/keys.ts) (`keysRouter.post("/generate", …)` line 16, `keysRouter.delete("/:id", …)` line 36)
- Auth middleware: [`src/middlewares/auth.ts`](https://github.com/org-lumina/lumina-api/blob/main/src/middlewares/auth.ts) (`authMiddleware`, `hashApiKey`, `generateApiKey`)
- Mount point in `src/app.ts`: `app.use("/api/v1/keys", keysRouter)`
