# Skill: Quote a parametric policy (on-chain)

Both audiences. Get a real-time premium quote directly from `CoverRouterV2.quotePremium`.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~10 seconds

### What this does

Tells you exactly how much USDC you'll pay (premium) and how much you'd receive in ClaimBonds (payout) if the trigger fires — for any cover amount you choose.

### Step by step

1. Open a shield detail page (e.g., `/app/human/products/flash-btc-24h`)
2. Drag the **COVER AMOUNT** slider or type a number (range: $100 – $100,000)
3. The right panel updates live with: **You pay (premium)**, **If trigger fires**, **Bond face value**, **At maturity**
4. Numbers come straight from on-chain — no estimates

### What you'll see when it works

The "You pay" line shows e.g. `$2.40 USDC` and "If trigger fires" shows e.g. `$4,000 ClaimBonds` for $5,000 cover.

### Common issues

- **Premium shows as `$1.00` for tiny covers** → the contract enforces a $1 minimum. Increase cover.
- **Premium not loading** → RPC is slow. Refresh the page.

### What to do next

- Happy with the price? → [Buy policy as Human](./buy-policy-human.md)

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐

### What this does

Single on-chain view call. Returns `(premium, payout)` tuple in 6-decimal USDC. NO duration parameter — duration is encoded in the productId itself.

### Ready-to-use LLM prompt

```
You are an AI agent quoting Lumina policies (Base Sepolia, chainId 84532).

YOUR GOAL: Get exact premium for a given productId + cover.

CONTEXT:
- CoverRouterV2: 0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316
- Function: quotePremium(bytes32 productId, uint256 coverageAmount)
            returns (uint256 premium, uint256 payout)
- Units: cover and premium are 6-dec USDC (parseUnits('1000', 6) for $1k)

INSTRUCTIONS:
1. Call quotePremium(productId, coverageWei)
2. Read result[0] = premium (USDC 6-dec)
3. Read result[1] = payout  (USDC 6-dec, = cover * payoutRatioBps / 10000)
4. Premium scales linearly with cover; cache one quote and extrapolate

WHEN TO STOP:
- Success: premium > 0n
- Block: premium == 0n with revert "Product not configured" → wrong productId
```

### HTTP examples

On-chain. Use viem / ethers.

```typescript
const [premium, payout] = await client.readContract({
  address: '0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316',
  abi: coverRouterV2Abi,
  functionName: 'quotePremium',
  args: [productId, parseUnits('1000', 6)],
})
// premium: bigint (6-dec USDC), payout: bigint (6-dec USDC)
```

### Premium math (from source)

```
premium = (cover * payoutRatioBps * triggerProbBps * marginBps) / 1e12
payout  = (cover * payoutRatioBps) / 10000
if (premium == 0) premium = 1   // contract enforces $1 minimum
```

Source: `CoverRouterV2.sol:289-294`.

### For per-product quote VIA REST API

See [quote-via-api](./quote-via-api.md).

### Related skills

- [Browse shields](./browse-shields.md)
- [Buy policy human](./buy-policy-human.md) / [agent](./buy-policy-agent.md)

## Source

- Contract function: `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol:284` — `quotePremium`
- Math: `CoverRouterV2.sol:289-293`
