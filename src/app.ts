import express, { type Application } from "express";
import helmet from "helmet";
import cors, { type CorsOptions } from "cors";
import { healthRouter } from "./routes/health";
import { productsRouter } from "./routes/products";
import { policiesPublicRouter, policiesAuthRouter } from "./routes/policies";
import { redeemAuthRouter } from "./routes/redeem";
import { bondsAuthRouter } from "./routes/bonds";
import { marketplaceAuthRouter } from "./routes/marketplace";
import { keysRouter } from "./routes/keys";
import { oracleAuthRouter } from "./routes/oracle";
import { agentRouter } from "./routes/agent";
import { errorHandler, notFoundHandler } from "./middlewares/error";
import { authIpLimiter, publicIpLimiter } from "./middlewares/rateLimit";

// Production frontend domain + Vercel previews + localhost for dev.
// Non-browser clients (curl, mobile apps, server-to-server) send no
// Origin header; we let those through unconditionally because CORS is
// a browser-only protection. Browser requests from any other origin
// are rejected before they reach a handler.
const ALLOWED_ORIGIN_LITERALS = new Set([
  "https://www.lumina-org.com",
  "https://lumina-org.com",
  "https://v0-lumina-landing-page.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
]);
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  // Vercel deploy previews
  /^https:\/\/v0-lumina-landing-page-[a-z0-9-]+\.vercel\.app$/,
];

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      ALLOWED_ORIGIN_LITERALS.has(origin) ||
      ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))
    ) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-admin-token", "Idempotency-Key"],
  exposedHeaders: ["x-rate-limit-remaining", "x-rate-limit-reset", "Retry-After"],
  maxAge: 86_400, // browsers cache preflight for 24h
};

export function createApp(): Application {
  const app = express();
  app.set("trust proxy", 1);
  // CORS must run BEFORE every other middleware, including helmet, so the
  // OPTIONS preflight gets the Access-Control-* headers without first
  // tripping helmet's CSP / X-Frame-Options checks. The browser drops the
  // response otherwise even though the status is 204.
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
  app.use(helmet());
  app.use(express.json({ limit: "32kb" }));

  // Public — [Audit #36 PUB-RL-1] IP-rate-limited at 120 req/min/IP.
  app.use("/health", publicIpLimiter, healthRouter);
  app.use("/products", publicIpLimiter, productsRouter);
  app.use("/policies", publicIpLimiter, policiesPublicRouter);

  // Authenticated — [Audit #36 AUTH-FLOOD] An IP-keyed limiter (60 req/min/IP)
  // runs BEFORE the route's authMiddleware, so a flood of failed auth attempts
  // is capped at the IP boundary instead of hitting the DB on every request.
  // The per-agent `apiLimiter` inside the route then counts only the requests
  // that actually authenticate.
  app.use("/api/v1/policies", authIpLimiter, policiesAuthRouter);
  app.use("/api/v1/redeem", authIpLimiter, redeemAuthRouter);
  app.use("/api/v1/bonds", authIpLimiter, bondsAuthRouter);
  app.use("/api/v1/marketplace", authIpLimiter, marketplaceAuthRouter);
  app.use("/api/v1/oracle", authIpLimiter, oracleAuthRouter);

  // Admin (admin token + adminLimiter inside the router).
  app.use("/api/v1/keys", keysRouter);

  // Self-service supervisor surface — POST /onboard is public (signed by
  // the wallet). GET/DELETE /keys are authenticated via x-api-key behind
  // the same IP-rate-limit gate as the other authenticated routes.
  app.use("/api/v1/agent", authIpLimiter, agentRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
