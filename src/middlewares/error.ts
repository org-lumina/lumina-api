import type { ErrorRequestHandler, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../utils/logger";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFoundHandler = (req: Request, res: Response, _next: NextFunction): void => {
  res.status(404).json({ error: "not_found", message: `Route not found: ${req.method} ${req.path}` });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "validation_error",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code ?? "error", message: err.message });
    return;
  }
  // [Audit #33 LOW-1] express.json() throws PayloadTooLargeError when the body
  // exceeds the configured limit. Surface it as a proper 413 instead of 500.
  if (err && typeof err === "object" && "type" in err && err.type === "entity.too.large") {
    res.status(413).json({ error: "payload_too_large", message: "Request body exceeds 32 KB limit" });
    return;
  }
  // Red-Team fix F-30 (LOW): malformed JSON makes express.json()/body-parser
  // throw a SyntaxError (type "entity.parse.failed"). That is a client error and
  // must be a 400, not the generic 500 that was masking it in error telemetry.
  if (
    err &&
    typeof err === "object" &&
    (("type" in err && err.type === "entity.parse.failed") ||
      (err instanceof SyntaxError && "body" in err))
  ) {
    res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON" });
    return;
  }
  logger.error({ err, path: req.path, method: req.method }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "An unexpected error occurred" });
};
