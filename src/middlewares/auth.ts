import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { findActiveKeyByHash } from "../db/database";
import { HttpError } from "./error";

declare module "express-serve-static-core" {
  interface Request {
    agent?: {
      id: number;
      wallet: string;
      tier: "free" | "paid";
      keyId: number;
    };
  }
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Generate a new opaque API key. Format: lk_<32 random bytes hex>.
 * The plaintext is returned ONCE — only the SHA-256 hash is stored.
 */
export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = "lk_" + randomBytes(32).toString("hex");
  return { plaintext, hash: hashApiKey(plaintext) };
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.header("x-api-key");
  if (!raw || typeof raw !== "string") {
    next(new HttpError(401, "Missing x-api-key header", "missing_api_key"));
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("lk_") || trimmed.length < 10) {
    next(new HttpError(401, "Malformed API key", "invalid_api_key"));
    return;
  }
  const record = findActiveKeyByHash(hashApiKey(trimmed));
  if (!record) {
    next(new HttpError(401, "Invalid or revoked API key", "invalid_api_key"));
    return;
  }
  req.agent = {
    id: record.agent_id,
    wallet: record.wallet,
    tier: record.tier === "paid" ? "paid" : "free",
    keyId: record.id,
  };
  next();
}
