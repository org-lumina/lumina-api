import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { getPolicy, purchaseViaRelayer } from "../services/policies";
import { findIdempotency, listPoliciesByOwner, recordPolicy, saveIdempotency } from "../db/database";
import { emit as emitWebhook } from "../services/webhooks";
import {
  getExpectedAsset,
  getExpectedAssetForName,
  productIdFromName,
} from "../utils/productNames";

export const policiesPublicRouter = Router();
export const policiesAuthRouter = Router();

const ProductIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "productId must be bytes32 hex");
const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "asset must be bytes32 hex");
const ProductNameSchema = z
  .string()
  .regex(/^[A-Z0-9-]{3,32}$/, "productName must be a canonical alphanumeric label");
const AddressSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");

const PolicyCompositeKey = z.object({
  productId: ProductIdSchema,
  policyId: z.string().regex(/^\d+$/, "policyId must be a positive integer string"),
});

// Public: read policy by (productId, policyId).
policiesPublicRouter.get("/:productId/:policyId", async (req, res, next) => {
  try {
    const { productId, policyId } = PolicyCompositeKey.parse(req.params);
    const policy = await getPolicy(productId, BigInt(policyId));
    if (!policy) throw new HttpError(404, "Policy not found", "policy_not_found");
    res.json(policy);
  } catch (e) {
    next(e);
  }
});

// Asset is now optional — the API auto-resolves the per-shield literal from
// productId/productName. Callers that explicitly want to override (e.g. to
// reproduce a revert in testing) can still pass the bytes32 asset directly.
// productId and productName are mutually optional but at least one must be
// supplied; productName wins so callers can avoid handling keccak hashes.
const PurchaseSchema = z
  .object({
    productId: ProductIdSchema.optional(),
    productName: ProductNameSchema.optional(),
    coverageAmount: z.string().regex(/^\d+$/, "coverageAmount must be a positive integer string (USDC base units)"),
    asset: Bytes32Schema.optional(),
    buyer: AddressSchema,
  })
  .refine((d) => d.productId || d.productName, {
    message: "must supply productId or productName",
    path: ["productId"],
  });

// Authenticated: purchase a policy via the relayer.
// Idempotency-Key header optional but strongly recommended.
// [Audit #33 RL-1] authMiddleware MUST run before apiLimiter so the limiter's
// keyGenerator can read req.agent and apply per-agent (not per-IP) counters.
policiesAuthRouter.post("/", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const body = PurchaseSchema.parse(req.body);

    const idempotencyKey = (req.header("idempotency-key") ?? "").trim();
    if (idempotencyKey) {
      const cached = findIdempotency(idempotencyKey, req.agent.id);
      if (cached) {
        res.status(200).json(JSON.parse(cached));
        return;
      }
    }

    let productId: string;
    let assetSymbol: string | undefined;
    if (body.productName) {
      const id = productIdFromName(body.productName);
      if (!id) {
        throw new HttpError(
          400,
          `Unknown productName "${body.productName}". See /products for the registered set.`,
          "unknown_product"
        );
      }
      productId = id;
      assetSymbol = getExpectedAssetForName(body.productName);
    } else {
      productId = body.productId!;
      assetSymbol = getExpectedAsset(productId);
    }
    // Asset resolution priority: explicit body.asset > registry lookup. If the
    // caller omits the asset and the productId is unknown to the registry we
    // can't safely guess — every shield reverts on the wrong literal.
    let asset: string;
    if (body.asset) {
      asset = body.asset;
    } else if (assetSymbol) {
      asset = ethers.encodeBytes32String(assetSymbol);
    } else {
      throw new HttpError(
        400,
        `Cannot auto-resolve asset for productId ${productId}. Pass productName, or pass asset (bytes32) explicitly. See https://docs.lumina-org.com/agents/products-and-assets.`,
        "asset_unresolved"
      );
    }

    const receipt = await purchaseViaRelayer({
      productId,
      coverageAmount: BigInt(body.coverageAmount),
      asset,
      buyer: body.buyer,
    });

    recordPolicy({
      product_id: receipt.productId,
      policy_id: Number(receipt.policyId),
      buyer: receipt.buyer,
      coverage_amount: receipt.coverageAmount,
      premium_paid: receipt.premiumPaid,
      tx_hash: receipt.txHash,
      submitted_by: req.agent.id,
    });

    const responseBody = { ok: true, ...receipt };
    if (idempotencyKey) {
      saveIdempotency(idempotencyKey, req.agent.id, JSON.stringify(responseBody));
    }
    // Fan out to webhook subscribers for the buyer wallet. Emit is fire-and-
    // forget by design; failures are logged but never block the response.
    emitWebhook("policy_purchased", receipt.buyer, {
      event: "policy_purchased",
      productId: receipt.productId,
      policyId: receipt.policyId,
      buyer: receipt.buyer,
      coverageAmount: receipt.coverageAmount,
      premiumPaid: receipt.premiumPaid,
      txHash: receipt.txHash,
      occurredAt: new Date().toISOString(),
    });
    res.status(201).json(responseBody);
  } catch (e) {
    next(e);
  }
});

// Authenticated: list policies for the calling agent's wallet.
//
// [Audit #33 INV-1] An explicit `owner` query parameter is allowed only if
// it matches the API key's wallet. Cross-owner reads are 403, even though
// the underlying data is publicly derivable from on-chain events — the
// API itself does not act as an unauthenticated index for other wallets.
const ListQuerySchema = z.object({ owner: AddressSchema.optional() });

policiesAuthRouter.get("/", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const { owner } = ListQuerySchema.parse(req.query);
    const callerWallet = req.agent.wallet.toLowerCase();
    if (owner && owner.toLowerCase() !== callerWallet) {
      throw new HttpError(
        403,
        "Cannot query policies of other owners",
        "forbidden"
      );
    }
    const rows = listPoliciesByOwner(callerWallet);
    res.json({ owner: callerWallet, count: rows.length, policies: rows });
  } catch (e) {
    next(e);
  }
});
