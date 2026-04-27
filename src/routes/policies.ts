import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { getPolicy, purchaseViaRelayer } from "../services/policies";
import { findIdempotency, listPoliciesByOwner, recordPolicy, saveIdempotency } from "../db/database";

export const policiesPublicRouter = Router();
export const policiesAuthRouter = Router();

const ProductIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "productId must be bytes32 hex");
const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "asset must be bytes32 hex");
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

const PurchaseSchema = z.object({
  productId: ProductIdSchema,
  coverageAmount: z.string().regex(/^\d+$/, "coverageAmount must be a positive integer string (USDC base units)"),
  asset: Bytes32Schema,
  buyer: AddressSchema,
});

// Authenticated: purchase a policy via the relayer.
// Idempotency-Key header optional but strongly recommended.
policiesAuthRouter.post("/", apiLimiter, authMiddleware, async (req, res, next) => {
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

    const receipt = await purchaseViaRelayer({
      productId: body.productId,
      coverageAmount: BigInt(body.coverageAmount),
      asset: body.asset,
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
    res.status(201).json(responseBody);
  } catch (e) {
    next(e);
  }
});

// Authenticated: list policies for a given owner. If `owner` is omitted,
// defaults to the authenticated agent's wallet.
const ListQuerySchema = z.object({ owner: AddressSchema.optional() });

policiesAuthRouter.get("/", apiLimiter, authMiddleware, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const { owner } = ListQuerySchema.parse(req.query);
    const target = (owner ?? req.agent.wallet).toLowerCase();
    const rows = listPoliciesByOwner(target);
    res.json({ owner: target, count: rows.length, policies: rows });
  } catch (e) {
    next(e);
  }
});
