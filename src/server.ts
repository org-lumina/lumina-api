import { createApp } from "./app";
import { loadConfig } from "./utils/config";
import { logger } from "./utils/logger";
import { getDb, closeDb } from "./db/database";

const cfg = loadConfig();

const app = createApp();
getDb(); // run migrations on boot

const server = app.listen(cfg.PORT, () => {
  logger.info({ port: cfg.PORT, chainId: cfg.CHAIN_ID, env: cfg.NODE_ENV }, "Lumina API listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close((err) => {
    if (err) logger.error({ err }, "error closing http server");
    closeDb();
    process.exit(err ? 1 : 0);
  });
  // Hard timeout
  setTimeout(() => {
    logger.error("forced exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException");
});
