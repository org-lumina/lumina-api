import { query } from "../utils/indexerDb";
import { kvGet, kvSet } from "../db/database";
import { emit, type WebhookEventName } from "./webhooks";
import { logger } from "../utils/logger";

/**
 * Chain-events → webhook emitter.
 *
 * The webhook delivery engine (services/webhooks.ts) can fan out any event that
 * lands in `webhook_events`, but most of LUMINA's domain events are PURE
 * ON-CHAIN events (a trigger, a bond mint/redeem, a marketplace fill) that the
 * API itself never originates — they happen when a user/keeper sends a tx
 * directly. So nothing was emitting them.
 *
 * This service is the missing producer: it polls the Ponder INDEXER Postgres
 * for new rows per stream and calls `emit()` for each, so subscribers receive
 * every on-chain event regardless of who initiated it.
 *
 * Exactly-once across restarts: each stream keeps a persisted block cursor in
 * the `kv` table and processes COMPLETE blocks only — every poll handles all
 * rows in `(cursor, safeHead]` where `safeHead = MAX(blockCol)`, then advances
 * the cursor to `safeHead`. Because a whole block is consumed at once, no row
 * is split across polls. Delivery is at-least-once (a crash after emit but
 * before the cursor write re-emits); receivers should treat the
 * `X-Lumina-Delivery` id as idempotent.
 *
 * On first run a stream initialises its cursor to the current head and emits
 * NOTHING for history — we don't want to flood subscribers with months of
 * past events the moment they register.
 */

export const CHAIN_EVENTS_TICK_MS = 10_000;

interface Stream {
  event: WebhookEventName;
  blockCol: string; // PG column the cursor tracks
  // returns rows in (cursor, safeHead]; each row → { wallet, payload }
  fetch: (cursor: number, safeHead: number) => Promise<Array<{ wallet: string; payload: unknown }>>;
  head: () => Promise<number>;
}

function cursorKey(event: string): string {
  return `chainevents:cursor:${event}`;
}

async function maxBlock(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await query<{ h: string | number | null }>(sql, params);
  const h = rows[0]?.h;
  return h == null ? 0 : Number(h);
}

const STREAMS: Stream[] = [
  {
    event: "policy_purchased",
    blockCol: "block_number",
    head: () => maxBlock("SELECT MAX(block_number) AS h FROM policy"),
    fetch: async (cursor, safeHead) => {
      const rows = await query<Record<string, string>>(
        `SELECT buyer, product_id, policy_id::text AS policy_id, coverage::text AS coverage,
                premium::text AS premium, payout::text AS payout, tx_hash, block_number::text AS block_number
         FROM policy WHERE block_number > $1 AND block_number <= $2 ORDER BY block_number ASC`,
        [cursor, safeHead]
      );
      return rows.map((r) => ({
        wallet: r.buyer,
        payload: {
          event: "policy_purchased",
          productId: r.product_id,
          policyId: r.policy_id,
          coverage: r.coverage,
          premium: r.premium,
          payout: r.payout,
          txHash: r.tx_hash,
          blockNumber: r.block_number,
        },
      }));
    },
  },
  {
    event: "policy_triggered",
    blockCol: "t.block_number",
    head: () => maxBlock("SELECT MAX(block_number) AS h FROM trigger"),
    fetch: async (cursor, safeHead) => {
      // The interested party is the policy BUYER, not the (relayer) submitter,
      // so join back to `policy` for the owner address.
      const rows = await query<Record<string, string>>(
        `SELECT p.buyer, t.product_id, t.policy_id::text AS policy_id, t.tx_hash,
                t.block_number::text AS block_number
         FROM trigger t JOIN policy p
           ON p.product_id = t.product_id AND p.policy_id = t.policy_id
         WHERE t.block_number > $1 AND t.block_number <= $2 ORDER BY t.block_number ASC`,
        [cursor, safeHead]
      );
      return rows.map((r) => ({
        wallet: r.buyer,
        payload: {
          event: "policy_triggered",
          productId: r.product_id,
          policyId: r.policy_id,
          txHash: r.tx_hash,
          blockNumber: r.block_number,
        },
      }));
    },
  },
  {
    event: "bond_minted",
    blockCol: "block_number",
    head: () => maxBlock("SELECT MAX(block_number) AS h FROM bond WHERE kind='issued'"),
    fetch: async (cursor, safeHead) => {
      const rows = await query<Record<string, string>>(
        `SELECT owner, epoch_id::text AS epoch_id, usd_amount::text AS usd_amount, tx_hash,
                block_number::text AS block_number
         FROM bond WHERE kind='issued' AND block_number > $1 AND block_number <= $2 ORDER BY block_number ASC`,
        [cursor, safeHead]
      );
      return rows.map((r) => ({
        wallet: r.owner,
        payload: {
          event: "bond_minted",
          epochId: r.epoch_id,
          usdAmount: r.usd_amount,
          txHash: r.tx_hash,
          blockNumber: r.block_number,
        },
      }));
    },
  },
  {
    event: "bond_redeemed",
    blockCol: "block_number",
    head: () => maxBlock("SELECT MAX(block_number) AS h FROM bond WHERE kind='redeemed'"),
    fetch: async (cursor, safeHead) => {
      const rows = await query<Record<string, string>>(
        `SELECT owner, epoch_id::text AS epoch_id, usd_amount::text AS usd_amount,
                lumina_amount::text AS lumina_amount, tx_hash, block_number::text AS block_number
         FROM bond WHERE kind='redeemed' AND block_number > $1 AND block_number <= $2 ORDER BY block_number ASC`,
        [cursor, safeHead]
      );
      return rows.map((r) => ({
        wallet: r.owner,
        payload: {
          event: "bond_redeemed",
          epochId: r.epoch_id,
          usdAmount: r.usd_amount,
          luminaAmount: r.lumina_amount,
          txHash: r.tx_hash,
          blockNumber: r.block_number,
        },
      }));
    },
  },
  {
    event: "listing_created",
    blockCol: "created_at_block",
    head: () => maxBlock("SELECT MAX(created_at_block) AS h FROM marketplace_listing"),
    fetch: async (cursor, safeHead) => {
      const rows = await query<Record<string, string>>(
        `SELECT seller, listing_id::text AS listing_id, epoch_id::text AS epoch_id,
                amount::text AS amount, price_usdc::text AS price_usdc,
                created_tx_hash AS tx_hash, created_at_block::text AS block_number
         FROM marketplace_listing
         WHERE created_at_block > $1 AND created_at_block <= $2 ORDER BY created_at_block ASC`,
        [cursor, safeHead]
      );
      return rows.map((r) => ({
        wallet: r.seller,
        payload: {
          event: "listing_created",
          listingId: r.listing_id,
          epochId: r.epoch_id,
          amount: r.amount,
          priceUsdc: r.price_usdc,
          txHash: r.tx_hash,
          blockNumber: r.block_number,
        },
      }));
    },
  },
  {
    event: "listing_purchased",
    blockCol: "filled_at_block",
    head: () =>
      maxBlock("SELECT MAX(filled_at_block) AS h FROM marketplace_listing WHERE status='filled'"),
    fetch: async (cursor, safeHead) => {
      // Notify the SELLER ("your listing sold"). filled_by is included so a
      // buyer-side subscription could be added later.
      const rows = await query<Record<string, string>>(
        `SELECT seller, filled_by, listing_id::text AS listing_id, price_usdc::text AS price_usdc,
                filled_tx_hash AS tx_hash, filled_at_block::text AS block_number
         FROM marketplace_listing
         WHERE status='filled' AND filled_at_block IS NOT NULL
           AND filled_at_block > $1 AND filled_at_block <= $2 ORDER BY filled_at_block ASC`,
        [cursor, safeHead]
      );
      return rows.map((r) => ({
        wallet: r.seller,
        payload: {
          event: "listing_purchased",
          listingId: r.listing_id,
          priceUsdc: r.price_usdc,
          filledBy: r.filled_by,
          txHash: r.tx_hash,
          blockNumber: r.block_number,
        },
      }));
    },
  },
];

async function processStream(s: Stream): Promise<number> {
  const safeHead = await s.head();
  if (safeHead <= 0) return 0;

  const raw = kvGet(cursorKey(s.event));
  if (raw === undefined) {
    // First run: skip history, start watching from the current head.
    kvSet(cursorKey(s.event), String(safeHead));
    return 0;
  }
  const cursor = Number(raw);
  if (safeHead <= cursor) return 0;

  const items = await s.fetch(cursor, safeHead);
  for (const it of items) {
    if (it.wallet) emit(s.event, it.wallet, it.payload);
  }
  kvSet(cursorKey(s.event), String(safeHead));
  return items.length;
}

export async function chainEventsTick(): Promise<void> {
  for (const s of STREAMS) {
    try {
      const n = await processStream(s);
      if (n > 0) logger.info({ event: s.event, emitted: n }, "chain-events emitted");
    } catch (err) {
      // One bad stream (or a transient indexer outage) must not stop the rest.
      logger.warn({ err, event: s.event }, "chain-events stream tick failed");
    }
  }
}

let timer: NodeJS.Timeout | undefined;

export function startChainEventsEmitter(tickMs = CHAIN_EVENTS_TICK_MS): void {
  if (timer) return;
  const tick = (): void => {
    void chainEventsTick();
  };
  void chainEventsTick();
  timer = setInterval(tick, tickMs);
  timer.unref?.();
  logger.info({ tickMs }, "chain-events emitter started");
}

export function stopChainEventsEmitter(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
