# Lumina Agent Quickstart — Your First Call in 3 Minutes

> 🔄 Addresses are dynamic — fetch from `GET /health`. Values below are correct as of 2026-05-06 on Base Sepolia (84532).

> 💵 **Premium is always paid in USDC**, regardless of the `asset` field. The `asset` parameter on `POST /api/v1/policies` is the **covered asset** — what the policy insures against — not the payment token. Discover it via `GET /products` (`coveredAsset` field, added 2026-05-06).

## Products at a glance

| Symbol         | coveredAsset | paymentAsset | What it insures                              |
|----------------|--------------|--------------|----------------------------------------------|
| FLASHBTC1H-001 | BTC          | USDC         | BTC rapid price crashes within 1h            |
| FLASHBTC4H-001 | BTC          | USDC         | BTC rapid price crashes within 4h            |
| FLASHBTC24-001 | BTC          | USDC         | BTC rapid price crashes within 24h           |
| FLASHBTC48-001 | BTC          | USDC         | BTC rapid price crashes within 48h           |
| FLASHETH1H-001 | ETH          | USDC         | ETH rapid price crashes within 1h            |
| FLASHETH24-001 | ETH          | USDC         | ETH rapid price crashes within 24h           |
| FLASHETH48-001 | ETH          | USDC         | ETH rapid price crashes within 48h           |
| MICRODEPEG-001 | USDT         | USDC         | USDT losing its peg to $1.00                 |
| RATESHOCK-001  | USDC         | USDC         | USDC borrow rate shocks on Aave V3           |

## 1. Discover the protocol
```bash
curl https://lumina-api-production-ac85.up.railway.app/health
```
Returns chainId, RPC connectivity, relayer address+balance, and every contract address you need.

## 2. Get an API key
Visit https://www.lumina-org.com/app/agent/api-keys
Connect wallet → generate key → save the `lk_…` value as `LUMINA_API_KEY`.

## 3. List products (no auth needed)
```bash
curl https://lumina-api-production-ac85.up.railway.app/products
```
Each product has a canonical `name` (e.g. `FLASHBTC1H-001`, `MICRODEPEG-001`,
`RATESHOCK-001`). Pass that name to `/policies` and the API will resolve both
the bytes32 `productId` AND the per-shield `asset` literal for you. See the
[products-and-assets reference](https://docs.lumina-org.com/agents/products-and-assets)
for the full table.

## 4. Get a quote (no auth needed)
```bash
curl "https://lumina-api-production-ac85.up.railway.app/products/FLASHBTC1H-001/quote?coverageAmount=50000000"
```

## 5. Buy a $50 policy
```bash
curl -X POST -H "x-api-key: $LUMINA_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "productName":    "FLASHBTC1H-001",
    "coverageAmount": "50000000",
    "buyer":          "0xYourWalletAddress"
  }' \
  https://lumina-api-production-ac85.up.railway.app/api/v1/policies
```

`coverageAmount` is in USDC base units (×10^6). `productName` is the canonical
product label — the API derives the `productId` hash AND the per-shield
`asset` literal from it. `buyer` must hold and have approved enough USDC to
cover the premium. Hardcoding `asset: "USDC"` for every shield reverts 7-of-9
with `InvalidAsset(bytes32("USDC"))` — only `RATESHOCK-001` actually expects
the `USDC` literal.

## 6. List your policies
```bash
curl -H "x-api-key: $LUMINA_API_KEY" \
  https://lumina-api-production-ac85.up.railway.app/api/v1/policies
```

## Common errors
- `503 relayer_unauthorized` — ops issue, contact founder. Should be fixed as of 2026-05-05.
- `400 validation_error` — fields mismatched the schema; double-check `productName` is in the registry, `productId` (if passed) is 32 bytes (not 20), `buyer` is a valid address.
- `429 too_many_requests` — slow down (per-key rate limit).

## Next steps
- `docs/skills/quote-policy.md` — pricing & shopping
- `docs/skills/track-policies.md` — read your active policies
- `docs/skills/marketplace-listings.md` — secondary market for ClaimBonds (when implemented)
