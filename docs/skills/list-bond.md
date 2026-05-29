# Skill: List bond for sale

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base mainnet 8453) but verify before use.

Both audiences. Pre-maturity, sell your ClaimBonds at a discount on the secondary marketplace.

---

## 👤 For Humans

**Difficulty**: ⭐⭐ · **Time**: ~1 minute

### What this does

A ClaimBond is yours, but you don't want to wait 2 years for maturity. List it for sale: someone pays you USDC now (at a discount), takes the bond, waits the rest of the term, then redeems for full face value. You get liquidity; they get yield.

### Before you start

- Wallet connected, on Base mainnet
- A ClaimBond you own (status `HOLDING` or `MATURED`)
- A target asking price in USDC (typically 40-60% of face value, depending on time-to-maturity)

### Step by step

1. Open `/app/human/portfolio` → "My Bonds"
2. Find the bond row → click **"List on marketplace"** (UI shipping next sprint — for now use the contract directly)
3. In the modal: pick how many bonds to list + the asking price in USDC
4. Wallet pops up — confirm the `Marketplace.list(epochId, amount, priceUSDC)` tx
5. Listing live in `/app/human/marketplace` → "My Listings" tab

### Common issues

- **"ERC1155: caller is not approved"** → first-time use needs setApprovalForAll on ClaimBond for Marketplace
- **Price too low** → you can list at any price; buyers just won't bite if too high or too low

### What to do next

- Want to revoke the listing later? → see [Cancel listing](./cancel-listing.md)
- Want to buy from someone else's listing? → see [Buy from marketplace](./buy-listing.md)

---

## 🤖 For AI Agents

**Type**: write · **Difficulty**: ⭐⭐⭐

### What this does

Direct call to `Marketplace.list(epochId, amount, priceUSDC)` returning a `listingId`. ERC-1155 setApprovalForAll required before the first list.

### Ready-to-use LLM prompt

```
You are an AI agent listing Lumina bonds on the secondary marketplace
(Base mainnet).

YOUR GOAL: List N bonds from epoch E at price P.

CONTEXT:
- Marketplace: 0xfaC56692c626718aC8953A3d5fAE67fac2f1Be6E
- ClaimBond: 0x3d2F5DB2505367D00ef81c51AD3cA66159271730
- Function: list(uint256 epochId, uint256 amount, uint256 priceUSDC)
            returns (uint256 listingId)
- amount: INTEGER DOLLARS (= ERC-1155 token count)
- priceUSDC: 6-dec USDC base units (e.g., 2400_000000 = $2,400)
- Marketplace fee: 1.5% from seller + 1.5% from buyer = 3% total, all burned

INSTRUCTIONS:
1. One-time setup: ClaimBond.setApprovalForAll(Marketplace, true) — only first time
2. Optional: Marketplace.calculateFees(priceUSDC) to preview fee split
3. Call Marketplace.list(epochId, amount, priceUSDC)
4. Persist returned listingId for tracking + cancellation

WHEN TO STOP:
- Success: Listed event with the listingId
- Block: revert "ERC1155: not approved" → run setApprovalForAll first
```

### TypeScript

```typescript
// One-time approval (idempotent — check isApprovedForAll first)
const approved = await client.readContract({
  address: CLAIM_BOND, abi: claimBondAbi, functionName: 'isApprovedForAll',
  args: [wallet, MARKETPLACE],
})
if (!approved) {
  await walletClient.writeContract({
    address: CLAIM_BOND, abi: claimBondAbi, functionName: 'setApprovalForAll',
    args: [MARKETPLACE, true],
  })
}

// List
const txHash = await walletClient.writeContract({
  address: '0xfaC56692c626718aC8953A3d5fAE67fac2f1Be6E',
  abi: marketplaceAbi,
  functionName: 'list',
  args: [epochId, amountIntegerDollars, parseUnits('2400', 6)],
})
```

### Important: units

| arg | unit |
|---|---|
| `epochId` | uint (no scaling) |
| `amount` | INTEGER DOLLARS (= bond count, 1 token = $1) |
| `priceUSDC` | 6-dec USDC (`parseUnits('2400', 6)` for $2,400) |

### Related skills

- [Get bonds owned](./get-bonds.md)
- [Cancel listing](./cancel-listing.md)
- [Buy from marketplace](./buy-listing.md)

## Source

- Function: `LUMINA-PROTOCOL/src/marketplace/LuminaBondMarketplace.sol:99` — `list(epochId, amount, priceUSDC)`
- Fees: `LuminaBondMarketplace.sol:169` — `calculateFees(priceUSDC)`
- Event: `LuminaBondMarketplace.sol:54` — `event Listed(listingId indexed, seller indexed, epochId indexed, amount, priceUSDC)`
