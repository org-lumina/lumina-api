# Skill: Buy bond from marketplace

Both audiences. Buy a discounted ClaimBond off the secondary marketplace, redeem at maturity for full face value.

---

## 👤 For Humans

**Difficulty**: ⭐⭐ · **Time**: ~1 minute

### What this does

Other users list their bonds at a discount because they want USDC NOW instead of waiting 24 months. You can buy that bond, sit on it, and redeem at maturity for the full face. The discount minus marketplace fees (3% total) is your yield.

### Before you start

- Wallet connected, on Base Sepolia
- USDC balance ≥ asking price + your share of fees (1.5% buyer fee)

### Step by step

1. Open `/app/human/marketplace` → "Browse" tab
2. Each card shows: face value, asking price, discount %, days to maturity, implied annual yield
3. Click **"Buy for $X"**
4. First time: wallet asks to **approve USDC** for the Marketplace contract
5. Wallet asks to confirm the **buy** tx
6. ✅ Done — bond now in your wallet under that epoch

### What you'll see when it works

The listing card disappears from "Browse" (or shows ✓ Bought). Your `/app/human/portfolio` "My Bonds" tab now lists the bond under its epoch.

### Common issues

- **Listing disappears mid-purchase** → someone else bought first; refresh
- **"USDC insufficient"** → top up
- **"Listing not active"** → already sold or cancelled; refresh

### What to do next

- Track the bond → see [Get bonds owned](./get-bonds.md)
- Wait for maturity → see [Redeem matured bond](./redeem-bond.md)

---

## 🤖 For AI Agents

**Type**: write · **Difficulty**: ⭐⭐⭐

### What this does

Direct call to `Marketplace.executeBuy(listingId)`. USDC `approve(Marketplace, priceUSDC + fee)` required first.

### Ready-to-use LLM prompt

```
You are an AI agent buying secondary bonds on Lumina (Base Sepolia).

YOUR GOAL: Buy listing L for the asked priceUSDC.

CONTEXT:
- Marketplace: 0x863A7fB4A676106db4b03449b01AC5615c6C9D51
- USDC (mock): 0x63D340AE7229BB464bC801f225651341ebcD3693
- Function: executeBuy(uint256 listingId)
- Buyer fee: 1.5% of priceUSDC (paid by buyer in addition to price)
- Total spend: priceUSDC * 1.015

INSTRUCTIONS:
1. Read getListing(listingId) → verify active === true and pull priceUSDC
2. Read calculateFees(priceUSDC) → confirm buyerFee
3. USDC.approve(Marketplace, priceUSDC + buyerFee)  (or > to skip future approves)
4. Marketplace.executeBuy(listingId)
5. Verify Bought event with buyer === your wallet

WHEN TO STOP:
- Success: Bought event present
- Block: revert "Listing not active" → someone else bought it first
- Block: insufficient allowance/balance → fix and retry
```

### TypeScript

```typescript
const [seller, epochId, amount, priceUSDC, active] = await client.readContract({
  address: '0x863A7fB4A676106db4b03449b01AC5615c6C9D51',
  abi: marketplaceAbi,
  functionName: 'getListing',
  args: [listingId],
})
if (!active) throw new Error('Listing not active')

// Approve USDC for Marketplace
await walletClient.writeContract({
  address: USDC, abi: erc20Abi, functionName: 'approve',
  args: [MARKETPLACE, (priceUSDC * 1015n) / 1000n],  // price + 1.5%
})

// Buy
await walletClient.writeContract({
  address: MARKETPLACE,
  abi: marketplaceAbi,
  functionName: 'executeBuy',
  args: [listingId],
})
```

### Discovery

To enumerate active listings, do log set-difference:

```typescript
const [listed, cancelled, bought] = await Promise.all([
  client.getLogs({ address: MARKETPLACE, event: ListedEvent, fromBlock: 'earliest' }),
  client.getLogs({ address: MARKETPLACE, event: CancelledEvent, fromBlock: 'earliest' }),
  client.getLogs({ address: MARKETPLACE, event: BoughtEvent, fromBlock: 'earliest' }),
])
const removed = new Set([...cancelled, ...bought].map(l => l.args.listingId.toString()))
const active = listed.filter(l => !removed.has(l.args.listingId.toString()))
```

### Related skills

- [List bond](./list-bond.md)
- [Cancel listing](./cancel-listing.md)
- [Redeem matured bond](./redeem-bond.md)

## Source

- Function: `LUMINA-PROTOCOL/src/marketplace/LuminaBondMarketplace.sol:135` — `executeBuy(listingId)`
- Listing read: `LuminaBondMarketplace.sol:160` — `getListing` returns (seller, epochId, amount, priceUSDC, active)
- Fee calc: `LuminaBondMarketplace.sol:169` — `calculateFees(priceUSDC)` returns (sellerFee, buyerFee, total)
- Events: `LuminaBondMarketplace.sol:54-58` — `Listed`, `Cancelled`, `Bought`
