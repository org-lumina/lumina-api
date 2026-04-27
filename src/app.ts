import express, { type Application } from "express";
import helmet from "helmet";
import { healthRouter } from "./routes/health";
import { productsRouter } from "./routes/products";
import { policiesPublicRouter, policiesAuthRouter } from "./routes/policies";
import { keysRouter } from "./routes/keys";
import { errorHandler, notFoundHandler } from "./middlewares/error";

export function createApp(): Application {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: "32kb" }));

  // Public
  app.use("/health", healthRouter);
  app.use("/products", productsRouter);
  app.use("/policies", policiesPublicRouter);

  // Authenticated (rate limit + auth applied per route)
  app.use("/api/v1/policies", policiesAuthRouter);

  // Admin (rate limit + admin token)
  app.use("/api/v1/keys", keysRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
