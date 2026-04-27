import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request } from "express";
import { loadConfig } from "../utils/config";

const cfg = loadConfig();

/**
 * Rate limit keyed by API key id when authenticated, falling back to IP.
 * Per-tier ceilings are picked dynamically from req.agent.tier.
 *
 * NOTE: dynamic `max` per request is supported by express-rate-limit.
 * The store remains a single window — different tiers share the same
 * counters but are gated by their own threshold. For strict isolation,
 * deploy two limiters and choose at runtime; for our scale (single API
 * instance) the shared store is sufficient.
 */
export const apiLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    if (req.agent) return `agent:${req.agent.id}`;
    return `ip:${req.ip ?? "unknown"}`;
  },
  max: (req: Request): number => {
    const tier = req.agent?.tier ?? "free";
    return tier === "paid" ? cfg.RATE_LIMIT_PAID_RPM : cfg.RATE_LIMIT_FREE_RPM;
  },
  message: { error: "rate_limited", message: "Too many requests" },
});

/** Stricter limiter for admin endpoints (key generation). */
export const adminLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `ip:${req.ip ?? "unknown"}`,
  message: { error: "rate_limited", message: "Too many admin requests" },
});
