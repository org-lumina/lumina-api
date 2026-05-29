# Skill: Redeem matured bond

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base mainnet 8453) but verify before use.

Both audiences. After ~24 months, exchange your matured ClaimBonds for $LUMINA at the current market price.

---

## 👤 For Humans

**Difficulty**: ⭐⭐ · **Time**: ~1 minute

### What this does

A ClaimBond has a face value in USD ($N). When it matures, you can redeem it: burn N bond tokens, receive $N worth of $LUMINA at the oracle price at the moment of redemption. Partial redemptions allowed.

### Before you start

- Wallet connected to Base mainnet
- A ClaimBond that's matured (status `MATURED`, not `HOLDING`)

### Step by step

1. Open `/app/human/portfolio` → "My Bonds" tab
2. Find the row with status **MATURED** (green pill)
3. Click **"Redeem for LUMINA →"**
4. Wallet pops up — confirm
5. After ~3 seconds: row updates to **✓ Redeemed**, your LUMINA balance (top right) increases

### What you'll see when it works

- Button changes from "Redeem for LUMINA →" to "✓ Redeemed"
- LUMINA balance in the topbar grows by the redemption amount
- A green status pill replaces the orange one

### Common issues

- **"Not matured" revert** → bond hasn't reached maturity timestamp; check the date on the row
- **"Insufficient bonds" revert** → you tried to redeem more than you hold (the UI auto-fills your full balance, but a stale read can race)
- **"Price too low" revert** → LUMINA price is below the redemption floor (`MIN_REDEEM_PRICE`); wait
- **"Insufficient reserve" revert** → BondVault doesn't have enough LUMINA to pay; very rare

### What to do next

- Bond burned, $LUMINA in wallet → use it as you wish (transfer, swap, hold)

---

## 🤖 For AI Agents (on-chain version)

**Type**: write · **Difficulty**: ⭐⭐

### What this does

Direct on-chain call to `BondVault.redeemBond(epochId, usdAmount)`. The agent's wallet must hold the bonds (ERC-1155) and the epoch must be matured.

### Ready-to-use LLM prompt

```
You are an AI agent redeeming Lumina bonds (Base mainnet).

YOUR GOAL: Burn matured ClaimBonds and receive LUMINA at market price.

CONTEXT:
- BondVault: 0x101F92fC506C1e60A2A0dD01eA29597EBf222d2B
- Function: redeemBond(uint256 epochId, uint256 usdAmount)
- usdAmount is INTEGER DOLLARS (= ERC-1155 token count, NOT 6-dec USDC, NOT 18-dec wei)
- claimBond.balanceOf(msg.sender, epochId) >= usdAmount required

INSTRUCTIONS:
1. Verify isMatured(epochId) === true
2. balance = ClaimBond.balanceOf(wallet, epochId)
3. If balance > 0: call BondVault.redeemBond(epochId, balance) for full redemption
4. Track BondRedeemed event for confirmation + luminaAmount received

WHEN TO STOP:
- Success: BondRedeemed event with your wallet
- Block: revert "Not matured" → wait until maturity
- Block: revert "Price too low" → LUMINA below floor; retry later
```

### TypeScript

```typescript
const balance = await client.readContract({
  address: CLAIM_BOND, abi, functionName: 'balanceOf', args: [wallet, epochId],
})

const txHash = await walletClient.writeContract({
  address: '0x101F92fC506C1e60A2A0dD01eA29597EBf222d2B',
  abi: bondVaultAbi,
  functionName: 'redeemBond',
  args: [epochId, balance],   // usdAmount = balance (integer dollars)
})
```

### For the API/relayer version

See [redeem-via-api](./redeem-via-api.md) — agent posts to `POST /api/v1/redeem` and the relayer signs.

## Source

- Function: `LUMINA-PROTOCOL/src/bonds/BondVault.sol:198` — `redeemBond(epochId, usdAmount)`
- Balance check: `BondVault.sol:201` — `claimBond.balanceOf(msg.sender, epochId) >= usdAmount`
- LUMINA payout math: `BondVault.sol:206` — `luminaAmount = (usdAmount * 1e36) / currentPrice`
- Event: `BondVault.sol:66` — `event BondRedeemed(holder indexed, epochId indexed, usdAmount, luminaAmount, price)`
