import { createConfig } from "ponder";
import { http, fallback } from "viem";

import CoverRouterAbi from "./abis/CoverRouterV2.json" with { type: "json" };
import ClaimBondAbi from "./abis/ClaimBond.json" with { type: "json" };
import BondVaultAbi from "./abis/BondVault.json" with { type: "json" };
import TwapBurnerAbi from "./abis/TWAPBurner.json" with { type: "json" };
import FounderVestingAbi from "./abis/FounderVesting.json" with { type: "json" };

/**
 * Sprint J — Ponder indexer config.
 *
 * Networks: Base Sepolia (chainId 84532). Mainnet later via env switch.
 *
 * RPC: prefers `RPC_URL_QUICKNODE` (public/free Alchemy is rate-limited
 * heavily for the indexer's eth_getLogs streaming pattern). Falls back to
 * the primary RPC_URL and the public Base endpoint, mirroring the API's
 * FallbackProvider topology (Sprint F).
 *
 * Contract addresses are sourced from environment so a redeploy doesn't
 * require a code change. Sprint Z.2: literal defaults removed pre-redeploy;
 * fallback is the zero address — env vars MUST be set in production.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const TRANSPORT = fallback([
  http(process.env.RPC_URL_QUICKNODE),
  http(process.env.RPC_URL),
  http("https://sepolia.base.org"),
]);

export default createConfig({
  networks: {
    baseSepolia: {
      chainId: 84532,
      transport: TRANSPORT,
    },
  },
  contracts: {
    CoverRouterV2: {
      network: "baseSepolia",
      abi: CoverRouterAbi as never,
      address: (process.env.COVER_ROUTER ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    ClaimBond: {
      network: "baseSepolia",
      abi: ClaimBondAbi as never,
      address: (process.env.CLAIM_BOND ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    BondVault: {
      network: "baseSepolia",
      abi: BondVaultAbi as never,
      address: (process.env.BOND_VAULT ?? ZERO_ADDRESS) as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    TWAPBurner: {
      network: "baseSepolia",
      abi: TwapBurnerAbi as never,
      address: ((process.env as Record<string, string | undefined>).TWAP_BURNER ??
        ZERO_ADDRESS) as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    FounderVesting: {
      network: "baseSepolia",
      abi: FounderVestingAbi as never,
      address: ((process.env as Record<string, string | undefined>).FOUNDER_VESTING ??
        ZERO_ADDRESS) as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
  },
});
