import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { publicIpLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { logger } from "../utils/logger";
import { provider } from "../utils/ethers";
import { getIndexerSyncState, query } from "../utils/indexerDb";

/**
 * Ponder-indexer-backed read endpoints (Sprint "Ponder revival").
 *
 * Consume the Ponder Postgres tables. All PUBLIC, read-only, IP-rate-limited.
 * Ponder maps camelCase TS fields → snake_case columns.
 *
 * Schema (indexer/ponder.schema.ts):
 *   policy(id, policy_id, product_id, buyer, coverage, premium, payout, paid_by,
 *          status, triggered_tx_hash, triggered_at, tx_hash, block_number, block_timestamp)
 *   trigger(id, policy_id, product_id, submitter, tx_hash, block_number, block_timestamp)
 *   bond(id, kind, owner, epoch_id, usd_amount, lumina_amount, maturity_at,
 *        tx_hash, block_number, block_timestamp)    -- ledger: kind in (issued, redeemed)
 *   burn(id, usdc_spent, lumina_burned, effective_price_usdc, source, block_number, block_timestamp, tx_hash)
 *   marketplace_listing(id, listing_id, seller, epoch_id, amount, price_usdc, status,
 *          created_at_block, created_tx_hash, created_at, filled_by, seller_fee, buyer_fee,
 *          filled_at_block, filled_tx_hash)
 *   vesting_claim(id, recipient, vesting_type, tranche_number, amount, tx_hash, block_number, block_timestamp)
 *
 * NOTE: every handler catches DB errors via next(err); when the indexer/DB is
 * not provisioned the error middleware returns a clean 5xx — it never crashes
 * the API, and the legacy on-chain /api/v1/public/* endpoints keep working.
 */

export const indexerRouter = Router();
indexerRouter.use(publicIpLimiter);

const AddressSchema = z.string().refine(ethers.isAddress, "must be a valid 0x address");
const LimitSchema = z.coerce.number().int().positive().max(500).default(50);
const OffsetSchema = z.coerce.number().int().nonnegative().default(0);
const LUMINA_TOTAL_SUPPLY_WEI = 100_000_000n * 10n ** 18n;

// ── 1. indexer health ──────────────────────────────────────────────────────
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

// ── 2. total policies ───────────────────────────────────────────────────────
indexerRouter.get("/stats/total-policies", async (_req, res, next) => {
  try {
    const rows = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM policy");
    res.json({ totalPolicies: Number(rows[0]?.count ?? 0) });
  } catch (err) {
    next(err);
  }
});

// ── 3. bonds outstanding (net issued − redeemed, in USD face units) ──────────
indexerRouter.get("/stats/total-bonds-issued", async (_req, res, next) => {
  try {
    const rows = await query<{ outstanding: string | null; issued_count: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN kind='issued' THEN usd_amount ELSE -usd_amount END), 0)::text AS outstanding,
         COUNT(*) FILTER (WHERE kind='issued')::text AS issued_count
       FROM bond`
    );
    res.json({
      totalBondsIssued: Number(rows[0]?.issued_count ?? 0),
      bondsOutstandingUsd: rows[0]?.outstanding ?? "0",
    });
  } catch (err) {
    next(err);
  }
});

// ── 4. total LUMINA burned ───────────────────────────────────────────────────
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

// ── 5. burn rate 7d ──────────────────────────────────────────────────────────
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

// ── 6. policy volume 24h ─────────────────────────────────────────────────────
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

// ── 7. policies by buyer ─────────────────────────────────────────────────────
indexerRouter.get("/policies/by-buyer/:address", async (req, res, next) => {
  try {
    const parsed = AddressSchema.safeParse(req.params.address);
    if (!parsed.success) throw new HttpError(400, "invalid address", "invalid_address");
    const limit = LimitSchema.parse(req.query.limit);
    const offset = OffsetSchema.parse(req.query.offset);
    const rows = await query(
      `SELECT id, policy_id, product_id, buyer, coverage, premium, payout, paid_by,
              status, triggered_tx_hash, triggered_at, tx_hash, block_number, block_timestamp
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

// ── 8. bonds by owner (net holdings per epoch) ───────────────────────────────
indexerRouter.get("/bonds/by-owner/:address", async (req, res, next) => {
  try {
    const parsed = AddressSchema.safeParse(req.params.address);
    if (!parsed.success) throw new HttpError(400, "invalid address", "invalid_address");
    const rows = await query(
      `SELECT epoch_id,
              COALESCE(SUM(CASE WHEN kind='issued' THEN usd_amount ELSE -usd_amount END), 0)::text AS balance,
              MAX(maturity_at)::text AS maturity_at,
              MIN(block_timestamp) FILTER (WHERE kind='issued')::text AS issued_at,
              BOOL_OR(kind='redeemed') AS has_redeemed
       FROM bond
       WHERE LOWER(owner) = LOWER($1)
       GROUP BY epoch_id
       HAVING COALESCE(SUM(CASE WHEN kind='issued' THEN usd_amount ELSE -usd_amount END), 0) > 0
       ORDER BY epoch_id DESC`,
      [parsed.data]
    );
    res.json({ bonds: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// ── 9. recent triggers ───────────────────────────────────────────────────────
indexerRouter.get("/triggers/recent", async (req, res, next) => {
  try {
    const limit = LimitSchema.parse(req.query.limit);
    const rows = await query(
      `SELECT id, policy_id, product_id, submitter, tx_hash, block_number, block_timestamp
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

// ── 10. marketplace active listings ──────────────────────────────────────────
indexerRouter.get("/marketplace/active-listings", async (req, res, next) => {
  try {
    const limit = LimitSchema.parse(req.query.limit);
    const rows = await query(
      `SELECT id, listing_id, seller, epoch_id, amount, price_usdc, status,
              created_at_block, created_tx_hash, created_at
       FROM marketplace_listing
       WHERE status = 'active'
       ORDER BY listing_id DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ listings: rows, count: rows.length, limit });
  } catch (err) {
    next(err);
  }
});

// ── 11. marketplace recent sales ─────────────────────────────────────────────
indexerRouter.get("/marketplace/recent-sales", async (req, res, next) => {
  try {
    const limit = LimitSchema.parse(req.query.limit);
    const rows = await query(
      `SELECT id, listing_id, seller, filled_by, epoch_id, amount, price_usdc,
              seller_fee, buyer_fee, filled_at_block, filled_tx_hash
       FROM marketplace_listing
       WHERE status = 'filled'
       ORDER BY filled_at_block DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ sales: rows, count: rows.length, limit });
  } catch (err) {
    next(err);
  }
});

// ── 12. recent burns ─────────────────────────────────────────────────────────
indexerRouter.get("/burns/recent", async (req, res, next) => {
  try {
    const limit = LimitSchema.parse(req.query.limit);
    const sourceFilter = z
      .enum(["TWAPBurner", "BuybackEngine", "all"])
      .default("all")
      .parse(req.query.source ?? "all");
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

// ── NEW (Phase F): /stats/burns — aggregate burn dashboard ──────────────────
indexerRouter.get("/stats/burns", async (_req, res, next) => {
  try {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
    const [totals, last30, byDay] = await Promise.all([
      query<{ burned: string | null; usdc: string | null; cnt: string }>(
        `SELECT COALESCE(SUM(lumina_burned),0)::text AS burned,
                COALESCE(SUM(usdc_spent),0)::text AS usdc,
                COUNT(*)::text AS cnt FROM burn`
      ),
      query<{ burned: string | null }>(
        "SELECT COALESCE(SUM(lumina_burned),0)::text AS burned FROM burn WHERE block_timestamp >= $1",
        [thirtyDaysAgo]
      ),
      query(
        `SELECT TO_CHAR(TO_TIMESTAMP(block_timestamp)::date, 'YYYY-MM-DD') AS day,
                SUM(lumina_burned)::text AS lumina_burned,
                SUM(usdc_spent)::text AS usdc_spent
         FROM burn
         WHERE block_timestamp >= $1
         GROUP BY day ORDER BY day ASC`,
        [thirtyDaysAgo]
      ),
    ]);
    res.json({
      total_lumina_burned: totals[0]?.burned ?? "0",
      total_usdc_volume: totals[0]?.usdc ?? "0",
      last_30_days_burned: last30[0]?.burned ?? "0",
      burns_count: Number(totals[0]?.cnt ?? 0),
      by_day: byDay,
    });
  } catch (err) {
    next(err);
  }
});

// ── NEW (Phase F): /stats/protocol — protocol-wide snapshot ─────────────────
indexerRouter.get("/stats/protocol", async (_req, res, next) => {
  try {
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const [pol, bonds, prem, mkt, burned] = await Promise.all([
      query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM policy WHERE status='active'"),
      query<{ outstanding: string | null }>(
        `SELECT COALESCE(SUM(CASE WHEN kind='issued' THEN usd_amount ELSE -usd_amount END),0)::text AS outstanding FROM bond`
      ),
      query<{ sum: string | null }>("SELECT COALESCE(SUM(premium),0)::text AS sum FROM policy"),
      query<{ vol: string | null }>(
        `SELECT COALESCE(SUM(price_usdc),0)::text AS vol FROM marketplace_listing
         WHERE status='filled' AND filled_at_block IS NOT NULL`
      ),
      query<{ sum: string | null }>("SELECT COALESCE(SUM(lumina_burned),0)::text AS sum FROM burn"),
    ]);
    void dayAgo;
    const circulating = (LUMINA_TOTAL_SUPPLY_WEI - BigInt(burned[0]?.sum ?? "0")).toString();
    res.json({
      active_policies: Number(pol[0]?.cnt ?? 0),
      bonds_outstanding_usd: bonds[0]?.outstanding ?? "0",
      total_premium_collected: prem[0]?.sum ?? "0",
      marketplace_volume_total: mkt[0]?.vol ?? "0",
      lumina_total_burned: burned[0]?.sum ?? "0",
      lumina_circulating: circulating, // derived: total supply − burned
    });
  } catch (err) {
    next(err);
  }
});

// ── NEW (Phase F): /stats/activity — unified recent activity feed ───────────
indexerRouter.get("/stats/activity", async (req, res, next) => {
  try {
    const limit = z.coerce.number().int().positive().max(100).default(100).parse(req.query.limit);
    const rows = await query(
      `(
        SELECT 'policy_purchased' AS type, buyer AS actor, coverage::text AS amount,
               policy_id::text AS ref, tx_hash, block_number, block_timestamp FROM policy
      ) UNION ALL (
        SELECT 'bond_minted' AS type, owner AS actor, usd_amount::text AS amount,
               epoch_id::text AS ref, tx_hash, block_number, block_timestamp
        FROM bond WHERE kind='issued'
      ) UNION ALL (
        SELECT 'bond_redeemed' AS type, owner AS actor, lumina_amount::text AS amount,
               epoch_id::text AS ref, tx_hash, block_number, block_timestamp
        FROM bond WHERE kind='redeemed'
      ) UNION ALL (
        SELECT 'marketplace_buy' AS type, filled_by AS actor, price_usdc::text AS amount,
               listing_id::text AS ref, filled_tx_hash AS tx_hash, filled_at_block AS block_number,
               created_at AS block_timestamp
        FROM marketplace_listing WHERE status='filled'
      ) UNION ALL (
        SELECT 'lumina_burned' AS type, source AS actor, lumina_burned::text AS amount,
               NULL AS ref, tx_hash, block_number, block_timestamp FROM burn
      )
      ORDER BY block_number DESC NULLS LAST
      LIMIT $1`,
      [limit]
    );
    res.json({ events: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// ── NEW (Phase F): /stats/lumina-price-history — from burn effective price ──
indexerRouter.get("/stats/lumina-price-history", async (req, res, next) => {
  try {
    const range = z.enum(["24h", "7d", "30d", "all"]).default("24h").parse(req.query.range ?? "24h");
    const since =
      range === "all"
        ? 0
        : Math.floor(Date.now() / 1000) -
          (range === "24h" ? 86400 : range === "7d" ? 7 * 86400 : 30 * 86400);
    const rows = await query(
      `SELECT block_timestamp::text AS t, effective_price_usdc::text AS price_usdc, tx_hash
       FROM burn WHERE block_timestamp >= $1 ORDER BY block_timestamp ASC`,
      [since]
    );
    res.json({ range, points: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// ── vesting founder claims ───────────────────────────────────────────────────
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
