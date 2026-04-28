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

/**
 * [Audit #36 PUB-RL-1] Public-route limiter.
 *
 * Public reads (`/health`, `/products`, `/policies/...`) had no rate limit at
 * all. A sustained flood costs the API process CPU and the upstream RPC
 * budget. We cap at 120 req/min/IP — generous enough that a real human
 * browsing the dashboard never trips it, tight enough that a spam loop is
 * stopped quickly.
 */
export const publicIpLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: cfg.RATE_LIMIT_PUBLIC_IP_RPM,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `ip:${req.ip ?? "unknown"}`,
  message: { error: "rate_limited", message: "Too many requests from this IP" },
});

/**
 * [Audit #36 AUTH-FLOOD] Auth-path IP limiter.
 *
 * Failed-auth requests previously skipped `apiLimiter` entirely (auth's
 * `next(error)` bypasses the rest of the chain), so a flooder could hammer
 * `/api/v1/*` with bogus keys, bound only by SQLite's hash lookup cost.
 *
 * This limiter runs BEFORE `authMiddleware`, so every request to
 * `/api/v1/*` — authenticated or not — counts against the IP's 60/min
 * budget. Once the IP is exhausted it gets a clean 429, never reaching
 * the DB.
 *
 * The legitimate `apiLimiter` runs AFTER auth and counts authenticated
 * requests against the agent's per-tier quota; that path is unaffected.
 */
export const authIpLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: cfg.RATE_LIMIT_AUTH_IP_RPM,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `ip:${req.ip ?? "unknown"}`,
  message: { error: "rate_limited", message: "Too many requests from this IP" },
});
