# Skill: Read shield specs

Both audiences. See exact trigger condition, premium formula coefficients, payout ratio, and cover bounds for a specific shield.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~1 minute

### What this does

Each of the 9 shields has its own contract with a specific trigger (e.g. "BTC drops 10% in 24h"). This view shows you the exact rules.

### Step by step

1. Open `/app/human/products` and click the shield you're curious about
2. The detail page shows the trigger logic, the timeline (Approve → Buy → Oracle watches → Bond or burn), and a live calculator
3. The "TRIGGER LOGIC · CHAINLINK ORACLE" block shows the exact `IF / THEN / ELSE` rule

### What you'll see when it works

Hero with shield name and asset. Underneath: a code-style block describing trigger, plus a 4-step "what happens next" timeline.

### Common issues

- Page says **"PAUSED"** → shield is temporarily disabled. Pick another from the catalog.

### What to do next

- Adjust the cover slider in the right panel → see the live premium update
- Ready to buy? → see [Buy policy as Human](./buy-policy-human.md)

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐⭐

### What this does

Read the on-chain `ProductConfig` struct (payoutRatioBps, triggerProbBps, marginBps, durationSeconds, active) directly from `CoverRouterV2`. Use this to compute premiums locally instead of polling `quotePremium`.

### Ready-to-use LLM prompt

```
You are an AI agent operating on Lumina Protocol (Base Sepolia, chainId 84532).

YOUR GOAL: Fetch the per-product config for one or more shields.

CONTEXT:
- CoverRouterV2 address: 0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316
- Function: getProductConfig(bytes32 productId) returns (ProductConfig)
- ProductConfig: { productId, payoutRatioBps, triggerProbBps, marginBps, durationSeconds, active }

INSTRUCTIONS:
1. For each productId you care about, call getProductConfig via your RPC node
2. Persist payoutRatioBps, triggerProbBps, marginBps to compute premiums offline
3. Watch the `active` flag — if false, the shield is paused

WHEN TO STOP:
- Success: you have the config for all shields you'll trade
- Failure: RPC error → retry with backoff
```

### HTTP examples

This skill is on-chain only — no REST endpoint. Use a JSON-RPC client.

#### viem TypeScript

```typescript
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'

const client = createPublicClient({
  chain: baseSepolia,
  transport: http('https://sepolia.base.org'),
})

const config = await client.readContract({
  address: '0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316',
  abi: [{ /* getProductConfig ABI entry */ }],
  functionName: 'getProductConfig',
  args: [productId],
})
```

### Premium formula (from source)

```
premium = (cover * payoutRatioBps * triggerProbBps * marginBps) / 1e12
payout  = (cover * payoutRatioBps) / 10000
```

Confirmed at `CoverRouterV2.sol:289-293`.

### Related skills

- [Browse shields](./browse-shields.md)
- [Quote policy on-chain](./quote-policy.md)

## Source

- Contract function: `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol:297` — `getProductConfig`
- Struct: `CoverRouterV2.sol:60-67` — `struct ProductConfig`
- Per-shield contracts: `LUMINA-PROTOCOL/src/products/`
