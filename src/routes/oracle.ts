import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { HttpError } from "../middlewares/error";
import { signPriceProof, getSignerAddress } from "../services/oracleSigner";
import { getCurrentPrice } from "../services/chainlinkPrices";

export const oracleAuthRouter = Router();

const SignProofBody = z.object({
  asset: z.enum(["BTC", "ETH"]),
});

oracleAuthRouter.post("/sign-proof", authMiddleware, async (req, res, next) => {
  try {
    const parsed = SignProofBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid body", "invalid_body");
    }
    const { asset } = parsed.data;

    const current = await getCurrentPrice(asset);
    const verifiedAt = Math.floor(Date.now() / 1000);

    const signed = await signPriceProof({
      price: current.price,
      asset: current.asset,
      verifiedAt,
    });

    res.json({
      asset,
      assetBytes32: signed.asset,
      price: signed.price.toString(),
      decimals: current.decimals,
      verifiedAt: signed.verifiedAt,
      feedUpdatedAt: current.updatedAt,
      signer: getSignerAddress(),
      signature: signed.signature,
    });
  } catch (err) {
    next(err);
  }
});

oracleAuthRouter.get("/signer", authMiddleware, (_req, res) => {
  res.json({ signer: getSignerAddress() });
});
