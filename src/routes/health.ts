import { Router } from "express";
import { provider, relayer } from "../utils/ethers";
import { loadConfig } from "../utils/config";

const cfg = loadConfig();
export const healthRouter = Router();

healthRouter.get("/", async (_req, res, next) => {
  try {
    const [block, balance, network] = await Promise.all([
      provider.getBlockNumber(),
      provider.getBalance(relayer.address),
      provider.getNetwork(),
    ]);
    res.json({
      status: "ok",
      service: "lumina-api",
      version: process.env.npm_package_version ?? "0.1.0",
      uptimeSeconds: Math.floor(process.uptime()),
      chain: {
        chainId: Number(network.chainId),
        block,
        rpcConnected: true,
      },
      relayer: {
        address: relayer.address,
        balanceWei: balance.toString(),
      },
      contracts: {
        coverRouter: cfg.COVER_ROUTER,
        policyManager: cfg.POLICY_MANAGER,
        bondVault: cfg.BOND_VAULT,
        claimBond: cfg.CLAIM_BOND,
        marketplace: cfg.MARKETPLACE,
        usdc: cfg.USDC,
        luminaToken: cfg.LUMINA_TOKEN,
      },
    });
  } catch (e) {
    next(e);
  }
});
