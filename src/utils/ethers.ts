import { Contract, FallbackProvider, JsonRpcProvider, Network, NonceManager, Wallet } from "ethers";
import { loadConfig } from "./config";

import CoverRouterArtifact from "../../abis/CoverRouterV2.json";
import PolicyManagerArtifact from "../../abis/PolicyManagerV2.json";
import ClaimBondArtifact from "../../abis/ClaimBond.json";
import BondVaultArtifact from "../../abis/BondVault.json";
import LuminaTokenArtifact from "../../abis/LuminaTokenV2.json";
import UsdcArtifact from "../../abis/MockUSDC.json";
import GlobalPauseRegistryArtifact from "../../abis/GlobalPauseRegistry.json";
import ShieldArtifact from "../../abis/IShield.json";
import MarketplaceArtifact from "../../abis/LuminaBondMarketplace.json";

interface Artifact {
  abi: ReadonlyArray<Record<string, unknown>>;
}

const cfg = loadConfig();

// [Sprint F] Multi-RPC FallbackProvider.
// Primary: RPC_URL (Alchemy, weight 2). Fallbacks: RPC_URL_QUICKNODE (when set,
// weight 1) and RPC_URL_PUBLIC (defaults to https://sepolia.base.org, weight 1).
// `quorum: 1` means the first provider to respond wins — no consensus needed.
// `stallTimeout: 2000` ms before ethers tries the next provider.
const PUBLIC_FALLBACK = "https://sepolia.base.org";
const network = Network.from(cfg.CHAIN_ID);

function jsonRpc(url: string): JsonRpcProvider {
  return new JsonRpcProvider(url, network, { staticNetwork: true });
}

const fallbackProviders: { provider: JsonRpcProvider; priority: number; weight: number; stallTimeout: number }[] = [
  { provider: jsonRpc(cfg.RPC_URL), priority: 1, weight: 2, stallTimeout: 2000 },
];
if (cfg.RPC_URL_QUICKNODE) {
  fallbackProviders.push({ provider: jsonRpc(cfg.RPC_URL_QUICKNODE), priority: 2, weight: 1, stallTimeout: 2000 });
}
fallbackProviders.push({
  provider: jsonRpc(cfg.RPC_URL_PUBLIC ?? PUBLIC_FALLBACK),
  priority: 3,
  weight: 1,
  stallTimeout: 2000,
});

export const provider: FallbackProvider = new FallbackProvider(fallbackProviders, network, { quorum: 1 });

// `relayer` signs txs. ethers v6 lets a Wallet attach to either a JsonRpcProvider
// or a FallbackProvider; for the latter, broadcasts go through the elected
// primary, while reads can fan out across the fallbacks.
//
// We keep the bare `Wallet` exported as `relayer` because callers read its
// synchronous `.address` (health/faucet/policies pre-flights) and the faucet
// calls `relayer.sendTransaction(...)` directly — `NonceManager` exposes
// `getAddress()` (async) but no sync `.address`, so swapping it here would
// break those sites.
export const relayer = new Wallet(cfg.RELAYER_PRIVATE_KEY, provider);

// [MR-H02] Belt-and-suspenders: wrap the SAME wallet in a NonceManager and use
// it as the runner for tx-sending contract handles. NonceManager tracks the
// next nonce locally so back-to-back sends don't both fetch the same pending
// nonce from the RPC. The `withLock(RELAYER_TX_LOCK_KEY, …)` around every
// send (faucet + purchase) is the authoritative serialiser — it guarantees
// the NonceManager and the bare Wallet never have concurrent in-flight sends,
// so their nonce views can't diverge. The lock alone is sufficient; the
// NonceManager is a defence-in-depth layer against any future un-locked send.
export const relayerNonceManaged = new NonceManager(relayer);

function readonly(address: string, artifact: Artifact): Contract {
  return new Contract(address, artifact.abi as never, provider);
}

function withSigner(address: string, artifact: Artifact): Contract {
  return new Contract(address, artifact.abi as never, relayerNonceManaged);
}

// Read-only handles (use for view calls)
export const coverRouter = readonly(cfg.COVER_ROUTER, CoverRouterArtifact as Artifact);
export const policyManager = readonly(cfg.POLICY_MANAGER, PolicyManagerArtifact as Artifact);
export const claimBond = readonly(cfg.CLAIM_BOND, ClaimBondArtifact as Artifact);
export const bondVault = readonly(cfg.BOND_VAULT, BondVaultArtifact as Artifact);
export const luminaToken = readonly(cfg.LUMINA_TOKEN, LuminaTokenArtifact as Artifact);
export const usdc = readonly(cfg.USDC, UsdcArtifact as Artifact);
export const marketplace = readonly(cfg.MARKETPLACE, MarketplaceArtifact as Artifact);

// Signing handles (relayer)
export const coverRouterRelayer = withSigner(cfg.COVER_ROUTER, CoverRouterArtifact as Artifact);

/**
 * [V5.1 M-7] Build a read-only handle to the GlobalPauseRegistry pointed-to
 * by `CoverRouterV2.globalPauseRegistry()`. Returns `undefined` when the
 * registry is unset (`address(0)`), in which case the protocol-wide pause
 * check is a no-op (matches the `whenNotPaused` modifier semantics).
 *
 * Resilience note: the `globalPauseRegistry()` selector was removed from
 * `CoverRouterV2` in a post-V5.3 cleanup upgrade. Calls against the live
 * proxy now revert with "execution reverted" (selector not present in the
 * implementation bytecode). The try/catch keeps the API responsive — when
 * the selector is missing we treat the registry as unset (returns
 * `undefined`) instead of letting the revert escape and surface as a 500.
 * If a future upgrade re-introduces the selector the wrapper transparently
 * works again without code changes.
 */
export async function getGlobalPauseRegistry(): Promise<Contract | undefined> {
  let addr: string;
  try {
    addr = (await coverRouter.globalPauseRegistry()) as string;
  } catch {
    return undefined;
  }
  if (!addr || addr === "0x0000000000000000000000000000000000000000") return undefined;
  return new Contract(addr, (GlobalPauseRegistryArtifact as Artifact).abi as never, provider);
}

/**
 * Build a read-only Shield handle. Each product has its own Shield address —
 * resolved via `policyManager.productShield(productId)` — so the contract is
 * built per-call rather than as a module-level constant.
 */
export function getShield(address: string): Contract {
  return new Contract(address, (ShieldArtifact as Artifact).abi as never, provider);
}
