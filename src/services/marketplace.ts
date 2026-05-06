import type { LogDescription } from "ethers";
import { marketplace, provider } from "../utils/ethers";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";
import { makeCache } from "../utils/cache";
import { getDb, getListingByListingId, type ListingRow } from "../db/database";

// ────────────────────────────────────────────────────────────────────────────
// VERIFY LISTING (POST /api/v1/marketplace/list — A.1.5)
// ────────────────────────────────────────────────────────────────────────────

export interface VerifyListingInput {
  txHash: string;
  sellerAddress: string;
  bondId: string;          // alias of epochId on-chain
  amount: string;
  totalPriceUsdc: string;
}

export interface VerifiedListing {
  txHash: string;
  listingId: string;
  sellerAddress: string;
  bondId: string;
  amount: string;
  totalPriceUsdc: string;
  blockNumber: number;
  blockTimestamp: number;  // seconds since epoch
}

/**
 * Verify a `LuminaBondMarketplace.list(...)` transaction submitted by an
 * end-user wallet (verifier pattern, mirrors services/redeem.ts).
 *
 * - Receipt must be confirmed and target the marketplace contract.
 * - `Listed(listingId, seller, epochId, amount, priceUSDC)` event in the
 *   receipt logs is the source of truth — body fields must match.
 * - [V5.1 M-3] Body's per-unit price must satisfy the on-chain anti-spam
 *   floor (`marketplace.minPricePerUnit()`). Defense-in-depth: if the tx
 *   succeeded the on-chain require already passed, but a body that lies
 *   would be caught here regardless.
 */
export async function verifyListing(input: VerifyListingInput): Promise<VerifiedListing> {
  const marketplaceAddr = (marketplace.target as string).toLowerCase();

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(input.txHash);
  } catch {
    throw new HttpError(502, "RPC error fetching receipt", "rpc_error");
  }
  if (!receipt) {
    throw new HttpError(400, "Tx not found", "tx_not_found");
  }
  if (receipt.status !== 1) {
    throw new HttpError(400, "Tx reverted on-chain", "tx_reverted");
  }
  if ((receipt.to ?? "").toLowerCase() !== marketplaceAddr) {
    throw new HttpError(400, "Tx is not a Marketplace call", "tx_not_marketplace");
  }
  if ((receipt.from ?? "").toLowerCase() !== input.sellerAddress.toLowerCase()) {
    throw new HttpError(403, "Seller mismatch — txHash sender is not sellerAddress", "seller_mismatch");
  }

  const iface = marketplace.interface;
  const eventFragment = iface.getEvent("Listed");
  if (!eventFragment) {
    throw new HttpError(500, "Listed event missing from ABI", "abi_misconfigured");
  }
  const eventTopic = eventFragment.topicHash;

  let parsed: LogDescription | null = null;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === marketplaceAddr &&
      log.topics[0] === eventTopic
    ) {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) break;
    }
  }
  if (!parsed) {
    throw new HttpError(400, "Listed event not found in tx logs", "event_missing");
  }

  const evListingId = parsed.args.listingId.toString();
  const evSeller = String(parsed.args.seller).toLowerCase();
  const evEpochId = parsed.args.epochId.toString();
  const evAmount = parsed.args.amount.toString();
  const evPrice = parsed.args.priceUSDC.toString();

  if (evSeller !== input.sellerAddress.toLowerCase()) {
    throw new HttpError(403, "Event seller does not match sellerAddress", "seller_mismatch");
  }
  if (evEpochId !== input.bondId) {
    throw new HttpError(400, "Event bondId/epochId does not match request", "bond_id_mismatch");
  }
  if (evAmount !== input.amount) {
    throw new HttpError(400, "Event amount does not match request", "amount_mismatch");
  }
  if (evPrice !== input.totalPriceUsdc) {
    throw new HttpError(400, "Event totalPrice does not match request", "price_mismatch");
  }

  // [V5.1 M-3] Anti-spam floor — totalPriceUsdc / amount >= minPricePerUnit.
  const amountBn = BigInt(input.amount);
  if (amountBn === 0n) {
    throw new HttpError(400, "Amount must be > 0", "invalid_amount");
  }
  let minPricePerUnit: bigint;
  try {
    minPricePerUnit = await marketplace.minPricePerUnit();
  } catch (e) {
    logger.warn({ err: e }, "minPricePerUnit lookup failed; falling back to DEFAULT_MIN_PRICE_PER_UNIT");
    minPricePerUnit = 1_000_000n;
  }
  const pricePerUnit = BigInt(input.totalPriceUsdc) / amountBn;
  if (pricePerUnit < minPricePerUnit) {
    throw new HttpError(
      400,
      `Listing price below M-3 floor: ${pricePerUnit} < ${minPricePerUnit} per unit`,
      "price_below_min"
    );
  }

  let blockTimestamp = 0;
  try {
    const block = await provider.getBlock(receipt.blockNumber);
    if (block) blockTimestamp = Number(block.timestamp);
  } catch (e) {
    logger.warn({ err: e, blockNumber: receipt.blockNumber }, "getBlock failed; createdAt may be 0");
  }

  return {
    txHash: input.txHash,
    listingId: evListingId,
    sellerAddress: input.sellerAddress,
    bondId: evEpochId,
    amount: evAmount,
    totalPriceUsdc: evPrice,
    blockNumber: receipt.blockNumber,
    blockTimestamp,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// VERIFY BUY (POST /api/v1/marketplace/buy — A.1.6)
// ────────────────────────────────────────────────────────────────────────────

export interface VerifyBuyInput {
  txHash: string;
  listingId: string;
  buyerAddress: string;
  amount: string;
  totalPaidUsdc: string;
  // Listing fields read from the local DB pre-check (source of truth for
  // amount, seller and bondId — the on-chain `Bought` event omits them).
  listingSeller: string;
  listingBondId: string;
  listingAmount: string;
}

export interface VerifiedBuy {
  txHash: string;
  listingId: string;
  buyerAddress: string;
  sellerAddress: string;
  bondId: string;
  amount: string;
  totalPaidUsdc: string;
  blockNumber: number;
  blockTimestamp: number; // seconds since epoch
}

/**
 * Verify a `LuminaBondMarketplace.executeBuy(listingId)` transaction.
 *
 * On-chain `Bought(listingId, buyer, seller, priceUSDC, sellerFee, buyerFee)`
 * gives us listingId / buyer / seller / priceUSDC. The buyer's actual USDC
 * outflow is `priceUSDC + buyerFee` (the marketplace's fee model from
 * `executeBuy`). The body's `totalPaidUsdc` MUST equal this derivation.
 *
 * Listing-level fields (amount, bondId, seller authoritative source) come
 * from the DB row populated by /marketplace/list (A.1.5) — `Bought` does
 * not re-emit them.
 */
export async function verifyBuy(input: VerifyBuyInput): Promise<VerifiedBuy> {
  const marketplaceAddr = (marketplace.target as string).toLowerCase();

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(input.txHash);
  } catch {
    throw new HttpError(502, "RPC error fetching receipt", "rpc_error");
  }
  if (!receipt) {
    throw new HttpError(400, "Tx not found", "tx_not_found");
  }
  if (receipt.status !== 1) {
    throw new HttpError(400, "Tx reverted on-chain", "tx_reverted");
  }
  if ((receipt.to ?? "").toLowerCase() !== marketplaceAddr) {
    throw new HttpError(400, "Tx is not a Marketplace call", "tx_not_marketplace");
  }
  if ((receipt.from ?? "").toLowerCase() !== input.buyerAddress.toLowerCase()) {
    throw new HttpError(403, "Buyer mismatch — txHash sender is not buyerAddress", "buyer_mismatch");
  }

  const iface = marketplace.interface;
  const eventFragment = iface.getEvent("Bought");
  if (!eventFragment) {
    throw new HttpError(500, "Bought event missing from ABI", "abi_misconfigured");
  }
  const eventTopic = eventFragment.topicHash;

  let parsed: LogDescription | null = null;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === marketplaceAddr &&
      log.topics[0] === eventTopic
    ) {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) break;
    }
  }
  if (!parsed) {
    throw new HttpError(400, "Bought event not found in tx logs", "event_missing");
  }

  const evListingId = parsed.args.listingId.toString();
  const evBuyer = String(parsed.args.buyer).toLowerCase();
  const evSeller = String(parsed.args.seller).toLowerCase();
  const evPriceUSDC: bigint = parsed.args.priceUSDC;
  const evBuyerFee: bigint = parsed.args.buyerFee;

  if (evListingId !== input.listingId) {
    throw new HttpError(400, "Event listingId does not match request", "listing_id_mismatch");
  }
  if (evBuyer !== input.buyerAddress.toLowerCase()) {
    throw new HttpError(403, "Event buyer does not match buyerAddress", "buyer_mismatch");
  }
  if (evSeller !== input.listingSeller.toLowerCase()) {
    throw new HttpError(409, "Event seller does not match the recorded listing seller", "seller_mismatch");
  }

  // Body amount must match the listing record. Marketplace.executeBuy is
  // an "all-or-nothing" fill — partial buys are not supported in V5.1.
  if (input.amount !== input.listingAmount) {
    throw new HttpError(
      400,
      `Body amount (${input.amount}) does not match listing amount (${input.listingAmount})`,
      "amount_mismatch"
    );
  }

  // [V5.1 fee model] totalPaid = listing.priceUSDC + buyerFee.
  const expectedTotalPaid = (evPriceUSDC + evBuyerFee).toString();
  if (input.totalPaidUsdc !== expectedTotalPaid) {
    throw new HttpError(
      400,
      `Body totalPaidUsdc (${input.totalPaidUsdc}) does not equal priceUSDC + buyerFee (${expectedTotalPaid})`,
      "price_mismatch"
    );
  }

  let blockTimestamp = 0;
  try {
    const block = await provider.getBlock(receipt.blockNumber);
    if (block) blockTimestamp = Number(block.timestamp);
  } catch (e) {
    logger.warn({ err: e, blockNumber: receipt.blockNumber }, "getBlock failed; executedAt may be 0");
  }

  return {
    txHash: input.txHash,
    listingId: evListingId,
    buyerAddress: input.buyerAddress,
    sellerAddress: input.listingSeller,
    bondId: input.listingBondId,
    amount: input.amount,
    totalPaidUsdc: input.totalPaidUsdc,
    blockNumber: receipt.blockNumber,
    blockTimestamp,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// MARKETPLACE STATS / HISTORY (read-only, agent-discovery surface)
// ────────────────────────────────────────────────────────────────────────────
//
// Dashboards and discovery agents repeatedly ask three "macro" questions
// about the marketplace:
//   1. What's the cheapest listing right now?  (floor)
//   2. How active was the last 24h?            (volume24h)
//   3. How big is the secondary market overall? (totalVolume + totalListings)
//
// Computing these on every request is wasteful — the inputs change only
// when /list or /buy lands a new row. We could invalidate on write, but a
// 30s TTL is simpler and bounded enough for dashboards (the values are
// already approximate aggregates). All queries hit the local SQLite store
// — `listings` and `purchases` tables are populated by the verifier-pattern
// /list and /buy endpoints, so they're authoritative for everything that
// went through this API. On-chain history that bypassed the API isn't
// reflected, but the V5.1 launch flow forces marketplace traffic through
// the verifier so this gap is theoretical.

export interface MarketplaceStats {
  /** Lowest `total_price_usdc` across active listings. "0" when empty. */
  floor: string;
  /** Sum of `total_paid_usdc` for purchases executed in the last 24h. */
  volume24h: string;
  /** Count of active listings. */
  totalListings: number;
  /** Sum of `total_paid_usdc` across the entire purchases history. */
  totalVolume: string;
}

const STATS_CACHE_TTL_MS = 30_000;
const statsCache = makeCache<MarketplaceStats>(STATS_CACHE_TTL_MS);

const STATS_CACHE_KEY = "stats";

/**
 * Aggregate marketplace stats from the local DB. Cached for 30s.
 *
 * SQLite TEXT BigInt-safety: `total_price_usdc` and `total_paid_usdc` are
 * stored as TEXT to avoid 2^63 overflow, but for `MIN()` / `SUM()` we
 * convert to INTEGER. That's safe up to 2^63 — USDC has 6 decimals, so
 * even an 8-figure single-listing price is well below the ceiling.
 * Aggregate sums could in principle exceed 2^63 across millions of
 * trades; not a concern for V5.1's marketplace volume.
 */
export async function getMarketplaceStats(): Promise<MarketplaceStats> {
  const cached = statsCache.get(STATS_CACHE_KEY);
  if (cached) return cached;

  const d = getDb();

  const floorRow = d
    .prepare(
      "SELECT MIN(CAST(total_price_usdc AS INTEGER)) AS floor FROM listings WHERE status = 'active'"
    )
    .get() as { floor: number | null };
  const totalListingsRow = d
    .prepare("SELECT COUNT(*) AS n FROM listings WHERE status = 'active'")
    .get() as { n: number };
  // executed_at is stored as ms-since-epoch (set from on-chain block time
  // when available, else null). Fall back to created_at when null so
  // recently-recorded purchases still count toward the 24h window.
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const volume24hRow = d
    .prepare(
      `SELECT COALESCE(SUM(CAST(total_paid_usdc AS INTEGER)), 0) AS v
         FROM purchases
        WHERE COALESCE(executed_at, created_at) >= ?`
    )
    .get(since) as { v: number };
  const totalVolumeRow = d
    .prepare("SELECT COALESCE(SUM(CAST(total_paid_usdc AS INTEGER)), 0) AS v FROM purchases")
    .get() as { v: number };

  const stats: MarketplaceStats = {
    floor: floorRow.floor === null ? "0" : String(floorRow.floor),
    volume24h: String(volume24hRow.v),
    totalListings: totalListingsRow.n,
    totalVolume: String(totalVolumeRow.v),
  };

  statsCache.set(STATS_CACHE_KEY, stats);
  return stats;
}

export interface Trade {
  listingId: string;
  buyer: string;
  seller: string;
  bondId: string;
  amount: string;
  /** Price the buyer paid (USDC base units, 6-dec). Includes buyer fee. */
  totalPaidUsdc: string;
  txHash: string;
  blockNumber: number;
  /** ISO-8601 timestamp from the on-chain block, falls back to row insertion time. */
  executedAt: string;
}

const HISTORY_CACHE_TTL_MS = 30_000;
const historyCache = makeCache<Trade[]>(HISTORY_CACHE_TTL_MS);

interface PurchaseHistoryRow {
  listing_id: string;
  buyer_address: string;
  seller_address: string;
  bond_id: string;
  amount: string;
  total_paid_usdc: string;
  tx_hash: string;
  block_number: number;
  executed_at: number | null;
  created_at: number;
}

/**
 * Page through completed marketplace trades, newest first.
 *
 * Source of truth is the local `purchases` table populated by the verifier-
 * pattern POST /buy, NOT the on-chain `Bought` event log — the event omits
 * amount/bondId, which we need to expose. The DB row already cross-checks
 * the on-chain receipt at insertion time, so reading from SQLite is both
 * faster and richer than re-deriving from logs. Cached 30s by `${limit}|${offset}`.
 */
export async function getMarketplaceHistory(
  limit: number,
  offset: number
): Promise<Trade[]> {
  const cacheKey = `${limit}|${offset}`;
  const cached = historyCache.get(cacheKey);
  if (cached) return cached;

  const d = getDb();
  const rows = d
    .prepare(
      `SELECT listing_id, buyer_address, seller_address, bond_id, amount,
              total_paid_usdc, tx_hash, block_number, executed_at, created_at
         FROM purchases
        ORDER BY COALESCE(executed_at, created_at) DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as PurchaseHistoryRow[];

  const trades: Trade[] = rows.map((r) => {
    const tsMs = r.executed_at ?? r.created_at;
    return {
      listingId: r.listing_id,
      buyer: r.buyer_address,
      seller: r.seller_address,
      bondId: r.bond_id,
      amount: r.amount,
      totalPaidUsdc: r.total_paid_usdc,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      executedAt: new Date(tsMs).toISOString(),
    };
  });

  historyCache.set(cacheKey, trades);
  return trades;
}

/**
 * Fetch a single listing by its on-chain listingId. Thin wrapper over the
 * DB helper that adds a 404-shaped Promise-rejection so the route layer
 * doesn't have to know about ListingRow internals. Returns the raw DB
 * shape — the route maps it to the public JSON.
 */
export function getMarketplaceListingById(listingId: string): ListingRow | undefined {
  return getListingByListingId(listingId);
}

// Test seams: clear in-memory caches between tests.
export function _resetMarketplaceCaches(): void {
  statsCache.reset();
  historyCache.reset();
}
