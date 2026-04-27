import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { loadConfig } from "../utils/config";
import { HttpError } from "./error";

const cfg = loadConfig();

export function adminAuth(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.header("x-admin-token");
  if (!raw) {
    next(new HttpError(401, "Missing x-admin-token", "missing_admin_token"));
    return;
  }
  const a = Buffer.from(raw);
  const b = Buffer.from(cfg.ADMIN_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    next(new HttpError(401, "Invalid admin token", "invalid_admin_token"));
    return;
  }
  next();
}
