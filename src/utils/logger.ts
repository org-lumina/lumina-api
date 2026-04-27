import pino from "pino";
import { loadConfig } from "./config";

const cfg = loadConfig();

export const logger = pino({
  level: cfg.LOG_LEVEL,
  base: { service: "lumina-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(cfg.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
