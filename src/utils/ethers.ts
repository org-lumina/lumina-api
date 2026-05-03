import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "./config";

import CoverRouterArtifact from "../../abis/CoverRouterV2.json";
import PolicyManagerArtifact from "../../abis/PolicyManagerV2.json";
import ClaimBondArtifact from "../../abis/ClaimBond.json";
import BondVaultArtifact from "../../abis/BondVault.json";
import LuminaTokenArtifact from "../../abis/LuminaTokenV2.json";
import UsdcArtifact from "../../abis/MockUSDC.json";
import ShieldArtifact from "../../abis/IShield.json";

interface Artifact {
  abi: ReadonlyArray<Record<string, unknown>>;
}

const cfg = loadConfig();

export const provider = new JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, {
  staticNetwork: true,
});

export const relayer = new Wallet(cfg.RELAYER_PRIVATE_KEY, provider);

function readonly(address: string, artifact: Artifact): Contract {
  return new Contract(address, artifact.abi as never, provider);
}

function withSigner(address: string, artifact: Artifact): Contract {
  return new Contract(address, artifact.abi as never, relayer);
}

// Read-only handles (use for view calls)
export const coverRouter = readonly(cfg.COVER_ROUTER, CoverRouterArtifact as Artifact);
export const policyManager = readonly(cfg.POLICY_MANAGER, PolicyManagerArtifact as Artifact);
export const claimBond = readonly(cfg.CLAIM_BOND, ClaimBondArtifact as Artifact);
export const bondVault = readonly(cfg.BOND_VAULT, BondVaultArtifact as Artifact);
export const luminaToken = readonly(cfg.LUMINA_TOKEN, LuminaTokenArtifact as Artifact);
export const usdc = readonly(cfg.USDC, UsdcArtifact as Artifact);

// Signing handles (relayer)
export const coverRouterRelayer = withSigner(cfg.COVER_ROUTER, CoverRouterArtifact as Artifact);

/**
 * Build a read-only Shield handle. Each product has its own Shield address —
 * resolved via `policyManager.productShield(productId)` — so the contract is
 * built per-call rather than as a module-level constant.
 */
export function getShield(address: string): Contract {
  return new Contract(address, (ShieldArtifact as Artifact).abi as never, provider);
}
