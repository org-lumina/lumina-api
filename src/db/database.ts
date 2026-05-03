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

    CREATE TABLE IF NOT EXISTS redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch_id TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      usd_amount TEXT NOT NULL,
      lumina_received TEXT NOT NULL,
      price_used TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      submitted_by INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (submitted_by) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_redemptions_owner ON redemptions(owner_address);
    CREATE INDEX IF NOT EXISTS idx_redemptions_epoch ON redemptions(epoch_id);

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

// Redemptions (POST /api/v1/redeem — verifier pattern)
export interface RedemptionRow {
  id: number;
  epoch_id: string;
  owner_address: string;
  tx_hash: string;
  usd_amount: string;
  lumina_received: string;
  price_used: string;
  block_number: number;
  submitted_by: number | null;
  created_at: number;
}

export function recordRedemption(input: Omit<RedemptionRow, "id" | "created_at">): RedemptionRow {
  const d = getDb();
  return d
    .prepare(
      `INSERT INTO redemptions (epoch_id, owner_address, tx_hash, usd_amount, lumina_received, price_used, block_number, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      input.epoch_id,
      input.owner_address.toLowerCase(),
      input.tx_hash.toLowerCase(),
      input.usd_amount,
      input.lumina_received,
      input.price_used,
      input.block_number,
      input.submitted_by
    ) as RedemptionRow;
}

export function getRedemptionByTxHash(txHash: string): RedemptionRow | undefined {
  const d = getDb();
  return d
    .prepare("SELECT * FROM redemptions WHERE tx_hash = ?")
    .get(txHash.toLowerCase()) as RedemptionRow | undefined;
}

// Listings (POST /api/v1/marketplace/list — verifier pattern)
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

export function recordListing(input: Omit<ListingRow, "id" | "status" | "created_at"> & { status?: string }): ListingRow {
  const d = getDb();
  return d
    .prepare(
      `INSERT INTO listings (listing_id, seller_address, bond_id, amount, total_price_usdc, tx_hash, block_number, status, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      input.listing_id,
      input.seller_address.toLowerCase(),
      input.bond_id,
      input.amount,
      input.total_price_usdc,
      input.tx_hash.toLowerCase(),
      input.block_number,
      input.status ?? "active",
      input.submitted_by
    ) as ListingRow;
}

export function getListingByTxHash(txHash: string): ListingRow | undefined {
  const d = getDb();
  return d
    .prepare("SELECT * FROM listings WHERE tx_hash = ?")
    .get(txHash.toLowerCase()) as ListingRow | undefined;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
