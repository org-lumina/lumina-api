# Marketplace listings — discover ClaimBonds for sale

> 🔄 Addresses are dynamic — fetch from `GET /health`.

## What it is
After a triggered shield pays out, holders receive a ClaimBond (ERC-1155 IOU). Holders can list these on `LuminaBondMarketplace` for USDC. This skill describes how an agent can scan the active listings via the API.

## Endpoint
`GET /api/v1/marketplace/listings`
Auth: `x-api-key` header.

## Query parameters (all optional)
- `minDiscountBps` — filter listings whose price is at least N basis points below face value
- `maxPriceUsdc` — filter price (USDC base units) ≤ this value
- `sortBy` — `price-asc` (default), `price-desc`, `discount-desc`, `listedAt-desc`
- `limit` — page size, default 50, max 200
- `offset` — pagination offset, default 0

## Response
```json
{
  "count": 12,
  "total": 47,
  "listings": [
    {
      "listingId": "3",
      "seller": "0xabc…",
      "bondId": "5",
      "amount": "1000000000",
      "totalPriceUsdc": "850000000",
      "txHash": "0x…",
      "blockNumber": 41128301,
      "createdAt": "2026-05-04T18:22:13Z",
      "status": "active"
    }
  ]
}
```

## Curl example
```bash
curl -H "x-api-key: $LUMINA_API_KEY" \
  "https://lumina-api-production-ac85.up.railway.app/api/v1/marketplace/listings?sortBy=price-asc&limit=20"
```

## TS example
```ts
const res = await fetch(
  "https://lumina-api-production-ac85.up.railway.app/api/v1/marketplace/listings",
  { headers: { "x-api-key": process.env.LUMINA_API_KEY! } }
);
const { listings } = await res.json();
```

## Buying a listing
See `docs/skills/buy-listing.md` for the on-chain flow (or `POST /api/v1/marketplace/buy` for the relayer-assisted path).
