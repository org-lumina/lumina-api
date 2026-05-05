# Skill: Buy policy as Human (direct contract)

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

**For**: Humans · **Difficulty**: ⭐⭐ · **Time**: ~2 minutes

---

## What this does

Pay a USDC premium with your own wallet and receive a Lumina policy bound to your address. If the trigger fires during the policy term, you receive ClaimBonds (1 bond = $1 face). Atomic on-chain — the premium burns LUMINA in the same transaction.

## Before you start

- A Web3 wallet (MetaMask, Coinbase Wallet, Rainbow, or WalletConnect)
- Some test USDC on Base Sepolia (contact `labs@lumina-org.com` for the faucet path)
- ~$0.01 worth of Sepolia ETH for gas (any Base Sepolia faucet)
- Wallet connected to **Base Sepolia** (chainId 84532)

## Step by step

1. **Open the Lumina app** at https://lumina-org.com/app and click "Enter as Human"
2. **Connect your wallet** (top right) — see [connect-wallet](./connect-wallet.md)
3. **Pick a shield** from the products grid
4. **Choose your cover amount** with the slider ($100 – $100,000)
5. The right panel shows the live premium and payout
6. Click **"① Approve USDC"** — your wallet pops up. Confirm. Wait ~3 seconds for the on-chain confirm. The button turns green: ✓ ALLOWANCE OK
7. Click **"② Buy policy →"** — wallet pops up again. Confirm. Wait for confirmation
8. ✅ Done. Toast appears with a Basescan link to your tx

## What you'll see when it works

- Green banner: "✓ Confirmed. View on Basescan ↗ View portfolio →"
- Click "View portfolio" to see your new policy in `/app/human/portfolio`

## Common issues

- **"USDC insufficient"** → top up; need at least the premium amount
- **"Wrong network"** → click the red banner "Switch Network" → wallet prompts to switch
- **"Transaction rejected by user"** → you clicked Reject; click again
- **"Reverted: Product not configured"** → shield is paused or not deployed; pick another
- **Wallet says "Out of gas"** → top up Sepolia ETH

## What to do next

- **Wait for the trigger window**. Each shield has its own duration (1h to 7d).
- **Watch your policy** in `/app/human/portfolio` (Active Policies tab)
- **If trigger fires** → ClaimBond minted → see [receive-claimbond](./receive-claimbond.md)

## Technical reference

This skill calls `CoverRouterV2.purchasePolicy(bytes32 productId, uint256 coverageAmount, bytes32 asset)` directly from your wallet. `msg.sender` becomes the buyer; the premium routes to the TWAPBurner atomically inside the same tx.

The `asset` parameter is `bytes32` — the frontend passes `padHex(toHex('USDC'), { size: 32, dir: 'right' })`.

Required pre-step: USDC `approve(CoverRouterV2, premium)` — see [approve-usdc](./approve-usdc.md).

## Source

- Function: `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol:146` — `purchasePolicy`
- Internal flow: `CoverRouterV2.sol:179` — `_purchase`
- Premium pull: `CoverRouterV2.sol:210` — `usdc.safeTransferFrom`
- Burn forwarding: `CoverRouterV2.sol:213-214` — `usdc.forceApprove(twapBurner, premium)`
