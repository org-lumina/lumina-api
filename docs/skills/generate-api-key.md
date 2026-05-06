# Skill: Generate API Key

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

> **Skill ID**: `generate-api-key` · **Audience**: Agent · **Difficulty**: ⭐⭐ Medium

## What this does

API keys let an AI agent authenticate against the Lumina REST API. Each key is bound to one Ethereum wallet address; the relayer pays gas on behalf of the agent.

## Status

✅ **Self-service.** Any wallet can mint its own keys (up to 3 active per wallet) by signing a short message with the wallet's private key — no admin involvement, no email.

## How keys work

Confirmed by source:

- **Format**: `lk_<64 hex chars>` — generated via `randomBytes(32)` then prefixed with `lk_`. ([`src/middlewares/auth.ts`](https://github.com/org-lumina/lumina-api/blob/main/src/middlewares/auth.ts) — `generateApiKey()`).
- **Storage**: only the **SHA-256 hash** is persisted in the database. The plaintext is shown to the operator exactly **once** at issuance.
- **Binding**: each key references one wallet address (validated as a `0x…` Ethereum address via `ethers.isAddress`).
- **Tier**: each key has a tier (`free` or `paid`) which gates rate limits.
- **Cap**: max 3 active keys per wallet (enforced in `services/keys.ts`).
- **Revocable**: any key holder can revoke any of *their own* keys via `DELETE /api/v1/agent/keys/:keyId`. Revoked keys reject on the very next request.

## Self-service onboarding

### Endpoint

```
POST /api/v1/agent/onboard
Body (application/json):
  {
    "walletAddress": "0xAbC1234…dEf",                           # required, valid 0x address
    "signature":     "0x<130 hex chars>",                        # required, EIP-191 personal_sign of the message below
    "timestamp":     1717000000,                                 # required, unix-seconds, must be within ±300s of server time
    "label":         "production-bot-001"                        # optional, max 50 chars
  }
```

The wallet proves ownership by signing exactly:

```
Lumina onboarding for {walletAddress} at {timestamp}
```

with the wallet's private key (EIP-191 `personal_sign`). The server recovers the signer with `ethers.verifyMessage` and rejects mismatches.

**Response (201)** — returned ONLY at this moment:

```json
{
  "ok": true,
  "keyId": 42,
  "apiKey": "lk_5f23a7b9c8…1d4e",
  "wallet": "0xAbC1234…dEf",
  "tier": "free",
  "label": "production-bot-001",
  "createdAt": "2026-05-05T13:47:12.034Z",
  "warning": "Store the apiKey now. It will not be shown again."
}
```

### TypeScript example

```ts
import { Wallet } from 'ethers'

const wallet = new Wallet(process.env.PRIVATE_KEY!)
const timestamp = Math.floor(Date.now() / 1000)
const message = `Lumina onboarding for ${wallet.address} at ${timestamp}`
const signature = await wallet.signMessage(message)

const res = await fetch('https://lumina-api-production-ac85.up.railway.app/api/v1/agent/onboard', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    walletAddress: wallet.address,
    signature,
    timestamp,
    label: 'my-trading-bot',
  }),
})

const { apiKey } = await res.json()
console.log('Save this now (shown only once):', apiKey)
```

### curl example

```bash
ADDRESS=0xYourWalletAddress
TIMESTAMP=$(date +%s)
MESSAGE="Lumina onboarding for ${ADDRESS} at ${TIMESTAMP}"

# Sign with cast (Foundry):
SIGNATURE=$(cast wallet sign "$MESSAGE" --private-key "$PRIVATE_KEY")

curl -X POST https://lumina-api-production-ac85.up.railway.app/api/v1/agent/onboard \
  -H "Content-Type: application/json" \
  -d "{\"walletAddress\":\"${ADDRESS}\",\"signature\":\"${SIGNATURE}\",\"timestamp\":${TIMESTAMP},\"label\":\"my-bot\"}"
```

### Lumina SDK example

```ts
import { LuminaClient } from 'lumina-sdk'
import { Wallet } from 'ethers'

const wallet = new Wallet(process.env.PRIVATE_KEY!)
const lumina = new LuminaClient({ apiKey: '' })  // empty apiKey for onboard
const { apiKey } = await lumina.agent.onboard(wallet, { label: 'my-trading-bot' })
console.log('Save this now (shown only once):', apiKey)
```

## List your keys

```
GET /api/v1/agent/keys
Headers:
  x-api-key: lk_…                  # any active key for the wallet
```

Returns all non-revoked keys for the wallet bound to the calling key:

```json
{
  "ok": true,
  "wallet": "0xAbC1234…dEf",
  "keys": [
    { "keyId": 42, "label": "production-bot-001", "createdAt": "2026-05-05T…", "tier": "free" }
  ]
}
```

## Revoke a key

```
DELETE /api/v1/agent/keys/:keyId
Headers:
  x-api-key: lk_…                  # any active key for the wallet (owner-only)
```

Returns `204 No Content`. The wallet that owns the calling key must also own the target `keyId` — otherwise `403 forbidden`.

## Limits

- **3 active keys per wallet maximum** — onboard returns `409 cap_reached` once full. Revoke an old key to free a slot.
- **10 onboard requests per hour per IP** — protects the signature-verification path from abuse.
- **±5 minute timestamp window** — replay protection. A signature with a stale or future-dated timestamp is rejected with `400 stale_timestamp`.
- **One-shot plaintext** — the API never stores or re-emits the plaintext key. If you lose it, revoke and onboard again.

## How to use a key (agent side)

Once you have a key, every authenticated request must include the `x-api-key` header. The middleware validates the format (`lk_` prefix), looks up the SHA-256 hash, and attaches `req.agent` (with `id`, `wallet`, `tier`, `keyId`) to the request.

### TypeScript example

```ts
const apiKey = process.env.LUMINA_API_KEY!  // store in .env, never commit

const res = await fetch('https://lumina-api-production-ac85.up.railway.app/api/v1/policies', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
  },
  body: JSON.stringify({ /* … */ }),
})
```

## Rate limits on the API surface

Each key is rate-limited per agent identity (NOT per IP). The middleware sets `req.agent.id` BEFORE the rate limiter runs (audit fix #33 RL-1) so multiple IPs sharing a key cannot bypass the cap.

Tiers:
- `free`: lower throughput (default for self-service onboarded keys)
- `paid`: higher throughput + priority

## Errors

| HTTP | Code | Why |
|---|---|---|
| 400 | `invalid_body` | walletAddress / signature / timestamp shape wrong |
| 400 | `stale_timestamp` | timestamp outside ±300s window |
| 401 | `invalid_signature` | recovered signer ≠ walletAddress, or signature unrecoverable |
| 401 | `missing_api_key` | `x-api-key` header absent on protected route |
| 401 | `invalid_api_key` | Key malformed or revoked |
| 403 | `forbidden` | Trying to revoke a key not owned by your wallet |
| 409 | `cap_reached` | Wallet already has 3 active keys |
| 429 | `rate_limit` | Onboard IP cap (10/h) or per-agent cap |

## Security

- ❌ **Never commit a key**. Store in env vars / secret manager.
- 🔄 **Rotate** if leaked: revoke the compromised `keyId` and onboard a new one.
- 🚫 **No grace period** on revocation — revoked keys reject on the very next request.
- 🔐 **The signing key never leaves your machine.** The wallet only signs the onboarding message; the server never sees the private key.

## Related skills

- [Configure API client](./configure-api-client.md)
- [Buy policy as Agent](./buy-policy-agent.md)
- [Health check](./health-check.md)

## Source

- Onboard / list / revoke routes: [`src/routes/agent.ts`](https://github.com/org-lumina/lumina-api/blob/main/src/routes/agent.ts) (`POST /onboard`, `GET /keys`, `DELETE /keys/:keyId`)
- Auth middleware: [`src/middlewares/auth.ts`](https://github.com/org-lumina/lumina-api/blob/main/src/middlewares/auth.ts) (`authMiddleware`, `hashApiKey`, `generateApiKey`)
- Mount point in `src/app.ts`: `app.use("/api/v1/agent", authIpLimiter, agentRouter)`
