import { Contract, type ContractRunner } from "ethers";
import UsdcArtifact from "../../abis/MockUSDC.json";
import { loadConfig } from "./config";

/**
 * Sprint L — Helper to build USDC contract handles bound to either the
 * read-only provider or the relayer signer.
 *
 * The repo already exposes a read-only `usdc` handle in `utils/ethers.ts`,
 * but the faucet route needs a signing handle to call `transfer`. We
 * centralise the artifact import here so both surfaces stay in sync.
 *
 * Address: `loadConfig().USDC` (mock SET A on Sepolia per ADR-010 —
 * `0x63D340AE7229BB464bC801f225651341ebcD3693`).
 */

interface Artifact {
  abi: ReadonlyArray<Record<string, unknown>>;
}

const cfg = loadConfig();

export function getUsdcContract(runner: ContractRunner): Contract {
  return new Contract(cfg.USDC, (UsdcArtifact as Artifact).abi as never, runner);
}
