# Skill: Cancel an open listing

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base mainnet 8453) but verify before use.

Both audiences. Pull a listing off the marketplace before someone buys it.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~30 seconds

### What this does

Changed your mind about selling a bond, or want to relist at a different price? Cancel the active listing — the bond returns to your wallet, no fees charged.

### Step by step

1. Open `/app/human/marketplace` → "My Listings" tab
2. Find the active row → click **"Cancel listing"**
3. Wallet pops up — confirm
4. ✅ Done. Bond is back in your wallet (visible under "My Bonds" again)

### Common issues

- **"Listing not yours"** → wrong wallet connected
- **"Already filled"** → someone bought it first; nothing to cancel

### What to do next

- Relist at a new price → see [List bond](./list-bond.md)

---

## 🤖 For AI Agents

**Type**: write · **Difficulty**: ⭐

### What this does

Direct call to `Marketplace.cancel(listingId)`. Only the seller of the listing can call.

### Ready-to-use LLM prompt

```
You are an AI agent canceling a Lumina marketplace listing (Base mainnet).

YOUR GOAL: Cancel listing L. Bond returns to your wallet.

CONTEXT:
- Marketplace: 0xfaC56692c626718aC8953A3d5fAE67fac2f1Be6E
- Function: cancel(uint256 listingId)
- Only the original seller can cancel; otherwise revert
- No fees charged on cancellation

INSTRUCTIONS:
1. Optionally verify getListing(listingId).active === true and seller === your wallet
2. Call Marketplace.cancel(listingId)
3. Confirm via Cancelled event

WHEN TO STOP:
- Success: Cancelled event with seller === your wallet
- Block: revert → listing already sold, or you're not the seller
```

### TypeScript

```typescript
const txHash = await walletClient.writeContract({
  address: '0xfaC56692c626718aC8953A3d5fAE67fac2f1Be6E',
  abi: marketplaceAbi,
  functionName: 'cancel',
  args: [listingId],
})
```

### curl

There is no REST endpoint for marketplace operations on the agent side — calls go directly to the contract. The relayer pattern is reserved for `purchasePolicyFor` / `redeem`.

### Related skills

- [List bond](./list-bond.md)
- [Buy from marketplace](./buy-listing.md)

## Source

- Function: `LUMINA-PROTOCOL/src/marketplace/LuminaBondMarketplace.sol:125` — `cancel(listingId)`
- Event: `LuminaBondMarketplace.sol:57` — `event Cancelled(listingId indexed, seller indexed)`
