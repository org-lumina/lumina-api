import { Router } from "express";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";

export const authRouter = Router();

// GET /api/v1/auth/me
//
// Returns the wallet associated with the calling x-api-key plus an
// 8-char prefix for UI/log disambiguation. NEVER includes the secret.
//
// Added in 2026-05-07 to let SDK clients auto-discover their own wallet
// without forcing the agent author to thread it through every method
// call. Used by `lumina.bonds.list()` and `lumina.policies.list()` when
// no explicit wallet is supplied.
authRouter.get("/me", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const raw = req.header("x-api-key");
    // Header is guaranteed present + well-formed by authMiddleware; the
    // null-coalesce is just to satisfy TypeScript.
    const apiKeyPrefix = (raw ?? "").trim().slice(0, 11); // "lk_" + 8 hex
    res.json({
      wallet: req.agent.wallet,
      apiKeyPrefix,
      tier: req.agent.tier,
    });
  } catch (e) {
    next(e);
  }
});
