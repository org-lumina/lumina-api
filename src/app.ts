import express, { type Application } from "express";
import helmet from "helmet";
import cors, { type CorsOptions } from "cors";
import swaggerUi from "swagger-ui-express";
import { healthRouter } from "./routes/health";
import { productsRouter } from "./routes/products";
import { statsRouter } from "./routes/stats";
import { publicRouter } from "./routes/public";
import { policiesPublicRouter, policiesAuthRouter } from "./routes/policies";
import { redeemAuthRouter } from "./routes/redeem";
import { bondsAuthRouter } from "./routes/bonds";
import { marketplaceAuthRouter, marketplacePublicRouter } from "./routes/marketplace";
import { keysRouter } from "./routes/keys";
import { oracleAuthRouter } from "./routes/oracle";
import { agentRouter } from "./routes/agent";
import { webhooksAuthRouter } from "./routes/webhooks";
import { sandboxRouter } from "./routes/sandbox";
import { authRouter } from "./routes/auth";
import { faucetRouter } from "./routes/faucet";
// [Sprint K disabled — Phase 2 retake] Indexer router import + mount
// commented while Ponder runtime is parked. Re-enable when restoring
// `npm run concurrent`.
// import { indexerRouter } from "./routes/indexer";
import { openapiDocument } from "./openapi";
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

  // [10x10 fix M-8] Canonical paths under /api/v1/ to match the rest of the
  // surface. The legacy /products and /policies routes below are kept as
  // backward-compat aliases that emit `X-Deprecated` so existing clients
  // keep working while new integrations adopt the unified namespace.
  app.use("/api/v1/products", publicIpLimiter, productsRouter);
  // Aggregated INSTANT on-chain stats (price/reserve/capacity/supply/chain),
  // cached 30s — powers the public landing's live Hero. Read-only, no auth.
  app.use("/api/v1", publicIpLimiter, statsRouter);
  // Public, unauthenticated, read-only by-wallet views (policies/bonds),
  // server-reconstructed + cached 30s — so the browser never runs a wide
  // eth_getLogs scan. All data is public on-chain; no auth required.
  app.use("/api/v1/public", publicIpLimiter, publicRouter);
  app.use("/api/v1/policies", publicIpLimiter, policiesPublicRouter);
  // Marketplace GETs are read-only views of on-chain-public state
  // (listings, completed trades, floor). Mount the public router BEFORE
  // the auth-gated POST router so Express picks the no-auth handler for
  // GET /api/v1/marketplace/{stats,history,listings,listings/:id}.
  app.use("/api/v1/marketplace", publicIpLimiter, marketplacePublicRouter);

  const deprecateAlias = (newPath: string) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    res.set("X-Deprecated", `Use ${newPath}${req.path === "/" ? "" : req.path}`);
    next();
  };

  // Legacy aliases (kept for backward compatibility).
  app.use("/products", publicIpLimiter, deprecateAlias("/api/v1/products"), productsRouter);
  app.use("/policies", publicIpLimiter, deprecateAlias("/api/v1/policies"), policiesPublicRouter);

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
  app.use("/api/v1/auth", authIpLimiter, authRouter);

  // Admin (admin token + adminLimiter inside the router).
  app.use("/api/v1/keys", keysRouter);

  // Self-service supervisor surface — POST /onboard is public (signed by
  // the wallet). GET/DELETE /keys are authenticated via x-api-key behind
  // the same IP-rate-limit gate as the other authenticated routes.
  app.use("/api/v1/agent", authIpLimiter, agentRouter);

  // Webhook subscriptions (CRUD). Auth + per-agent rate-limited.
  app.use("/api/v1/webhooks", authIpLimiter, webhooksAuthRouter);

  // Sandbox / "Try It" surface. Public, IP-rate-limited far more
  // aggressively than the regular public routes — the sandbox spends real
  // (testnet) USDC out of a pre-funded wallet, so abuse is metered at the
  // IP boundary.
  app.use("/sandbox", sandboxRouter);

  // [Sprint L] Faucet — public POST /api/v1/faucet/claim sends 100 mock
  // USDC + 0.05 Sepolia ETH to a wallet, gated by 1/wallet/24h + 1/IP/24h
  // + a daily cap of 50 (caps relayer drain). GET /faucet/status surfaces
  // current balance + remaining slots. Mounted at /api/v1 (no auth, no
  // captcha — testnet only, used by humans and AI agents alike).
  app.use("/api/v1", faucetRouter);

  // [Sprint K disabled — Phase 2 retake] Indexer surface — public
  // read-only views of the Ponder Postgres tables. Endpoints under
  // /api/v1/{stats,policies,bonds,triggers,marketplace,burns,vesting,
  // indexer}. Disabled while the Ponder runtime is parked: with no
  // indexer process, every endpoint would 503 — confusing. Re-enable
  // alongside `npm run concurrent` in railway.toml + Dockerfile. The
  // import at the top of this file is intentionally retained so a
  // future re-enable is a one-line uncomment, not a rebuild.
  // app.use("/api/v1", indexerRouter);

  // OpenAPI spec + Swagger UI — both unauthenticated, gated by the public
  // IP limiter. The spec is the source of truth for external agents that
  // want a machine-readable contract instead of parsing the README.
  app.get("/openapi.json", publicIpLimiter, (_req, res) => {
    res.json(openapiDocument);
  });
  app.use(
    "/api-docs",
    publicIpLimiter,
    swaggerUi.serve,
    swaggerUi.setup(openapiDocument, {
      customSiteTitle: "Lumina API — interactive docs",
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
