import { createConfig } from "ponder";
import { http, fallback } from "viem";

import { abi as CoverRouterAbi } from "./abis/CoverRouterV2";
import { abi as ClaimBondAbi } from "./abis/ClaimBond";
import { abi as BondVaultAbi } from "./abis/BondVault";
import { abi as TwapBurnerAbi } from "./abis/TWAPBurner";
import { abi as FounderVestingAbi } from "./abis/FounderVesting";
import { abi as MarketplaceAbi } from "./abis/LuminaBondMarketplace";

/**
 * LUMINA Ponder indexer config — Base Sepolia (84532); mainnet later via env.
 *
 * RPC: prefers RPC_URL_QUICKNODE (the free Alchemy/public endpoints are
 * rate-limited under the indexer's eth_getLogs streaming), falling back to
 * RPC_URL and the public Base endpoint — mirrors the API FallbackProvider.
 *
 * Addresses come from env so a redeploy needs no code change; they MUST be set
 * in production (default = zero address = indexes nothing). Start block
 * defaults to the V5.4 genesis block 41,680,286 (override via
 * DEPLOYMENT_BLOCK_CLAIMBOND). All six contracts share the start block.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const env = process.env as Record<string, string | undefined>;
// V5.4 genesis on Base Sepolia. Mirrors lumina-api's getStartBlock() guard:
// ONLY honor DEPLOYMENT_BLOCK_CLAIMBOND when it's a valid positive integer.
// A bare `Number(env ?? default)` is unsafe — `??` does NOT catch an empty
// string (a common Railway value), and `Number("") === 0` would make Ponder
// backfill from genesis (~42M blocks), so it never reaches recent events and
// /indexer/health appears stuck at lastSyncedBlock=0.
const GENESIS_BLOCK_V54 = 41_680_286;
function resolveStartBlock(): number {
  const raw = env.DEPLOYMENT_BLOCK_CLAIMBOND;
  if (raw && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return GENESIS_BLOCK_V54;
}
const START_BLOCK = resolveStartBlock();
const TRANSPORT = fallback([
  http(env.RPC_URL_QUICKNODE),
  http(env.RPC_URL),
  http("https://sepolia.base.org"),
]);

export default createConfig({
  chains: {
    baseSepolia: {
      id: 84532,
      rpc: TRANSPORT,
    },
  },
  contracts: {
    CoverRouterV2: {
      chain: "baseSepolia",
      abi: CoverRouterAbi,
      address: (env.COVER_ROUTER ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: START_BLOCK,
    },
    // ClaimBond (ERC-1155): indexed for TransferSingle/TransferBatch → the
    // canonical holdings ledger (mints, marketplace transfers, redemptions).
    ClaimBond: {
      chain: "baseSepolia",
      abi: ClaimBondAbi,
      address: (env.CLAIM_BOND ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: START_BLOCK,
    },
    BondVault: {
      chain: "baseSepolia",
      abi: BondVaultAbi,
      address: (env.BOND_VAULT ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: START_BLOCK,
    },
    TWAPBurner: {
      chain: "baseSepolia",
      abi: TwapBurnerAbi,
      address: (env.TWAP_BURNER ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: START_BLOCK,
    },
    Marketplace: {
      chain: "baseSepolia",
      abi: MarketplaceAbi,
      address: (env.MARKETPLACE ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: START_BLOCK,
    },
    FounderVesting: {
      chain: "baseSepolia",
      abi: FounderVestingAbi,
      address: (env.FOUNDER_VESTING ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: START_BLOCK,
    },
  },
});
