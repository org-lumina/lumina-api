# Skill: Watch oracle triggers

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

Both audiences. Get notified the moment a policy trigger fires.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~30 seconds (passive)

### What this does

When the oracle confirms your policy's trigger condition (e.g., BTC dropped 10% in 24h), Lumina mints a ClaimBond to your wallet automatically. This skill is about KNOWING when that happens.

### Step by step

1. Just check `/app/human/portfolio` periodically
2. A triggered policy shows status `triggered` instead of `active`
3. The "My Bonds" tab shows the new ClaimBond
4. Want push notifications? Watch your wallet on a block explorer (Etherscan / Basescan supports email alerts)

### Common issues

- **Trigger fired but no bond** → wait ~1-2 minutes for the BondVault.issueBond tx to confirm. If still missing after 10 min, check Basescan for your wallet's incoming ERC-1155 transfer

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐⭐

### What this does

Subscribe to `PolicyTriggered` events from `PolicyManagerV2`. The event fires the moment the oracle confirms a trigger and the bond mint is queued.

### Ready-to-use LLM prompt

```
You are an AI agent monitoring policy triggers on Lumina (Base Sepolia).

YOUR GOAL: Detect when the agent's policies trigger and a payout fires.

CONTEXT:
- PolicyManagerV2: 0xd9732A8d6Cf5266Dd896B825E78E387B7Dd2c379
- Event: PolicyTriggered(bytes32 indexed productId, uint256 indexed policyId,
                         address buyer, uint256 bondAmount, bytes32 reason)
- bondAmount is in INTEGER DOLLARS (1 token = $1, no decimals)
- Use a websocket RPC for real-time delivery; HTTP polling as fallback

INSTRUCTIONS:
1. Subscribe to PolicyTriggered via watchEvent / on('PolicyTriggered')
2. Filter client-side: log.args.buyer === your_wallet
3. On match, queue a redeem flow at maturity (~24 months later)
4. Cross-reference policyId against your tracked policies

WHEN TO STOP:
- Continuous monitoring; no terminal state
```

### HTTP examples (RPC websocket)

```typescript
import { createPublicClient, webSocket, parseAbiItem } from 'viem'

const client = createPublicClient({
  chain: baseSepolia,
  transport: webSocket('wss://base-sepolia-rpc.publicnode.com'),
})

const unwatch = client.watchEvent({
  address: '0xd9732A8d6Cf5266Dd896B825E78E387B7Dd2c379',
  event: parseAbiItem('event PolicyTriggered(bytes32 indexed productId, uint256 indexed policyId, address buyer, uint256 bondAmount, bytes32 reason)'),
  onLogs: (logs) => {
    for (const log of logs) {
      if (log.args.buyer?.toLowerCase() === MY_WALLET) {
        console.log('Triggered!', log.args)
      }
    }
  },
})
```

### Polling fallback

```python
import requests, time
last_block = 0
while True:
    # use eth_getLogs with fromBlock=last_block+1
    ...
    time.sleep(15)
```

## What happens after a trigger

1. `PolicyTriggered` event fires
2. `PolicyManagerV2` calls `BondVault.issueBond(buyer, usdPayout)`
3. `BondsMinted` event fires from `ClaimBond` (epoch-based ERC-1155)
4. Bond is redeemable in ~24 months at maturity → see [redeem-bond](./redeem-bond.md)

### Related skills

- [Track policies](./track-policies.md)
- [Receive ClaimBond](./receive-claimbond.md)
- [Get bonds owned](./get-bonds.md)

## Source

- Event definition: `LUMINA-PROTOCOL/src/core/PolicyManagerV2.sol:109` — `event PolicyTriggered`
- Trigger flow: `PolicyManagerV2.sol:229` — `triggerPayout(...)` (called by `CoverRouterV2.submitTrigger`)
- Bond mint cascade: `BondVault.sol:170` — `issueBond` → `ClaimBond.mint`
