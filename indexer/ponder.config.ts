import { createConfig } from "ponder";
import { http, fallback } from "viem";

import CoverRouterAbi from "../abis/CoverRouterV2.json" with { type: "json" };
import ClaimBondAbi from "../abis/ClaimBond.json" with { type: "json" };
import BondVaultAbi from "../abis/BondVault.json" with { type: "json" };
import TwapBurnerAbi from "../abis/TWAPBurner.json" with { type: "json" };
// FounderVesting ABI is not currently in lumina-api/abis. Founder must
// drop the JSON in `abis/FounderVesting.json` (from foundry's `out/`)
// before the first `ponder dev` run. Stub line 26 will fail until then.

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
 * require a code change. Defaults match the Sprint H manifest snapshot.
 */
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
      address: (process.env.COVER_ROUTER ??
        "0xFA6d57CA87a26F08d68f2123e86990E2fD70B7AE") as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    ClaimBond: {
      network: "baseSepolia",
      abi: ClaimBondAbi as never,
      address: (process.env.CLAIM_BOND ??
        "0xde85056F155d3F18e559Fa63d5861ab3D1318cF0") as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    BondVault: {
      network: "baseSepolia",
      abi: BondVaultAbi as never,
      address: (process.env.BOND_VAULT ??
        "0x9EfdD63B13543B30B49b2b423903233220B3726c") as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    TWAPBurner: {
      network: "baseSepolia",
      abi: TwapBurnerAbi as never,
      address: ((process.env as Record<string, string | undefined>).TWAP_BURNER ??
        "0xc838BEDE6BE624f6b7b69be71b7587ce51186D75") as `0x${string}`,
      startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    },
    // FounderVesting handler stubbed until ABI is dropped into abis/.
    // FounderVesting: {
    //   network: "baseSepolia",
    //   abi: FounderVestingAbi as never,
    //   address: process.env.FOUNDER_VESTING ?? "0xa3e7685E21A141930F63432E927D679fD3FDE876",
    //   startBlock: Number(process.env.DEPLOYMENT_BLOCK_CLAIMBOND ?? "0"),
    // },
  },
});
