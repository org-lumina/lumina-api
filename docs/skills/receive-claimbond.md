# Skill: Receive ClaimBond on trigger

Both audiences. Information about what happens automatically when a policy you bought triggers.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: passive (no action needed)

### What this does

NOTHING for you to actively do. When the oracle confirms your policy's trigger condition, the protocol AUTOMATICALLY mints ClaimBond ERC-1155 tokens to your wallet — no clicking, no signing, no gas. The bond is your right to redeem `face_value` worth of $LUMINA at maturity (~24 months later).

### How it works (under the hood)

1. Chainlink oracle posts the trigger price
2. Anyone calls `submitTrigger(productId, policyId, oracleProof)` — usually a keeper bot
3. `PolicyManagerV2.triggerPayout` runs: marks the policy triggered + emits `PolicyTriggered`
4. `BondVault.issueBond(buyer, usdPayout)` runs: mints ClaimBond ERC-1155 tokens to your wallet
5. `BondsMinted(epochId, to=you, usdAmount)` event fires
6. ✅ You now own bonds

### Step by step (verification only)

1. Open `/app/human/portfolio` → Active Policies tab
2. The triggered policy shows status `triggered` (instead of `active`)
3. Switch to "My Bonds" tab → new row with the bonds

### Common issues

- **Trigger fired but no bond yet** → wait ~1-2 minutes for the bond mint tx to confirm
- **Bond shows but face value seems off** → 1 token = $1 face. Display shows integer dollars, not 6-dec USDC

### What to do next

- Wait for maturity (24 months) → see [Redeem matured bond](./redeem-bond.md)
- Or sell early at a discount → see [List bond](./list-bond.md)

---

## 🤖 For AI Agents

**Type**: read (event listener) · **Difficulty**: ⭐⭐

### What this does

This is a passive flow — your only "action" is detecting that the bond was minted. Listen to `BondsMinted` (with `to` indexed → topic filter works) or watch for incoming ERC-1155 transfers.

### Ready-to-use LLM prompt

```
You are an AI agent watching for incoming ClaimBonds on Lumina (Base Sepolia).

YOUR GOAL: Detect when a triggered policy results in a bond mint to your wallet.

CONTEXT:
- ClaimBond: 0x5304f6732a51995651f1B666525CFeC5Af74A541 (ERC-1155)
- Event: BondsMinted(uint256 indexed epochId, address indexed to, uint256 usdAmount)
- The protocol auto-mints — agent does NOT call anything here

INSTRUCTIONS:
1. Subscribe to BondsMinted with args:{ to: agent_wallet }
2. On each event, persist (epochId, usdAmount, blockNumber)
3. Schedule a redeem reminder for that epoch's maturity timestamp
   (use ClaimBond.getEpochInfo(epochId).maturity)

WHEN TO STOP:
- Continuous monitoring; no terminal state
```

### HTTP examples

```typescript
client.watchEvent({
  address: '0x5304f6732a51995651f1B666525CFeC5Af74A541',
  event: parseAbiItem('event BondsMinted(uint256 indexed epochId, address indexed to, uint256 usdAmount)'),
  args: { to: AGENT_WALLET },
  onLogs: (logs) => {
    logs.forEach(l => persist({
      epoch: l.args.epochId,
      usd: l.args.usdAmount,  // INTEGER DOLLARS, not 6-dec
      block: l.blockNumber,
    }))
  },
})
```

### Important: usdAmount units

`BondsMinted.usdAmount` is in INTEGER DOLLARS (1 token = $1). Do NOT divide by 1e6 or 1e18.

### Related skills

- [Watch triggers](./watch-triggers.md)
- [Get bonds owned](./get-bonds.md)
- [Redeem bond](./redeem-bond.md)

## Source

- Trigger entry: `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol:172` — `submitTrigger`
- Bond issuance: `LUMINA-PROTOCOL/src/bonds/BondVault.sol:170` — `issueBond` (only PolicyManager)
- Event: `LUMINA-PROTOCOL/src/bonds/ClaimBond.sol:34` — `event BondsMinted` (`to` indexed)
- ClaimBond mint: `ClaimBond.sol:83` — `mint(to, epochId, usdAmount)`
