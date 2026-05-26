import { Router } from "express";
import { z } from "zod";
import { getBondsByWallet } from "../services/bonds";
import { getPoliciesByWallet } from "../services/policies";

/**
 * Public, UNAUTHENTICATED, read-only by-wallet views. Everything served here is
 * already public on-chain data — this router just centralizes the reconstruction
 * (server-side, cached ~30s) so the browser doesn't run a wide eth_getLogs scan
 * (the cause of the marketplace/portfolio "FAILED TO LOAD" / 429s). Mirrors the
 * marketplace-listings public pattern. No PII, no auth.
 */
export const publicRouter = Router();

const WalletSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "wallet must be a 20-byte hex address");

// GET /api/v1/public/policies/:wallet
publicRouter.get("/policies/:wallet", async (req, res, next) => {
  try {
    const wallet = WalletSchema.parse(req.params.wallet);
    const policies = await getPoliciesByWallet(wallet);
    res.json({ wallet, count: policies.length, policies });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/public/bonds/:wallet  (?status=active|matured|redeemed|all)
const BondsQuery = z.object({
  status: z.enum(["active", "matured", "redeemed", "all"]).default("all"),
});
publicRouter.get("/bonds/:wallet", async (req, res, next) => {
  try {
    const wallet = WalletSchema.parse(req.params.wallet);
    const { status } = BondsQuery.parse(req.query);
    const result = await getBondsByWallet(wallet, { status, limit: 200, offset: 0 });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
