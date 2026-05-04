# Skill: Approve USDC

> **Skill ID**: `approve-usdc` · **Audience**: Human · **Difficulty**: ⭐ Easy

## What this does

Before buying a policy on Lumina, you need to authorize the **CoverRouterV2** contract to pull USDC from your wallet. This is the standard ERC-20 `approve` pattern — required because the protocol pulls the premium atomically inside `purchasePolicy(...)`.

Confirmed by source: `CoverRouterV2.sol:210` — `usdc.safeTransferFrom(buyer, address(this), premium)`.

## Who needs this

- **Humans** (wallet flow): yes — approve once per wallet, then buy any number of policies up to the allowance.
- **AI agents** (relayer flow): the relayer holds USDC; the agent does NOT call `approve` from its own wallet for policy purchases.

## Contract & function

| | Sepolia testnet (V5.1) |
|---|---|
| Token | USDC (MockUSDC) |
| Token address | `0x63D340AE7229BB464bC801f225651341ebcD3693` |
| Function | `approve(address spender, uint256 amount)` |
| Spender (CoverRouterV2) | `0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316` |
| Decimals | 6 (USDC standard) |

## Code examples

### TypeScript + viem (recommended)

```ts
import { createWalletClient, custom, parseUnits, erc20Abi } from 'viem'
import { baseSepolia } from 'viem/chains'

const USDC = '0x63D340AE7229BB464bC801f225651341ebcD3693'
const COVER_ROUTER = '0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316'

const client = createWalletClient({
  chain: baseSepolia,
  transport: custom(window.ethereum!),
})
const [account] = await client.getAddresses()

// Approve exactly the premium amount you'll spend
const premium = parseUnits('2.40', 6) // $2.40 USDC

const txHash = await client.writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'approve',
  args: [COVER_ROUTER, premium],
  account,
})
```

### TypeScript + wagmi (React)

```tsx
import { useWriteContract } from 'wagmi'
import { erc20Abi, parseUnits } from 'viem'

function ApproveButton({ premium }: { premium: bigint }) {
  const { writeContract, isPending } = useWriteContract()
  return (
    <button
      onClick={() =>
        writeContract({
          address: '0x63D340AE7229BB464bC801f225651341ebcD3693',
          abi: erc20Abi,
          functionName: 'approve',
          args: ['0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316', premium],
        })
      }
      disabled={isPending}
    >
      {isPending ? 'Approving…' : `Approve $${Number(premium) / 1e6}`}
    </button>
  )
}
```

### Check existing allowance first

```ts
import { readContract } from 'viem/actions'

const allowance = await client.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [account, COVER_ROUTER],
})

if (allowance < premium) {
  // need to approve
}
```

## Common patterns

- **Approve max** (`type(uint256).max` = `2n ** 256n - 1n`): single approval, never need to approve again. Convenient but slightly higher counter-party risk.
- **Approve exact**: safer per transaction, requires a fresh `approve` before each policy purchase.
- **Approve and remember**: track the allowance client-side to skip future approvals.

## Errors and edge cases

| Error | Why | Fix |
|---|---|---|
| `ERC20InsufficientBalance` | wallet has less USDC than premium | top up via faucet / mock mint |
| user-rejected | user clicked "Reject" in wallet | retry, no-op |
| `ERC20InvalidApprover(0x0)` | zero address as msg.sender | impossible from a real wallet |
| Front-running on raw `approve` | known ERC-20 quirk if you decrease an existing non-zero allowance | use `approve(0)` then `approve(N)`, or use OpenZeppelin's `SafeERC20.safeIncreaseAllowance` |

Note: the protocol uses `forceApprove` internally (`CoverRouterV2.sol:214`) when forwarding to TWAPBurner to avoid this issue server-side. Your wallet-side `approve` to CoverRouterV2 follows standard ERC-20.

## Related skills

- [Buy policy as Human](./buy-policy-human.md) — uses the allowance approved here
- [Buy policy as Agent](./buy-policy-agent.md) — relayer pattern, no user approve required
- [Quote a parametric policy](./quote-policy.md) — get the premium amount to approve

## Source

- ERC-20 standard: [OpenZeppelin IERC20](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/IERC20.sol)
- Spender used: [CoverRouterV2.sol:210](https://github.com/org-lumina/LUMINA-PROTOCOL/blob/main/src/core/CoverRouterV2.sol#L210) (`safeTransferFrom`)
- Token addresses: [lib/lumina-config.ts](https://github.com/org-lumina/v0-lumina-landing-page/blob/main/lib/lumina-config.ts) in the frontend repo
