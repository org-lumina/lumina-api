import { Contract, type ContractRunner } from "ethers";
import UsdcArtifact from "../../abis/MockUSDC.json";
import { loadConfig } from "./config";

/**
 * Sprint L — Helper to build USDC contract handles bound to either the
 * read-only provider or the relayer signer.
 *
 * Two surfaces:
 *
 * 1. `getUsdcContract(runner)` — the protocol's canonical USDC (the address
 *    in `/health.contracts.usdc`). On Base mainnet this is the Circle
 *    canonical USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and is
 *    NOT mintable. Used by `services/policies.ts` etc. for premium pulls.
 *
 * 2. `getMockUsdcContract(runner)` — the permissionless mintable mock USDC
 *    used by the faucet (`/api/v1/faucet/claim`). Address comes from
 *    `MOCK_USDC_ADDRESS` (default USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
 *    on Base mainnet sandbox). The faucet calls `mint(to, amount)` on this
 *    contract — anyone may call `mint`, so we don't need to pre-fund the
 *    relayer with USDC. Mainnet builds typically disable the faucet route.
 *
 * Both contracts use the same ABI shape (ERC-20 + a permissionless `mint`).
 */

interface Artifact {
  abi: ReadonlyArray<Record<string, unknown>>;
}

const cfg = loadConfig();

export function getUsdcContract(runner: ContractRunner): Contract {
  return new Contract(cfg.USDC, (UsdcArtifact as Artifact).abi as never, runner);
}

export function getMockUsdcContract(runner: ContractRunner): Contract {
  return new Contract(cfg.MOCK_USDC_ADDRESS, (UsdcArtifact as Artifact).abi as never, runner);
}
