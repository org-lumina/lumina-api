# Skill: Track active policies (by owner)

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

Both audiences. Discover all policies a wallet has ever bought.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~30 seconds

### What this does

Shows you every policy you've ever bought from your connected wallet — active, expired, and triggered.

### Step by step

1. **Connect your wallet** in `/app` (top right)
2. Navigate to `/app/human/portfolio`
3. The "Active Policies" tab loads automatically
4. Each row shows: shield name, cover amount, premium paid, payout if triggered, and a Basescan link to the original purchase tx

### What you'll see when it works

A table of your policies. Loading state shows "⏳ Loading on-chain policies…" for ~3 seconds while events are indexed.

### Common issues

- **"No active policies"** with policies you bought → wrong wallet connected; switch in MetaMask
- **Loader never finishes** → public RPC throttled. Try again in a minute, or use a paid RPC

### What to do next

- See your bonds → "My Bonds" tab in the same page
- See [Watch oracle triggers](./watch-triggers.md) to know when payouts happen

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐⭐⭐

### What this does

Index `PolicyCreated` events from `PolicyManagerV2`. CRITICAL: `buyer` is **NOT indexed** in the event ABI, so you can't filter by topic — you must pull all logs and filter client-side by buyer address.

### Ready-to-use LLM prompt

```
You are an AI agent monitoring Lumina policy ownership (Base Sepolia).

YOUR GOAL: Enumerate all policies owned by a wallet.

CONTEXT:
- PolicyManagerV2: 0xd9732A8d6Cf5266Dd896B825E78E387B7Dd2c379
- Event: PolicyCreated(bytes32 indexed productId, uint256 indexed policyId,
                       address buyer, uint256 coverage, uint256 premium, uint256 payout)
- buyer is NOT indexed → topic filter impossible. Pull all + filter client-side.
- For mainnet scale: use a subgraph, NOT raw getLogs

INSTRUCTIONS:
1. Use viem/ethers getLogs from PolicyManagerV2 with event = PolicyCreated
2. Filter logs.filter(l => l.args.buyer.toLowerCase() === wallet.toLowerCase())
3. Optionally cross-check status via PolicyManagerV2.getPolicy(productId, policyId)

WHEN TO STOP:
- Success: array (possibly empty) of policy events for the wallet
- Block: provider error → backoff
```

### HTTP examples (RPC, not REST)

```typescript
const logs = await client.getLogs({
  address: '0xd9732A8d6Cf5266Dd896B825E78E387B7Dd2c379',
  event: parseAbiItem('event PolicyCreated(bytes32 indexed productId, uint256 indexed policyId, address buyer, uint256 coverage, uint256 premium, uint256 payout)'),
  fromBlock: 'earliest',
})
const mine = logs.filter(l => l.args.buyer.toLowerCase() === wallet.toLowerCase())
```

### Alternative: REST (agent-only, your own policies)

If your agent identity matches the wallet, `GET /api/v1/policies` returns the same set without log indexing. Auth required.

```bash
curl https://lumina-api-production-ac85.up.railway.app/api/v1/policies \
  -H "x-api-key: $LUMINA_API_KEY"
```

### Related skills

- [Watch triggers](./watch-triggers.md)
- [Get bonds owned](./get-bonds.md)
- [Check policy detail](./check-policy-detail.md)

## Source

- Event definition: `LUMINA-PROTOCOL/src/core/PolicyManagerV2.sol:101` — `event PolicyCreated`
- Note: `buyer` is the THIRD field, NOT indexed
- API alt: `lumina-api/src/routes/policies.ts:94` — `policiesAuthRouter.get("/", …)`
