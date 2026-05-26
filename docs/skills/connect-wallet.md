# Skill: Connect Wallet via RainbowKit

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

> **Skill ID**: `connect-wallet` · **Audience**: Human · **Difficulty**: ⭐ Easy

## What this does

Connect a Web3 wallet (MetaMask, Coinbase Wallet, Rainbow, or any WalletConnect-compatible wallet) to the Lumina interface. This is the first step for any human user before quoting, buying, redeeming, or listing on the marketplace.

## Who needs this

**Humans only.** AI agents authenticate via API keys (see [generate-api-key](./generate-api-key.md)) and never touch the wallet UI — the relayer pays gas on their behalf.

## Supported wallets

The frontend bundles RainbowKit's `connectorsForWallets` with this set:

| Wallet | Connector |
|---|---|
| MetaMask | `metaMaskWallet` |
| Coinbase Wallet | `coinbaseWallet` |
| Rainbow | `rainbowWallet` |
| WalletConnect | `walletConnectWallet` (any WC-compatible wallet — Ledger Live, Trust, Argent, etc.) |

## Network (Base Sepolia testnet — V5.1 deploy)

| | Value |
|---|---|
| Network name | Base Sepolia |
| Chain ID | **84532** |
| Hex chain ID | `0x14a34` |
| RPC URL (default) | `https://sepolia.base.org` (overridable via `NEXT_PUBLIC_RPC_URL`) |
| Explorer | https://sepolia.basescan.org |
| Native gas token | ETH (Sepolia) |
| USDC token (MockUSDC) | `0xD944d8e5D8329994D83950872Ec210891d3Ab6AE` |

## Auto-switch behavior

If your wallet is connected to the wrong chain (anything other than 84532), the operate-app shows a red banner with a one-click **"Switch to Base Sepolia"** button. The button calls `useSwitchChain({ chainId: baseSepolia.id })` from wagmi.

If your wallet has no Base Sepolia configured, the switch attempt prompts the wallet to add the network.

## Get test USDC

Lumina uses **MockUSDC** on Sepolia. To request test tokens for your wallet, contact `labs@lumina-org.com`. Public faucet endpoint pending.

## Frontend integration code

The provider config that makes this work is in [`components/lumina/web3-provider.tsx`](https://github.com/org-lumina/v0-lumina-landing-page/blob/main/components/lumina/web3-provider.tsx):

```tsx
import { getDefaultConfig, RainbowKitProvider, darkTheme, connectorsForWallets } from '@rainbow-me/rainbowkit'
import { metaMaskWallet, coinbaseWallet, rainbowWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@rainbow-me/rainbowkit/styles.css'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!

const connectors = connectorsForWallets(
  [{ groupName: 'Recommended', wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet, walletConnectWallet] }],
  { appName: 'Lumina Protocol', projectId },
)

const config = createConfig({
  connectors,
  chains: [baseSepolia],
  transports: { [baseSepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL) },
  ssr: true,
})

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={new QueryClient()}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#00d4ff' })} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
```

### Triggering the connect modal

```tsx
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'

function ConnectButton() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { openConnectModal } = useConnectModal()

  if (isConnected) {
    return <button onClick={() => disconnect()}>{address?.slice(0, 6)}…{address?.slice(-4)}</button>
  }
  return <button onClick={() => openConnectModal?.()}>Connect Wallet</button>
}
```

## Required env var

```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<get one at https://cloud.walletconnect.com>
```

The placeholder `demo-project-id` is heavily rate-limited — the production frontend logs a console error if it detects the placeholder at runtime ([Audit #35 WC-1](https://github.com/org-lumina/v0-lumina-landing-page/commit/bfa7b04)).

## Troubleshooting

| Problem | Fix |
|---|---|
| "Wrong network" banner stuck | Click "Switch to Base Sepolia" — if it fails, switch manually in MetaMask → Networks → Add Network → use values above |
| Connection refused | Hard refresh (Ctrl+F5) to bust the no-cache headers; try a different connector |
| WalletConnect QR doesn't appear | Check pop-up blocker / allow third-party cookies for `walletconnect.com` |
| Wallet drops connection on tab change | Some wallets (e.g., MetaMask Mobile) lose the WC session — reopen the modal |

## Mainnet timeline

When Lumina ships to mainnet, the network switches to **Base L2** (chain ID **8453**) and USDC becomes the real Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). The skill itself doesn't change — only the addresses and chain id.

## Related skills

- [Browse the Shields catalog](./browse-shields.md)
- [Buy policy as Human (direct)](./buy-policy-human.md)
- [Approve USDC](./approve-usdc.md) — required before the first purchase

## Source

- Frontend provider: [`components/lumina/web3-provider.tsx`](https://github.com/org-lumina/v0-lumina-landing-page/blob/main/components/lumina/web3-provider.tsx) (`createConfig` line 61, `chains: [baseSepolia]` line 63)
- Chain config: [`wagmi/chains` `baseSepolia`](https://github.com/wevm/wagmi/blob/main/packages/core/src/chains.ts)
- WC project id env var check: [`web3-provider.tsx:19-43`](https://github.com/org-lumina/v0-lumina-landing-page/blob/main/components/lumina/web3-provider.tsx#L19) (audit fix #35 WC-1)
