import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import {
  getMarketplaceHistory,
  getMarketplaceStats,
  verifyBuy,
  verifyListing,
} from "../services/marketplace";
import {
  getListingByListingId,
  getListingByTxHash,
  getPurchaseByTxHash,
  listActiveListings,
  recordListing,
  recordPurchaseAndFinalizeListing,
} from "../db/database";

export const marketplaceAuthRouter = Router();

const TxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 32-byte hex");
const AddressSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");
const UintStringSchema = z.string().regex(/^\d+$/, "must be a positive integer string");

// ────────────────────────────────────────────────────────────────────────────
// GET /listings — discovery endpoint for off-chain agents (agent-ux Day 1-3)
// ────────────────────────────────────────────────────────────────────────────
//
// Without this route, agents have no way to scan available listings short of
// scraping `eth_getLogs` for `Listed` events on the marketplace contract.
// Reads the same authoritative SQLite store populated by POST /list, so we
// only ever surface listings that this API has verified end-to-end.

const ListListingsQuerySchema = z.object({
  // Accepted but currently ignored — see DB-layer note in
  // `listActiveListings` (face value isn't on the listing row).
  minDiscountBps: z.coerce.number().int().min(0).max(10000).optional(),
  maxPriceUsdc: z.string().regex(/^\d+$/).optional(),
  sortBy: z.enum(["price-asc", "price-desc", "createdAt-desc", "listedAt-desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

marketplaceAuthRouter.get("/listings", authMiddleware, apiLimiter, (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const q = ListListingsQuerySchema.parse(req.query);
    const { rows, total } = listActiveListings({
      minDiscountBps: q.minDiscountBps,
      maxPriceUsdc: q.maxPriceUsdc ? BigInt(q.maxPriceUsdc) : undefined,
      sortBy: q.sortBy ?? "price-asc",
      limit: q.limit,
      offset: q.offset,
    });

    res.json({
      count: rows.length,
      total,
      listings: rows.map((r) => ({
        listingId: r.listing_id,
        seller: r.seller_address,
        bondId: r.bond_id,
        amount: r.amount,
        totalPriceUsdc: r.total_price_usdc,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        createdAt: new Date(r.created_at).toISOString(),
        status: r.status,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /stats — marketplace macro snapshot (Phase 2)
// ────────────────────────────────────────────────────────────────────────────
//
// Cheap, cacheable summary used by dashboards and "is this market alive?"
// agent checks. Cached 30s in `services/marketplace.getMarketplaceStats`.

marketplaceAuthRouter.get("/stats", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const stats = await getMarketplaceStats();
    res.json(stats);
  } catch (e) {
    next(e);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /history — paginated trade history (Phase 2)
// ────────────────────────────────────────────────────────────────────────────
//
// Returns completed `Bought` trades, newest first. Source of truth is the
// local `purchases` table populated by the verifier-pattern POST /buy —
// it has the full Trade shape (amount + bondId), which the on-chain
// `Bought` event omits.

const HistoryQuerySchema = z.object({
  // z.coerce.number() turns "abc" into NaN → fails int()/min checks → 400.
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

marketplaceAuthRouter.get("/history", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const q = HistoryQuerySchema.parse(req.query);
    const trades = await getMarketplaceHistory(q.limit, q.offset);
    res.json({
      count: trades.length,
      limit: q.limit,
      offset: q.offset,
      trades,
    });
  } catch (e) {
    next(e);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /listings/:listingId — single-listing detail (Phase 2)
// ────────────────────────────────────────────────────────────────────────────
//
// Direct fetch by on-chain listingId. Path parameter is validated as a
// positive integer string before hitting the DB so we return a clean 400
// for clients that pass slugs / negative numbers / floats.

marketplaceAuthRouter.get(
  "/listings/:listingId",
  authMiddleware,
  apiLimiter,
  (req, res, next) => {
    try {
      if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
      const raw = String(req.params.listingId ?? "");
      // Mirror the body-side UintStringSchema rule: positive integer,
      // no leading sign, no decimal. Reject "0" too — listingId is 1-based.
      if (!/^\d+$/.test(raw) || raw === "0") {
        throw new HttpError(400, "listingId must be a positive integer string", "invalid_listing_id");
      }
      const row = getListingByListingId(raw);
      if (!row) {
        throw new HttpError(404, `Listing ${raw} not found`, "not_found");
      }
      res.json({
        listingId: row.listing_id,
        seller: row.seller_address,
        bondId: row.bond_id,
        amount: row.amount,
        totalPriceUsdc: row.total_price_usdc,
        txHash: row.tx_hash,
        blockNumber: row.block_number,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
      });
    } catch (e) {
      next(e);
    }
  }
);

// ────────────────────────────────────────────────────────────────────────────
// POST /list — A.1.5
// ────────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────
// POST /buy — A.1.6
// ────────────────────────────────────────────────────────────────────────────

const BuySchema = z.object({
  txHash: TxHashSchema,
  listingId: UintStringSchema,
  buyerAddress: AddressSchema,
  amount: UintStringSchema,
  totalPaidUsdc: UintStringSchema,
});

marketplaceAuthRouter.post("/buy", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const body = BuySchema.parse(req.body);

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
