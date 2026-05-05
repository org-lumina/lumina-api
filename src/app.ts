import express, { type Application } from "express";
import helmet from "helmet";
import { healthRouter } from "./routes/health";
import { productsRouter } from "./routes/products";
import { policiesPublicRouter, policiesAuthRouter } from "./routes/policies";
import { redeemAuthRouter } from "./routes/redeem";
import { bondsAuthRouter } from "./routes/bonds";
import { marketplaceAuthRouter } from "./routes/marketplace";
import { keysRouter } from "./routes/keys";
import { oracleAuthRouter } from "./routes/oracle";
import { errorHandler, notFoundHandler } from "./middlewares/error";
import { authIpLimiter, publicIpLimiter } from "./middlewares/rateLimit";

export function createApp(): Application {
  const app = express();
  app.set("trust proxy", 1);
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
