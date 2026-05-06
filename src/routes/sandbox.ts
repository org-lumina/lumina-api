import { Router } from "express";
import { ethers } from "ethers";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { HttpError } from "../middlewares/error";
import { purchaseViaRelayer } from "../services/policies";
import { loadConfig } from "../utils/config";

export const sandboxRouter = Router();

// Hard cap of 10 try-purchases per IP per hour. The default 120/min public
// limiter is too generous for a route that spends real (testnet) USDC. This
// limiter sits on TOP of helmet/cors and runs on every /sandbox request.
const SANDBOX_RATE_LIMIT = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limit", message: "Too many sandbox requests from this IP. Try again in an hour." },
});

sandboxRouter.use(SANDBOX_RATE_LIMIT);

const ProductIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "productId must be bytes32 hex")
  .optional();

const TrySchema = z.object({
  // Default: FLASHBTC1H — shortest-duration product, lowest premium, the
  // friendliest first call for an unauthenticated visitor.
  productId: ProductIdSchema.default(
    "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd"
  ),
});

// USDC bytes32 — pre-computed because every sandbox call uses it.
const USDC_BYTES32 = ethers.encodeBytes32String("USDC");

/**
 * GET /sandbox/info — returns the sandbox configuration so the UI knows
 * whether the playground is enabled and what cap to display.
 */
sandboxRouter.get("/info", (_req, res, next) => {
  try {
    const cfg = loadConfig();
    res.json({
      ok: true,
      enabled: Boolean(cfg.SANDBOX_WALLET),
      sandboxWallet: cfg.SANDBOX_WALLET ?? null,
      coverageCapUsdc: cfg.SANDBOX_COVER_USDC,
      asset: { symbol: "USDC", bytes32: USDC_BYTES32 },
      defaultProductId:
        "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd",
      defaultProductName: "FLASHBTC1H-001",
      rateLimit: { perIp: 10, windowSeconds: 3600 },
      docs: "https://docs.lumina-org.com/agents/first-policy",
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /sandbox/try — execute a $1 policy purchase against the sandbox
 * wallet. Returns the relayer receipt. Public, IP-rate-limited (10/h).
 *
 * Costs are bounded:
 *   - cap = SANDBOX_COVER_USDC (default $1)
 *   - buyer is fixed to SANDBOX_WALLET (no buyer-controlled funds drain)
 *   - asset is fixed to USDC (no asset-injection)
 */
sandboxRouter.post("/try", async (req, res, next) => {
  try {
    const cfg = loadConfig();
    if (!cfg.SANDBOX_WALLET) {
      throw new HttpError(
        503,
        "Sandbox is disabled (SANDBOX_WALLET unset). Visit /sandbox/info to check status.",
        "sandbox_disabled"
      );
    }
    const parsed = TrySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid_body", "invalid_body");
    }
    const productId = parsed.data.productId!;

    const receipt = await purchaseViaRelayer({
      productId,
      coverageAmount: BigInt(cfg.SANDBOX_COVER_USDC),
      asset: USDC_BYTES32,
      buyer: cfg.SANDBOX_WALLET,
    });

    res.status(201).json({
      ok: true,
      sandbox: true,
      productId: receipt.productId,
      policyId: receipt.policyId,
      buyer: receipt.buyer,
      coverageAmount: receipt.coverageAmount,
      premiumPaid: receipt.premiumPaid,
      txHash: receipt.txHash,
      blockExplorer: `https://sepolia.basescan.org/tx/${receipt.txHash}`,
      next: "https://docs.lumina-org.com/agents/first-policy",
    });
  } catch (e) {
    next(e);
  }
});
