import { Router } from "express";
import { z } from "zod";
import { ethers } from "ethers";
import { adminAuth } from "../middlewares/admin";
import { adminLimiter } from "../middlewares/rateLimit";
import { issueKey, revoke } from "../services/keys";
import { HttpError } from "../middlewares/error";

export const keysRouter = Router();

const GenerateSchema = z.object({
  wallet: z.string().refine(ethers.isAddress, "wallet must be a valid 0x address"),
  label: z.string().max(64).optional(),
});

keysRouter.post("/generate", adminLimiter, adminAuth, (req, res, next) => {
  try {
    const body = GenerateSchema.parse(req.body);
    const issued = issueKey(body.wallet, body.label);
    // Return plaintext exactly once. Caller MUST store it.
    res.status(201).json({
      ok: true,
      keyId: issued.keyId,
      apiKey: issued.plaintext,
      wallet: issued.wallet,
      tier: issued.tier,
      label: issued.label,
      createdAt: issued.createdAt,
      warning: "Store the apiKey now. It will not be shown again.",
    });
  } catch (e) {
    next(e);
  }
});

keysRouter.delete("/:id", adminLimiter, adminAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, "Invalid key id", "invalid_id");
    }
    const ok = revoke(id);
    if (!ok) throw new HttpError(404, "Key not found or already revoked", "key_not_found");
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});
