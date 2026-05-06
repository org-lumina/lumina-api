import { Router } from "express";
import { ethers } from "ethers";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { HttpError } from "../middlewares/error";
import { purchaseViaRelayer } from "../services/policies";
import { loadConfig } from "../utils/config";
import {
  getExpectedAsset,
  getExpectedAssetForName,
  productIdFromName,
} from "../utils/productNames";

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

const ProductNameSchema = z
  .string()
  .regex(/^[A-Z0-9-]{3,32}$/, "productName must be a canonical alphanumeric label")
  .optional();

const TrySchema = z.object({
  // Default: FLASHBTC1H — shortest-duration product, lowest premium, the
  // friendliest first call for an unauthenticated visitor.
  productId: ProductIdSchema.default(
    "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd"
  ),
  productName: ProductNameSchema,
});

const DEFAULT_PRODUCT_ID =
  "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd";
const DEFAULT_PRODUCT_NAME = "FLASHBTC1H-001";

/**
 * GET /sandbox/info — returns the sandbox configuration so the UI knows
 * whether the playground is enabled and what cap to display.
 */
sandboxRouter.get("/info", (_req, res, next) => {
  try {
    const cfg = loadConfig();
    const defaultAsset = getExpectedAssetForName(DEFAULT_PRODUCT_NAME) ?? "USDC";
    res.json({
      ok: true,
      enabled: Boolean(cfg.SANDBOX_WALLET),
      sandboxWallet: cfg.SANDBOX_WALLET ?? null,
      coverageCapUsdc: cfg.SANDBOX_COVER_USDC,
      // Each shield validates a hardcoded `params.asset` literal; the symbol
      // returned here is the one for the default product. Send `productName`
      // (or another `productId`) to switch shields and get a different asset.
      asset: {
        symbol: defaultAsset,
        bytes32: ethers.encodeBytes32String(defaultAsset),
      },
      defaultProductId: DEFAULT_PRODUCT_ID,
      defaultProductName: DEFAULT_PRODUCT_NAME,
      rateLimit: { perIp: 10, windowSeconds: 3600 },
      docs: "https://docs.lumina-org.com/agents/products-and-assets",
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
 *
 * The asset is resolved from the productId / productName against a static
 * registry of the deployed Shields. Each Shield's createPolicy() validates
 * `params.asset` against a hardcoded literal (BTC for FlashBTC, ETH for
 * FlashETH, USDT for MicroDepeg, USDC for RateShock), so a single hardcoded
 * "USDC" reverts every shield except RateShock with InvalidAsset.
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
    // productName wins over productId so callers can switch shields by name
    // without having to know the keccak hash of the canonical preimage.
    let productId: string;
    let assetSymbol: string | undefined;
    if (parsed.data.productName) {
      const id = productIdFromName(parsed.data.productName);
      if (!id) {
        throw new HttpError(
          400,
          `Unknown productName "${parsed.data.productName}". See /products for the registered set.`,
          "unknown_product"
        );
      }
      productId = id;
      assetSymbol = getExpectedAssetForName(parsed.data.productName);
    } else {
      productId = parsed.data.productId!;
      assetSymbol = getExpectedAsset(productId);
    }
    if (!assetSymbol) {
      throw new HttpError(
        400,
        `productId ${productId} is not in the canonical asset registry. The shield's expected asset cannot be auto-resolved; pass productName or update src/utils/productNames.ts.`,
        "unknown_product"
      );
    }
    const asset = ethers.encodeBytes32String(assetSymbol);

    const receipt = await purchaseViaRelayer({
      productId,
      coverageAmount: BigInt(cfg.SANDBOX_COVER_USDC),
      asset,
      buyer: cfg.SANDBOX_WALLET,
    });

    res.status(201).json({
      ok: true,
      sandbox: true,
      productId: receipt.productId,
      assetSymbol,
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
