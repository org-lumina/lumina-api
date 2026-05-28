import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import {
  deactivateWebhookSubscription,
  getWebhookSubscriptionForWallet,
  insertWebhookSubscription,
  listWebhookDeliveriesBySubscription,
  listWebhookSubscriptionsByWallet,
} from "../db/database";

export const webhooksAuthRouter = Router();

/**
 * SSRF guard: reject delivery URLs that point at private/reserved address
 * space or cloud-metadata endpoints. `localhost` is intentionally still allowed
 * (the schema permits http://localhost for local testing); everything else
 * that looks internal is blocked. DNS-rebinding is out of scope (documented).
 */
function isBlockedWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost") return false;
  if (h.endsWith(".internal") || h.endsWith(".local") || h === "metadata.google.internal") {
    return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  // IPv4 literal → check private/reserved ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

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
    // SSRF guard — block internal/reserved targets.
    try {
      if (isBlockedWebhookHost(new URL(parsed.data.url).hostname)) {
        throw new HttpError(400, "url host is not allowed (private/internal address)", "blocked_host");
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "invalid url", "invalid_body");
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

// Delivery log for one subscription (last N attempts), for the dashboard UI.
webhooksAuthRouter.get("/:id/deliveries", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, "id must be a positive integer", "invalid_id");
    }
    // Ownership: only expose deliveries for a subscription the caller owns.
    const sub = getWebhookSubscriptionForWallet(id, req.agent.wallet);
    if (!sub) throw new HttpError(404, "Webhook not found or not yours", "not_found");
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
    const rows = listWebhookDeliveriesBySubscription(id, limit);
    res.json({
      ok: true,
      subscriptionId: id,
      count: rows.length,
      deliveries: rows.map((r) => ({
        id: r.id,
        event: r.event,
        status: r.status,
        attempts: r.attempts,
        responseCode: r.response_code,
        responseBody: r.response_body ? r.response_body.slice(0, 300) : null,
        nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
        deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (e) {
    next(e);
  }
});
