import Database from "better-sqlite3";
import { loadConfig } from "../utils/config";
import { logger } from "../utils/logger";

const cfg = loadConfig();

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(cfg.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
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

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
