import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import {
  deactivateWebhookSubscription,
  insertWebhookSubscription,
  listWebhookSubscriptionsByWallet,
} from "../db/database";

export const webhooksAuthRouter = Router();

const ALLOWED_EVENTS = [
  "policy_purchased",
  "policy_triggered",
  "bond_minted",
  "bond_redeemed",
  "listing_created",
  "listing_purchased",
] as const;

const SubscribeSchema = z.object({
  url: z
    .string()
    .url("url must be a valid HTTPS URL")
    .refine((u) => u.startsWith("https://") || u.startsWith("http://localhost"), {
      message: "url must be https:// (http://localhost allowed for testing)",
    }),
  events: z
    .union([z.literal("*"), z.array(z.enum(ALLOWED_EVENTS)).min(1)])
    .default("*"),
});

webhooksAuthRouter.post("/", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid_body", "invalid_body");
    }
    const events = parsed.data.events === "*" ? ["*"] : parsed.data.events;
    // 32-byte secret, hex-encoded → 64 chars. Strong enough for HMAC-SHA256
    // and never echoed again after this response (mirrors api-key UX).
    const secret = crypto.randomBytes(32).toString("hex");
    let row;
    try {
      row = insertWebhookSubscription({
        wallet: req.agent.wallet,
        url: parsed.data.url,
        secret,
        events,
      });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("UNIQUE")) {
        throw new HttpError(
          409,
          "A webhook for this URL already exists for your wallet",
          "duplicate_url"
        );
      }
      throw e;
    }
    res.status(201).json({
      ok: true,
      id: row.id,
      url: row.url,
      events,
      secret,
      warning: "Store the secret now. It will not be shown again.",
    });
  } catch (e) {
    next(e);
  }
});

webhooksAuthRouter.get("/", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const rows = listWebhookSubscriptionsByWallet(req.agent.wallet);
    res.json({
      ok: true,
      wallet: req.agent.wallet.toLowerCase(),
      count: rows.length,
      // secret is intentionally never returned on list (only at creation).
      webhooks: rows.map((r) => ({
        id: r.id,
        url: r.url,
        events: JSON.parse(r.events),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (e) {
    next(e);
  }
});

webhooksAuthRouter.delete("/:id", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, "id must be a positive integer", "invalid_id");
    }
    const ok = deactivateWebhookSubscription(id, req.agent.wallet);
    if (!ok) throw new HttpError(404, "Webhook not found or not yours", "not_found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});
