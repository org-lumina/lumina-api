import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { verifyListing } from "../services/marketplace";
import { getListingByTxHash, recordListing } from "../db/database";

export const marketplaceAuthRouter = Router();

const TxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 32-byte hex");
const AddressSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");
const UintStringSchema = z.string().regex(/^\d+$/, "must be a positive integer string");

const ListSchema = z.object({
  txHash: TxHashSchema,
  sellerAddress: AddressSchema,
  bondId: UintStringSchema,
  amount: UintStringSchema,
  totalPriceUsdc: UintStringSchema,
});

// [Audit #33 RL-1] authMiddleware before apiLimiter so per-agent counters
// kick in once a key is valid.
marketplaceAuthRouter.post("/list", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const body = ListSchema.parse(req.body);

    // Idempotency: txHash UNIQUE — repeat calls return 409 instead of
    // re-recording the same listing.
    const existing = getListingByTxHash(body.txHash);
    if (existing) {
      throw new HttpError(409, "Listing already registered for this txHash", "duplicate_listing");
    }

    const verified = await verifyListing(body);

    let row;
    try {
      row = recordListing({
        listing_id: verified.listingId,
        seller_address: verified.sellerAddress,
        bond_id: verified.bondId,
        amount: verified.amount,
        total_price_usdc: verified.totalPriceUsdc,
        tx_hash: verified.txHash,
        block_number: verified.blockNumber,
        submitted_by: req.agent.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string } | null)?.code;
      if (code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(msg)) {
        throw new HttpError(409, "Listing already registered for this txHash", "duplicate_listing");
      }
      throw e;
    }

    const createdAtIso =
      verified.blockTimestamp > 0
        ? new Date(verified.blockTimestamp * 1000).toISOString()
        : new Date(row.created_at).toISOString();

    res.status(200).json({
      success: true,
      txHash: row.tx_hash,
      listingId: row.listing_id,
      blockNumber: row.block_number,
      createdAt: createdAtIso,
    });
  } catch (e) {
    next(e);
  }
});
