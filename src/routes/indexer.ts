import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { publicIpLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { logger } from "../utils/logger";
import { provider } from "../utils/ethers";
import { getIndexerSyncState, query } from "../utils/indexerDb";

/**
 * Sprint K — 12 endpoints that consume the Ponder indexer's Postgres tables
 * (`policy`, `bond`, `burn`, `trigger`, `vesting_claim`).
 *
 * All endpoints are PUBLIC (read-only) and IP-rate-limited. They never
 * touch the API's SQLite — only the indexer Postgres.
 *
 * Schema reminder (Sprint J `indexer/ponder.schema.ts`):
 *   policy(id, policy_id, buyer, shield, product_id, premium, coverage_amount, expires_at, status, tx_hash, block_number, block_timestamp)
 *   bond(id, owner, epoch_id, amount, face_value_usd, issued_at, maturity_at, redeemed, redeemed_at, tx_hash)
 *   burn(id, usdc_spent, lumina_burned, effective_price_usdc, source, block_number, block_timestamp, tx_hash)
 *   trigger(id, policy_id, shield, submitted_by, status, payout_amount, tx_hash, block_number)
 *   vesting_claim(id, recipient, vesting_type, tranche_number, amount, tx_hash, block_number, block_timestamp)
 *
 * Ponder converts camelCase TS field names to snake_case in Postgres.
 */

export const indexerRouter = Router();

// All indexer endpoints share the same IP rate limit as the public surface.
indexerRouter.use(publicIpLimiter);

const AddressSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");
const LimitSchema = z.coerce.number().int().positive().max(500).default(50);
const OffsetSchema = z.coerce.number().int().nonnegative().default(0);

// ─────────────────────────────────────────────────────────────────────────
// 1. /api/v1/indexer/health — lag + sync state
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/indexer/health", async (_req, res, next) => {
  try {
    const [{ lastSyncedBlock }, headBlock] = await Promise.all([
      getIndexerSyncState(),
      provider.getBlockNumber(),
    ]);
    const lagBlocks = BigInt(headBlock) - lastSyncedBlock;
    res.json({
      status: lagBlocks > 100n ? "lagging" : lastSyncedBlock === 0n ? "syncing" : "synced",
      lastSyncedBlock: lastSyncedBlock.toString(),
      headBlock: headBlock.toString(),
      lagBlocks: lagBlocks.toString(),
    });
  } catch (err) {
    logger.error({ err }, "[indexer] health check failed");
    next(new HttpError(503, "indexer unavailable", "indexer_unavailable"));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 2. /api/v1/stats/total-policies
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/stats/total-policies", async (_req, res, next) => {
  try {
    const rows = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM policy");
    res.json({ totalPolicies: Number(rows[0]?.count ?? 0) });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3. /api/v1/stats/total-bonds-issued
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/stats/total-bonds-issued", async (_req, res, next) => {
  try {
    const rows = await query<{ count: string; sum: string | null }>(
      "SELECT COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::text AS sum FROM bond WHERE redeemed = false"
    );
    res.json({
      totalBondsIssued: Number(rows[0]?.count ?? 0),
      totalUsdFaceValue: rows[0]?.sum ?? "0",
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 4. /api/v1/stats/total-lumina-burned
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/stats/total-lumina-burned", async (_req, res, next) => {
  try {
    const rows = await query<{ sum: string | null }>(
      "SELECT COALESCE(SUM(lumina_burned), 0)::text AS sum FROM burn"
    );
    res.json({ totalLuminaBurned: rows[0]?.sum ?? "0" });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. /api/v1/stats/burn-rate-7d — average daily burn over last 7 days
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/stats/burn-rate-7d", async (_req, res, next) => {
  try {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rows = await query<{ sum: string | null }>(
      "SELECT COALESCE(SUM(lumina_burned), 0)::text AS sum FROM burn WHERE block_timestamp >= $1",
      [sevenDaysAgo]
    );
    const total7d = BigInt(rows[0]?.sum ?? "0");
    res.json({
      windowDays: 7,
      totalBurnedInWindow: total7d.toString(),
      avgDailyBurn: (total7d / 7n).toString(),
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 6. /api/v1/stats/policy-volume-24h — total premium written last 24h
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/stats/policy-volume-24h", async (_req, res, next) => {
  try {
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const rows = await query<{ count: string; sum: string | null }>(
      "SELECT COUNT(*)::text AS count, COALESCE(SUM(premium), 0)::text AS sum FROM policy WHERE block_timestamp >= $1",
      [oneDayAgo]
    );
    res.json({
      windowHours: 24,
      policiesWritten: Number(rows[0]?.count ?? 0),
      totalPremiumWritten: rows[0]?.sum ?? "0",
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 7. /api/v1/policies/by-buyer/:address
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/policies/by-buyer/:address", async (req, res, next) => {
  try {
    const parsed = AddressSchema.safeParse(req.params.address);
    if (!parsed.success) {
      throw new HttpError(400, "invalid address", "invalid_address");
    }
    const limit = LimitSchema.parse(req.query.limit);
    const offset = OffsetSchema.parse(req.query.offset);

    const rows = await query(
      `SELECT id, policy_id, buyer, shield, product_id, premium, coverage_amount,
              expires_at, status, tx_hash, block_number, block_timestamp
       FROM policy
       WHERE LOWER(buyer) = LOWER($1)
       ORDER BY block_number DESC
       LIMIT $2 OFFSET $3`,
      [parsed.data, limit, offset]
    );
    res.json({ policies: rows, count: rows.length, limit, offset });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 8. /api/v1/bonds/by-owner/:address
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/bonds/by-owner/:address", async (req, res, next) => {
  try {
    const parsed = AddressSchema.safeParse(req.params.address);
    if (!parsed.success) {
      throw new HttpError(400, "invalid address", "invalid_address");
    }
    const limit = LimitSchema.parse(req.query.limit);
    const offset = OffsetSchema.parse(req.query.offset);

    const rows = await query(
      `SELECT id, owner, epoch_id, amount, face_value_usd, issued_at, maturity_at,
              redeemed, redeemed_at, tx_hash
       FROM bond
       WHERE LOWER(owner) = LOWER($1)
       ORDER BY issued_at DESC
       LIMIT $2 OFFSET $3`,
      [parsed.data, limit, offset]
    );
    res.json({ bonds: rows, count: rows.length, limit, offset });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 9. /api/v1/triggers/recent
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/triggers/recent", async (req, res, next) => {
  try {
    const limit = LimitSchema.parse(req.query.limit);
    const rows = await query(
      `SELECT id, policy_id, shield, submitted_by, status, payout_amount, tx_hash, block_number
       FROM trigger
       ORDER BY block_number DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ triggers: rows, count: rows.length, limit });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 10. /api/v1/marketplace/active-listings
// ─────────────────────────────────────────────────────────────────────────
// Note: marketplace events (BondListed/BondSold/etc.) are NOT yet emitted
// by `LuminaBondMarketplace` — they're in the Fase 2 Hardening backlog
// (ADR-008 follow-up). This endpoint returns 501 until those events are
// added + the indexer schema gets a `marketplace_listing` table.
indexerRouter.get("/marketplace/active-listings", async (_req, _res, next) => {
  next(
    new HttpError(
      501,
      "marketplace events pending Fase 2 Hardening (ADR-008 follow-up)",
      "not_implemented"
    )
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 11. /api/v1/marketplace/recent-sales
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/marketplace/recent-sales", async (_req, _res, next) => {
  next(
    new HttpError(
      501,
      "marketplace events pending Fase 2 Hardening (ADR-008 follow-up)",
      "not_implemented"
    )
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 12. /api/v1/burns/recent
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/burns/recent", async (req, res, next) => {
  try {
    const limit = LimitSchema.parse(req.query.limit);
    const sourceFilter = z.enum(["TWAPBurner", "BuybackEngine", "all"]).default("all").parse(
      req.query.source ?? "all"
    );

    const params: unknown[] = [limit];
    let whereClause = "";
    if (sourceFilter !== "all") {
      whereClause = "WHERE source = $2";
      params.push(sourceFilter);
    }
    const rows = await query(
      `SELECT id, usdc_spent, lumina_burned, effective_price_usdc, source,
              block_number, block_timestamp, tx_hash
       FROM burn
       ${whereClause}
       ORDER BY block_number DESC
       LIMIT $1`,
      params
    );
    res.json({ burns: rows, count: rows.length, limit, source: sourceFilter });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Bonus: /api/v1/vesting/founder/claims (not in spec count but cheap to add)
// ─────────────────────────────────────────────────────────────────────────
indexerRouter.get("/vesting/founder/claims", async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT id, recipient, vesting_type, tranche_number, amount, tx_hash,
              block_number, block_timestamp
       FROM vesting_claim
       WHERE vesting_type = 'founder'
       ORDER BY tranche_number ASC`
    );
    res.json({ claims: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});
