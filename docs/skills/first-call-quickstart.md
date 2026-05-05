# Lumina Agent Quickstart — Your First Call in 3 Minutes

> 🔄 Addresses are dynamic — fetch from `GET /health`. Values below are correct as of 2026-05-05 on Base Sepolia (84532).

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
Pick a `productId` (32-byte hex). Example: FlashBTC1h = `0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd`.

## 4. Get a quote (no auth needed)
```bash
curl "https://lumina-api-production-ac85.up.railway.app/products/0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd/quote?coverageAmount=50000000"
```

## 5. Buy a $50 policy
```bash
curl -X POST -H "x-api-key: $LUMINA_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "productId": "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd",
    "coverageAmount": "50000000",
    "asset": "0x5553444300000000000000000000000000000000000000000000000000000000",
    "buyer": "0xYourWalletAddress"
  }' \
  https://lumina-api-production-ac85.up.railway.app/api/v1/policies
```

`coverageAmount` is in USDC base units (×10^6). `asset` is `ethers.encodeBytes32String("USDC")`. `buyer` must hold and have approved enough USDC to cover the premium.

## 6. List your policies
```bash
curl -H "x-api-key: $LUMINA_API_KEY" \
  https://lumina-api-production-ac85.up.railway.app/api/v1/policies
```

## Common errors
- `503 relayer_unauthorized` — ops issue, contact founder. Should be fixed as of 2026-05-05.
- `400 validation_error` — fields mismatched the schema; double-check `asset` is 32 bytes, `productId` is 32 bytes (not 20), `buyer` is a valid address.
- `429 too_many_requests` — slow down (per-key rate limit).

## Next steps
- `docs/skills/quote-policy.md` — pricing & shopping
- `docs/skills/track-policies.md` — read your active policies
- `docs/skills/marketplace-listings.md` — secondary market for ClaimBonds (when implemented)
