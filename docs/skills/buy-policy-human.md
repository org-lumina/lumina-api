# Skill: Buy policy as Human (direct contract)

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-06 (Base mainnet 8453) but verify before use.

> 💵 **Premium is always paid in USDC**, regardless of the `asset` field. The `asset` parameter on `POST /api/v1/policies` is the **covered asset** — what the policy insures against — not the payment token. Discover it via `GET /products` (`coveredAsset` field, added 2026-05-06).

## Products at a glance

| Symbol         | coveredAsset | paymentAsset | What it insures                              |
|----------------|--------------|--------------|----------------------------------------------|
| FLASHBTC1H-001 | BTC          | USDC         | BTC rapid price crashes within 1h            |
| FLASHBTC24-001 | BTC          | USDC         | BTC rapid price crashes within 24h           |
| FLASHBTC48-001 | BTC          | USDC         | BTC rapid price crashes within 48h           |
| FLASHETH1H-001 | ETH          | USDC         | ETH rapid price crashes within 1h            |
| FLASHETH24-001 | ETH          | USDC         | ETH rapid price crashes within 24h           |
| FLASHETH48-001 | ETH          | USDC         | ETH rapid price crashes within 48h           |

All 6 products use `payoutRatioBps = 8000` (80% payout on trigger, 20% deductible).

> ⏸️ **`RATESHOCK-001`** exists on-chain but is currently **paused (`active: false`) — not purchasable.** `FLASHBTC4H-001` and `MICRODEPEG-001` are **retired / not deployed** — do not attempt to buy them.

**For**: Humans · **Difficulty**: ⭐⭐ · **Time**: ~2 minutes

---

## What this does

Pay a USDC premium with your own wallet and receive a Lumina policy bound to your address. If the trigger fires during the policy term, you receive ClaimBonds (1 bond = $1 face). Atomic on-chain — the premium burns LUMINA in the same transaction.

## Before you start

- A Web3 wallet (MetaMask, Coinbase Wallet, Rainbow, or WalletConnect)
- Some test USDC on Base mainnet (contact `labs@lumina-org.com` for the faucet path)
- ~$0.01 worth of Base ETH for gas (any Base mainnet faucet)
- Wallet connected to **Base mainnet** (chainId 8453)

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
- **Wallet says "Out of gas"** → top up Base ETH

## What to do next

- **Wait for the trigger window**. Each shield has its own duration (1h to 7d).
- **Watch your policy** in `/app/human/portfolio` (Active Policies tab)
- **If trigger fires** → ClaimBond minted → see [receive-claimbond](./receive-claimbond.md)

## Technical reference

This skill calls `CoverRouterV2.purchasePolicy(bytes32 productId, uint256 coverageAmount, bytes32 asset)` directly from your wallet. `msg.sender` becomes the buyer; the premium routes to the TWAPBurner atomically inside the same tx.

The `asset` parameter is the **covered asset** (NOT the premium token — premium is always USDC). Each shield validates against a hardcoded literal: FlashBTC* → `BTC`, FlashETH* → `ETH`. The frontend passes `padHex(toHex(coveredAsset), { size: 32, dir: 'right' })` — e.g. for FlashBTC1h: `padHex(toHex('BTC'), { size: 32, dir: 'right' })`. Sending the wrong literal reverts with `InvalidAsset(bytes32)`.

Required pre-step: USDC `approve(CoverRouterV2, premium)` — see [approve-usdc](./approve-usdc.md). (Approval is always for USDC, even when buying a BTC/ETH/USDT shield, because the premium itself is USDC.)

## Source

- Function: `LUMINA-PROTOCOL/src/core/CoverRouterV2.sol:146` — `purchasePolicy`
- Internal flow: `CoverRouterV2.sol:179` — `_purchase`
- Premium pull: `CoverRouterV2.sol:210` — `usdc.safeTransferFrom`
- Burn forwarding: `CoverRouterV2.sol:213-214` — `usdc.forceApprove(twapBurner, premium)`
