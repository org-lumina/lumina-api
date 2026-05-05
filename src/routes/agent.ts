import { Router } from "express";
import { z } from "zod";
import { ethers } from "ethers";
import rateLimit from "express-rate-limit";

import { authMiddleware } from "../middlewares/auth";
import { apiLimiter, authIpLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { issueKey } from "../services/keys";
import { isKeyOwnedByWallet, listKeysForWallet, revokeKey } from "../db/database";

/**
 * Agent supervisor surface.
 *
 *   POST /api/v1/agent/onboard          public, signed-in by EIP-191
 *   GET  /api/v1/agent/keys             requires x-api-key
 *   DELETE /api/v1/agent/keys/:keyId    requires x-api-key (owner-only)
 *
 * The "onboarding" flow lets a wallet self-service-mint its first API key
 * without any admin involvement. The wallet proves ownership by signing
 *
 *     "Lumina onboarding for {walletAddress} at {timestamp}"
 *
 * with a unix-second timestamp that must be within ±5 minutes of server time.
 * The standard `MAX_KEYS_PER_WALLET = 3` cap (enforced by `issueKey`) is the
 * only abuse limit beyond per-IP rate limiting on this endpoint.
 */
export const agentRouter = Router();

const ONBOARD_RATE_LIMIT = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many onboarding attempts from this IP. Try again later." },
});

const TIMESTAMP_TOLERANCE_SECONDS = 300; // ±5 min

const OnboardSchema = z.object({
  walletAddress: z
    .string()
    .refine(ethers.isAddress, "walletAddress must be a valid 0x address"),
  label: z.string().max(50).optional(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "signature must be a 65-byte hex string"),
  timestamp: z
    .number()
    .int()
    .positive("timestamp must be a positive unix-seconds integer"),
});

agentRouter.post("/onboard", ONBOARD_RATE_LIMIT, (req, res, next) => {
  try {
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Invalid body",
        "invalid_body",
      );
    }
    const { walletAddress, label, signature, timestamp } = parsed.data;

    // Reject stale or future-dated timestamps to limit replay surface.
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
      throw new HttpError(
        400,
        `timestamp out of window (±${TIMESTAMP_TOLERANCE_SECONDS}s); server time ${now}`,
        "stale_timestamp",
      );
    }

    // Recover signer from the EIP-191 personal_sign envelope.
    const message = `Lumina onboarding for ${walletAddress} at ${timestamp}`;
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      throw new HttpError(401, "Signature could not be recovered", "invalid_signature");
    }
    if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new HttpError(
        401,
        `Signature does not match walletAddress (recovered ${recovered})`,
        "signature_mismatch",
      );
    }

    // Reuses the existing service. issueKey() also enforces MAX_KEYS_PER_WALLET=3
    // and writes only the SHA-256 hash to the DB.
    const issued = issueKey(walletAddress, label);

    res.status(201).json({
      ok: true,
      apiKey: issued.plaintext,
      keyId: issued.keyId,
      wallet: issued.wallet,
      label: issued.label,
      tier: issued.tier,
      createdAt: issued.createdAt,
      rateLimit: {
        free: { rpm: 10 },
        paid: { rpm: 100 },
      },
      warning: "Store the apiKey now. It will not be shown again.",
    });
  } catch (e) {
    next(e);
  }
});

agentRouter.get("/keys", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const keys = listKeysForWallet(req.agent.wallet);
    res.json({ wallet: req.agent.wallet, keys });
  } catch (e) {
    next(e);
  }
});

agentRouter.delete("/keys/:keyId", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const id = Number(req.params.keyId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, "keyId must be a positive integer", "invalid_id");
    }
    if (!isKeyOwnedByWallet(id, req.agent.wallet)) {
      throw new HttpError(404, "Key not found for this wallet", "key_not_found");
    }
    const ok = revokeKey(id);
    if (!ok) {
      // Shouldn't happen — ownership check passed but revoke failed because
      // already revoked. Treat as idempotent success.
      res.status(200).json({ ok: true, alreadyRevoked: true });
      return;
    }
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// Wire the IP-rate-limit guard at the app level (mirrors the other auth routes
// so a flood of bad keys can't hammer the DB).
export const agentIpLimiter = authIpLimiter;
