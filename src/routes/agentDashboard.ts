import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth";
import { apiLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { query, getIndexerSyncState } from "../utils/indexerDb";
import { provider } from "../utils/ethers";
import { makeCache } from "../utils/cache";

/**
 * Authenticated agent-dashboard reads, scoped to the caller's wallet and served
 * from the Ponder indexer:
 *   GET /api/v1/agent/activity   unified, paginated event feed
 *   GET /api/v1/agent/earnings   premiums / payouts / marketplace P&L
 *
 * Every response carries an `indexer` block (lastSyncedBlock / lagBlocks /
 * status) so the UI can show "data may be delayed" instead of silently wrong
 * numbers — the honesty bar for financial views.
 */
export const agentDashboardRouter = Router();

// Indexer freshness — cached briefly so a burst of dashboard calls doesn't fan
// out an eth_blockNumber per request.
const healthCache = makeCache<{ lastSyncedBlock: number; headBlock: number; lagBlocks: number; status: string }>(15_000);
async function indexerHealth() {
  const hit = healthCache.get("h");
  if (hit) return hit;
  let lastSyncedBlock = 0;
  let headBlock = 0;
  try {
    lastSyncedBlock = Number((await getIndexerSyncState()).lastSyncedBlock);
  } catch { /* leave 0 */ }
  try {
    headBlock = await provider.getBlockNumber();
  } catch { /* leave 0 */ }
  const lagBlocks = headBlock > 0 && lastSyncedBlock > 0 ? Math.max(0, headBlock - lastSyncedBlock) : 0;
  const status = lastSyncedBlock === 0 ? "unknown" : lagBlocks > 50 ? "lagging" : "synced";
  const out = { lastSyncedBlock, headBlock, lagBlocks, status };
  healthCache.set("h", out);
  return out;
}

// ─────────────────────────── ACTIVITY ───────────────────────────
const ActivityQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  before: z.coerce.number().int().positive().optional(), // keyset cursor (blockNumber)
});

interface ActivityRow {
  type: string;
  amount: string | null;
  ref: string | null;
  tx_hash: string | null;
  block_number: string | number | null;
  block_timestamp: string | number | null;
}

agentDashboardRouter.get("/activity", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const { limit, before } = ActivityQuery.parse(req.query);
    const w = req.agent.wallet.toLowerCase();
    // Each arm aliases its own block column to `block_number`; the outer query
    // applies the cursor + ordering uniformly.
    const rows = await query<ActivityRow>(
      `SELECT * FROM (
         (SELECT 'policy_purchased' AS type, premium::text AS amount, policy_id::text AS ref,
                 tx_hash, block_number, block_timestamp FROM policy WHERE LOWER(buyer)=$1)
         UNION ALL
         (SELECT 'policy_triggered' AS type, NULL AS amount, t.policy_id::text AS ref,
                 t.tx_hash, t.block_number, t.block_timestamp
          FROM trigger t JOIN policy p ON p.product_id=t.product_id AND p.policy_id=t.policy_id
          WHERE LOWER(p.buyer)=$1)
         UNION ALL
         (SELECT 'bond_minted' AS type, usd_amount::text AS amount, epoch_id::text AS ref,
                 tx_hash, block_number, block_timestamp FROM bond WHERE kind='issued' AND LOWER(owner)=$1)
         UNION ALL
         (SELECT 'bond_redeemed' AS type, usd_amount::text AS amount, epoch_id::text AS ref,
                 tx_hash, block_number, block_timestamp FROM bond WHERE kind='redeemed' AND LOWER(owner)=$1)
         UNION ALL
         (SELECT 'listing_created' AS type, price_usdc::text AS amount, listing_id::text AS ref,
                 created_tx_hash AS tx_hash, created_at_block AS block_number, created_at AS block_timestamp
          FROM marketplace_listing WHERE LOWER(seller)=$1)
         UNION ALL
         (SELECT 'listing_sold' AS type, price_usdc::text AS amount, listing_id::text AS ref,
                 filled_tx_hash AS tx_hash, filled_at_block AS block_number, created_at AS block_timestamp
          FROM marketplace_listing WHERE status='filled' AND LOWER(seller)=$1)
         UNION ALL
         (SELECT 'marketplace_buy' AS type, price_usdc::text AS amount, listing_id::text AS ref,
                 filled_tx_hash AS tx_hash, filled_at_block AS block_number, created_at AS block_timestamp
          FROM marketplace_listing WHERE status='filled' AND LOWER(filled_by)=$1)
       ) q
       WHERE ($3::bigint IS NULL OR q.block_number < $3)
       ORDER BY q.block_number DESC NULLS LAST
       LIMIT $2`,
      [w, limit, before ?? null]
    );
    const items = rows.map((r) => ({
      type: r.type,
      amount: r.amount,
      ref: r.ref,
      txHash: r.tx_hash,
      blockNumber: r.block_number != null ? Number(r.block_number) : null,
      blockTimestamp: r.block_timestamp != null ? Number(r.block_timestamp) : null,
    }));
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last?.blockNumber ? last.blockNumber : null;
    res.json({ wallet: w, count: items.length, items, nextCursor, indexer: await indexerHealth() });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────── EARNINGS ───────────────────────────
// Money decimals in the indexer: policy.premium/coverage/payout = 6-dec USDC;
// bond.usd_amount = integer USD ($1/unit); marketplace.price_usdc/fees = 6-dec.
const earningsCache = makeCache<unknown>(30_000);

agentDashboardRouter.get("/earnings", authMiddleware, apiLimiter, async (req, res, next) => {
  try {
    if (!req.agent) throw new HttpError(401, "Unauthenticated", "unauthenticated");
    const w = req.agent.wallet.toLowerCase();
    const cached = earningsCache.get(w);
    if (cached) {
      res.json(cached);
      return;
    }

    const num = (rows: Array<Record<string, string | null>>, key: string): number =>
      rows[0]?.[key] != null ? Number(rows[0][key]) : 0;

    const [premRows, payoutRows, faceRows, mkRows, daily] = await Promise.all([
      query<Record<string, string>>(
        `SELECT COALESCE(SUM(premium),0)::text AS v FROM policy WHERE LOWER(buyer)=$1`, [w]),
      query<Record<string, string>>(
        `SELECT COALESCE(SUM(usd_amount),0)::text AS v FROM bond WHERE kind='redeemed' AND LOWER(owner)=$1`, [w]),
      query<Record<string, string>>(
        `SELECT
           COALESCE(SUM(usd_amount) FILTER (WHERE kind='issued'),0)::text AS issued,
           COALESCE(SUM(usd_amount) FILTER (WHERE kind='redeemed'),0)::text AS redeemed
         FROM bond WHERE LOWER(owner)=$1`, [w]),
      query<Record<string, string>>(
        `SELECT
           COALESCE(SUM(price_usdc - COALESCE(seller_fee,0)) FILTER (WHERE LOWER(seller)=$1),0)::text AS sales,
           COALESCE(SUM(price_usdc + COALESCE(buyer_fee,0)) FILTER (WHERE LOWER(filled_by)=$1),0)::text AS buys
         FROM marketplace_listing WHERE status='filled'`, [w]),
      query<Record<string, string>>(
        `SELECT to_char(to_timestamp(block_timestamp), 'YYYY-MM-DD') AS date,
                COALESCE(SUM(premium),0)::text AS premiums
         FROM policy WHERE LOWER(buyer)=$1
         GROUP BY 1 ORDER BY 1`, [w]),
    ]);

    const premiumsPaidUsd = num(premRows, "v") / 1e6;
    const payoutsReceivedUsd = num(payoutRows, "v"); // integer USD
    const issuedFace = num(faceRows, "issued");
    const redeemedFace = num(faceRows, "redeemed");
    const outstandingFaceUsd = Math.max(0, issuedFace - redeemedFace);
    const salesUsd = num(mkRows, "sales") / 1e6;
    const buysUsd = num(mkRows, "buys") / 1e6;
    const marketplaceNetUsd = salesUsd - buysUsd;
    const realizedPnlUsd = payoutsReceivedUsd + marketplaceNetUsd - premiumsPaidUsd;

    const round = (n: number) => Math.round(n * 100) / 100;
    const out = {
      wallet: w,
      summary: {
        premiumsPaidUsd: round(premiumsPaidUsd),
        payoutsReceivedUsd: round(payoutsReceivedUsd),
        marketplaceNetUsd: round(marketplaceNetUsd),
        outstandingFaceUsd: round(outstandingFaceUsd),
        realizedPnlUsd: round(realizedPnlUsd),
      },
      daily: daily.map((d) => ({ date: d.date, premiumsUsd: round(Number(d.premiums) / 1e6) })),
      indexer: await indexerHealth(),
    };
    earningsCache.set(w, out);
    res.json(out);
  } catch (e) {
    next(e);
  }
});
