import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { getBondsByWallet, type BondStatusFilter } from "../services/bonds";

export const bondsAuthRouter = Router();

const WalletSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");
const StatusSchema = z.enum(["active", "matured", "redeemed", "all"]).default("all");
const LimitSchema = z.coerce.number().int().positive().max(500).default(100);
const OffsetSchema = z.coerce.number().int().nonnegative().default(0);

const QuerySchema = z.object({
  status: StatusSchema,
  limit: LimitSchema,
  offset: OffsetSchema,
});

// [Audit #33 RL-1] auth must run before apiLimiter so the per-agent counter
// uses req.agent.id (not the IP) once a key is verified.
bondsAuthRouter.get("/:wallet", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");

    // Spec edge case: "Wallet inválida → 400 invalid_address" — surface a
    // discrete code instead of the generic validation_error.
    const walletParse = WalletSchema.safeParse(req.params.wallet);
    if (!walletParse.success) {
      throw new HttpError(400, "Wallet must be a valid 0x address", "invalid_address");
    }
    const { status, limit, offset } = QuerySchema.parse(req.query);

    const result = await getBondsByWallet(walletParse.data, {
      status: status as BondStatusFilter,
      limit,
      offset,
    });

    res.json(result);
  } catch (e) {
    next(e);
  }
});
