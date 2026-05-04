# Skill: Check protocol status

Both audiences. Confirm the protocol is open for new policies and that the bond reserve has capacity.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~30 seconds

### What this does

Two things can stop you from buying a policy: (1) the protocol auto-paused (LUMINA price below floor), or (2) the bond reserve ran out of capacity. This skill shows both at a glance.

### Step by step

1. Open `/app/human/products`
2. The header line shows `· CAPACITY $X` — that's `availableCapacityUSD()`
3. If the protocol is auto-paused, ALL shield cards show "PAUSED" and the buy buttons are disabled

### What you'll see when it works

Header reads something like `SHIELDS · 9 ACTIVE PRODUCTS · BASE SEPOLIA · CAPACITY $124,500`. All cards "● ACTIVE".

### What to do next

- Capacity OK + not paused → pick a shield → [Buy policy as Human](./buy-policy-human.md)
- Paused → wait for the LUMINA price to recover (no user action needed)

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐

### What this does

Two on-chain reads tell you if it's safe to attempt a purchase: `CoverRouterV2.isProtocolAutoPaused()` (bool) and `BondVault.availableCapacityUSD()` (integer dollars, no decimals).

### Ready-to-use LLM prompt

```
You are an AI agent operating on Lumina Protocol (Base Sepolia, chainId 84532).

YOUR GOAL: Verify the protocol can accept new policies before quoting.

CONTEXT:
- CoverRouterV2: 0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316
- BondVault:     0x1747CDA7F84BEc4f2002ff0dcdb3c51c1C02cf6A
- isProtocolAutoPaused() → bool. If true, abort.
- availableCapacityUSD() → uint256 (INTEGER DOLLARS, no decimals).

INSTRUCTIONS:
1. Call CoverRouterV2.isProtocolAutoPaused()
2. If true: do NOT attempt to buy. Wait + retry in N minutes.
3. Call BondVault.availableCapacityUSD()
4. If your intended cover > capacity, downsize or wait.

WHEN TO STOP:
- Success: paused == false AND capacity >= intended cover
- Block: paused == true OR capacity < cover
```

### HTTP examples

On-chain only. JSON-RPC.

```typescript
const [paused, capacity] = await Promise.all([
  client.readContract({ address: COVER_ROUTER, abi, functionName: 'isProtocolAutoPaused' }),
  client.readContract({ address: BOND_VAULT, abi, functionName: 'availableCapacityUSD' }),
])
// paused: boolean
// capacity: bigint — INTEGER DOLLARS (e.g., 124500n = $124,500)
```

### Important: capacity units

`availableCapacityUSD()` returns INTEGER DOLLARS, NOT 6-dec USDC and NOT 18-dec wei. If you `formatUnits(capacity, 6)` you get a value 1e6× too small.

Source: `BondVault.sol:227` — `return (... ) / 1e18` (the function divides internally to expose integer dollars).

### Related skills

- [Quote policy](./quote-policy.md)
- [Buy policy](./buy-policy-human.md) / [as Agent](./buy-policy-agent.md)

## Source

- `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol:308` — `isProtocolAutoPaused()`
- `LUMINA-PROTOCOL/src/bonds/BondVault.sol:227` — `availableCapacityUSD()`
