import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { verifyRedemption } from "../services/redeem";
import { getRedemptionByTxHash, recordRedemption } from "../db/database";

export const redeemAuthRouter = Router();

const TxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 32-byte hex");
const AddressSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");
const UintStringSchema = z.string().regex(/^\d+$/, "must be a positive integer string");

const RedeemSchema = z
  .object({
    epochId: UintStringSchema.optional(),
    bondId: UintStringSchema.optional(),
    usdAmount: UintStringSchema,
    txHash: TxHashSchema,
    ownerAddress: AddressSchema,
  })
  .refine((v) => Boolean(v.epochId ?? v.bondId), {
    message: "epochId (or bondId alias) is required",
    path: ["epochId"],
  });

// [Audit #33 RL-1] authMiddleware MUST run before apiLimiter so the limiter's
// keyGenerator can read req.agent and apply per-agent (not per-IP) counters.
redeemAuthRouter.post("/", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const body = RedeemSchema.parse(req.body);
    const epochId = (body.epochId ?? body.bondId) as string;

    const existing = getRedemptionByTxHash(body.txHash);
    if (existing) {
      throw new HttpError(409, "Redemption already registered for this txHash", "duplicate_redemption");
    }

    const verified = await verifyRedemption({
      epochId,
      usdAmount: body.usdAmount,
      txHash: body.txHash,
      ownerAddress: body.ownerAddress,
    });

    let row;
    try {
      row = recordRedemption({
        epoch_id: verified.epochId,
        owner_address: verified.ownerAddress,
        tx_hash: verified.txHash,
        usd_amount: verified.usdAmount,
        lumina_received: verified.luminaReceived,
        price_used: verified.priceUsed,
        block_number: verified.blockNumber,
        submitted_by: req.agent.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string } | null)?.code;
      if (code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(msg)) {
        throw new HttpError(409, "Redemption already registered for this txHash", "duplicate_redemption");
      }
      throw e;
    }

    res.status(200).json({
      success: true,
      txHash: row.tx_hash,
      epochId: row.epoch_id,
      ownerAddress: row.owner_address,
      luminaReceived: row.lumina_received,
      priceUsed: row.price_used,
      blockNumber: row.block_number,
    });
  } catch (e) {
    next(e);
  }
});
