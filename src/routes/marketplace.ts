import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { verifyBuy } from "../services/marketplace";
import {
  getListingByListingId,
  getPurchaseByTxHash,
  recordPurchaseAndFinalizeListing,
} from "../db/database";

export const marketplaceAuthRouter = Router();

const TxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 32-byte hex");
const AddressSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");
const UintStringSchema = z.string().regex(/^\d+$/, "must be a positive integer string");

const BuySchema = z.object({
  txHash: TxHashSchema,
  listingId: UintStringSchema,
  buyerAddress: AddressSchema,
  amount: UintStringSchema,
  totalPaidUsdc: UintStringSchema,
});

// [Audit #33 RL-1] auth before apiLimiter so per-agent counters work.
marketplaceAuthRouter.post("/buy", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const body = BuySchema.parse(req.body);

    // Idempotency: same txHash → 409.
    const existing = getPurchaseByTxHash(body.txHash);
    if (existing) {
      throw new HttpError(409, "Purchase already registered for this txHash", "duplicate_purchase");
    }

    // Pre-check the listing in our local store. The on-chain `Bought` event
    // omits amount/bondId/seller, so we need the listing record to verify
    // those fields against the body.
    const listing = getListingByListingId(body.listingId);
    if (!listing) {
      throw new HttpError(404, `Listing ${body.listingId} not found`, "listing_not_found");
    }
    if (listing.status !== "active") {
      throw new HttpError(
        409,
        `Listing ${body.listingId} is not active (status=${listing.status})`,
        "listing_not_active"
      );
    }

    const verified = await verifyBuy({
      txHash: body.txHash,
      listingId: body.listingId,
      buyerAddress: body.buyerAddress,
      amount: body.amount,
      totalPaidUsdc: body.totalPaidUsdc,
      listingSeller: listing.seller_address,
      listingBondId: listing.bond_id,
      listingAmount: listing.amount,
    });

    let row;
    try {
      row = recordPurchaseAndFinalizeListing({
        listing_id: verified.listingId,
        buyer_address: verified.buyerAddress,
        seller_address: verified.sellerAddress,
        bond_id: verified.bondId,
        amount: verified.amount,
        total_paid_usdc: verified.totalPaidUsdc,
        tx_hash: verified.txHash,
        block_number: verified.blockNumber,
        executed_at: verified.blockTimestamp > 0 ? verified.blockTimestamp * 1000 : null,
        submitted_by: req.agent.id,
      });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      const msg = e instanceof Error ? e.message : String(e);
      if (code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(msg)) {
        throw new HttpError(409, "Purchase already registered for this txHash", "duplicate_purchase");
      }
      if (code === "LISTING_RACE" || msg === "listing_not_active") {
        // Another buy finalized the listing between our pre-check and the UPDATE.
        throw new HttpError(409, "Listing was finalized before this request", "listing_not_active");
      }
      throw e;
    }

    const executedAtIso =
      row.executed_at !== null
        ? new Date(row.executed_at).toISOString()
        : new Date(row.created_at).toISOString();

    res.status(200).json({
      success: true,
      txHash: row.tx_hash,
      listingId: row.listing_id,
      buyerAddress: row.buyer_address,
      sellerAddress: row.seller_address,
      bondId: row.bond_id,
      amount: row.amount,
      totalPaidUsdc: row.total_paid_usdc,
      blockNumber: row.block_number,
      executedAt: executedAtIso,
    });
  } catch (e) {
    next(e);
  }
});
