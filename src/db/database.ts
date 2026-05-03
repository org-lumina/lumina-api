import Database from "better-sqlite3";
import { loadConfig } from "../utils/config";
import { logger } from "../utils/logger";

const cfg = loadConfig();

let db: Database.Database | undefined;

/**
 * [Audit #36 IDEM-TTL] Idempotency rows are kept for this many milliseconds.
 * Anything older is pruned on boot (and on demand via `sweepIdempotency`).
 * Seven days matches the typical retry window of upstream agent runners while
 * keeping the on-disk footprint bounded.
 */
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(cfg.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  // [Audit #36 IDEM-TTL] One-shot boot-time sweep. Long-running deploys
  // accumulate idempotency rows forever otherwise; with a Volume mounted on
  // Railway this would slowly bloat the disk. The sweep runs after migrate()
  // so the table is guaranteed to exist.
  sweepIdempotency(db);
  return db;
}

/**
 * Delete idempotency rows older than `IDEMPOTENCY_TTL_MS` ms.
 * Returns the number of rows removed. Safe to call multiple times.
 */
export function sweepIdempotency(database?: Database.Database): number {
  const d = database ?? getDb();
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  const result = d.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff);
  if (result.changes > 0) {
    logger.info({ deleted: result.changes, cutoff }, "Cleaned up old idempotency rows");
  }
  return result.changes;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      revoked_at INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      policy_id INTEGER NOT NULL,
      buyer TEXT NOT NULL,
      coverage_amount TEXT NOT NULL,
      premium_paid TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      submitted_by INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(product_id, policy_id),
      FOREIGN KEY (submitted_by) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_policies_buyer ON policies(buyer);
    CREATE INDEX IF NOT EXISTS idx_policies_submitted ON policies(submitted_by);

    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    -- Marketplace listings (populated by A.1.5 /marketplace/list; required as
    -- a pre-check for /marketplace/buy verification).
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id TEXT NOT NULL UNIQUE,
      seller_address TEXT NOT NULL,
      bond_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      total_price_usdc TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      block_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      submitted_by INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (submitted_by) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_address);
    CREATE INDEX IF NOT EXISTS idx_listings_bond ON listings(bond_id);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id TEXT NOT NULL,
      buyer_address TEXT NOT NULL,
      seller_address TEXT NOT NULL,
      bond_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      total_paid_usdc TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      block_number INTEGER NOT NULL,
      executed_at INTEGER,
      submitted_by INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (submitted_by) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_buyer ON purchases(buyer_address);
    CREATE INDEX IF NOT EXISTS idx_purchases_seller ON purchases(seller_address);
    CREATE INDEX IF NOT EXISTS idx_purchases_listing ON purchases(listing_id);
  `);
  logger.debug("DB migrated");
}

// Agents
export interface Agent {
  id: number;
  wallet: string;
  tier: "free" | "paid";
  created_at: number;
}

export function findOrCreateAgent(wallet: string): Agent {
  const d = getDb();
  const w = wallet.toLowerCase();
  const existing = d.prepare("SELECT * FROM agents WHERE wallet = ?").get(w) as Agent | undefined;
  if (existing) return existing;
  const result = d
    .prepare("INSERT INTO agents (wallet) VALUES (?) RETURNING *")
    .get(w) as Agent;
  return result;
}

// API keys
export const MAX_KEYS_PER_WALLET = 3;

export interface ApiKeyRecord {
  id: number;
  agent_id: number;
  key_hash: string;
  label: string | null;
  created_at: number;
  revoked_at: number | null;
}

export function countActiveKeys(agentId: number): number {
  const d = getDb();
  const row = d
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE agent_id = ? AND revoked_at IS NULL")
    .get(agentId) as { n: number };
  return row.n;
}

export function insertApiKey(agentId: number, keyHash: string, label: string | null): ApiKeyRecord {
  const d = getDb();
  return d
    .prepare("INSERT INTO api_keys (agent_id, key_hash, label) VALUES (?, ?, ?) RETURNING *")
    .get(agentId, keyHash, label) as ApiKeyRecord;
}

export function findActiveKeyByHash(keyHash: string): (ApiKeyRecord & { wallet: string; tier: string }) | undefined {
  const d = getDb();
  return d
    .prepare(
      `SELECT k.*, a.wallet AS wallet, a.tier AS tier
         FROM api_keys k
         JOIN agents a ON a.id = k.agent_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL`
    )
    .get(keyHash) as (ApiKeyRecord & { wallet: string; tier: string }) | undefined;
}

export function revokeKey(keyId: number): boolean {
  const d = getDb();
  const result = d
    .prepare("UPDATE api_keys SET revoked_at = strftime('%s','now') * 1000 WHERE id = ? AND revoked_at IS NULL")
    .run(keyId);
  return result.changes > 0;
}

// Policies
export interface PolicyRow {
  id: number;
  product_id: string;
  policy_id: number;
  buyer: string;
  coverage_amount: string;
  premium_paid: string;
  tx_hash: string;
  submitted_by: number | null;
  created_at: number;
}

export function recordPolicy(input: Omit<PolicyRow, "id" | "created_at">): PolicyRow {
  const d = getDb();
  return d
    .prepare(
      `INSERT INTO policies (product_id, policy_id, buyer, coverage_amount, premium_paid, tx_hash, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      input.product_id,
      input.policy_id,
      input.buyer.toLowerCase(),
      input.coverage_amount,
      input.premium_paid,
      input.tx_hash,
      input.submitted_by
    ) as PolicyRow;
}

export function listPoliciesByOwner(buyer: string): PolicyRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM policies WHERE buyer = ? ORDER BY id DESC")
    .all(buyer.toLowerCase()) as PolicyRow[];
}

// Idempotency
export function findIdempotency(key: string, agentId: number): string | undefined {
  const d = getDb();
  const row = d
    .prepare("SELECT response_json FROM idempotency WHERE key = ? AND agent_id = ?")
    .get(key, agentId) as { response_json: string } | undefined;
  return row?.response_json;
}

export function saveIdempotency(key: string, agentId: number, responseJson: string): void {
  const d = getDb();
  d.prepare(
    "INSERT OR IGNORE INTO idempotency (key, agent_id, response_json) VALUES (?, ?, ?)"
  ).run(key, agentId, responseJson);
}

// Marketplace listings (read-only here; populated by A.1.5)
export interface ListingRow {
  id: number;
  listing_id: string;
  seller_address: string;
  bond_id: string;
  amount: string;
  total_price_usdc: string;
  tx_hash: string;
  block_number: number;
  status: string;
  submitted_by: number | null;
  created_at: number;
}

export function getListingByListingId(listingId: string): ListingRow | undefined {
  const d = getDb();
  return d
    .prepare("SELECT * FROM listings WHERE listing_id = ?")
    .get(listingId) as ListingRow | undefined;
}

// Marketplace purchases (POST /api/v1/marketplace/buy)
export interface PurchaseRow {
  id: number;
  listing_id: string;
  buyer_address: string;
  seller_address: string;
  bond_id: string;
  amount: string;
  total_paid_usdc: string;
  tx_hash: string;
  block_number: number;
  executed_at: number | null;
  submitted_by: number | null;
  created_at: number;
}

/**
 * Atomically: insert the purchase row AND mark the parent listing's
 * `status` = 'executed'. Both happen in one SQLite transaction so a
 * failure on either side rolls the other back — prevents the case
 * where a duplicate purchase row would land on an already-finalized
 * listing.
 */
export function recordPurchaseAndFinalizeListing(
  input: Omit<PurchaseRow, "id" | "created_at">
): PurchaseRow {
  const d = getDb();
  const insertPurchase = d.prepare(
    `INSERT INTO purchases (listing_id, buyer_address, seller_address, bond_id, amount, total_paid_usdc, tx_hash, block_number, executed_at, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  );
  const updateListing = d.prepare(
    `UPDATE listings SET status = 'executed' WHERE listing_id = ? AND status = 'active'`
  );

  const tx = d.transaction((args: Omit<PurchaseRow, "id" | "created_at">) => {
    const row = insertPurchase.get(
      args.listing_id,
      args.buyer_address.toLowerCase(),
      args.seller_address.toLowerCase(),
      args.bond_id,
      args.amount,
      args.total_paid_usdc,
      args.tx_hash.toLowerCase(),
      args.block_number,
      args.executed_at,
      args.submitted_by
    ) as PurchaseRow;

    const updated = updateListing.run(args.listing_id);
    if (updated.changes === 0) {
      // Listing was already finalized between our pre-check and this UPDATE.
      // Roll the transaction back via a thrown error — the caller maps it
      // to 409 listing_not_active.
      throw Object.assign(new Error("listing_not_active"), { code: "LISTING_RACE" });
    }
    return row;
  });
  return tx(input);
}

export function getPurchaseByTxHash(txHash: string): PurchaseRow | undefined {
  const d = getDb();
  return d
    .prepare("SELECT * FROM purchases WHERE tx_hash = ?")
    .get(txHash.toLowerCase()) as PurchaseRow | undefined;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
