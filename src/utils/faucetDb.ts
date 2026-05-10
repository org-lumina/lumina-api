import { getDb } from "../db/database";

/**
 * Sprint L — Faucet claim persistence on the existing SQLite DB.
 *
 * Stores one row per successful claim. Used to enforce:
 *   - 1 claim per wallet / 24h
 *   - 1 claim per IP / 24h
 *   - Daily global cap (50 claims / 24h) to bound relayer drain
 *
 * The schema migration is run lazily on first invocation (not in
 * `database.ts:migrate`) so this module is self-contained — re-enabling
 * or deleting the faucet later doesn't touch the central DB schema.
 */

let migrationRan = false;

function ensureFaucetSchema(): void {
  if (migrationRan) return;
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS faucet_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      ip TEXT NOT NULL,
      eth_tx_hash TEXT NOT NULL,
      usdc_tx_hash TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_faucet_wallet ON faucet_claims(wallet, claimed_at);
    CREATE INDEX IF NOT EXISTS idx_faucet_ip ON faucet_claims(ip, claimed_at);
  `);
  migrationRan = true;
}

export interface FaucetClaimRow {
  id: number;
  wallet: string;
  ip: string;
  eth_tx_hash: string;
  usdc_tx_hash: string;
  claimed_at: number;
}

/** Most recent claim by `wallet` (lowercase). `null` if never claimed. */
export function lastClaimByWallet(wallet: string): { claimed_at: number } | null {
  ensureFaucetSchema();
  const d = getDb();
  const row = d
    .prepare("SELECT claimed_at FROM faucet_claims WHERE wallet = ? ORDER BY claimed_at DESC LIMIT 1")
    .get(wallet.toLowerCase()) as { claimed_at: number } | undefined;
  return row ?? null;
}

/** Most recent claim from `ip`. `null` if never claimed. */
export function lastClaimByIp(ip: string): { claimed_at: number } | null {
  ensureFaucetSchema();
  const d = getDb();
  const row = d
    .prepare("SELECT claimed_at FROM faucet_claims WHERE ip = ? ORDER BY claimed_at DESC LIMIT 1")
    .get(ip) as { claimed_at: number } | undefined;
  return row ?? null;
}

/** Count of claims in the last 24h across all wallets/IPs. Used for the daily cap. */
export function countClaimsLast24h(): number {
  ensureFaucetSchema();
  const d = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const row = d
    .prepare("SELECT COUNT(*) AS n FROM faucet_claims WHERE claimed_at >= ?")
    .get(cutoff) as { n: number };
  return row.n;
}

/** Persist a successful claim. Wallet stored lowercase for case-insensitive lookups. */
export function insertClaim(input: {
  wallet: string;
  ip: string;
  ethTxHash: string;
  usdcTxHash: string;
}): FaucetClaimRow {
  ensureFaucetSchema();
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  return d
    .prepare(
      `INSERT INTO faucet_claims (wallet, ip, eth_tx_hash, usdc_tx_hash, claimed_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      input.wallet.toLowerCase(),
      input.ip,
      input.ethTxHash.toLowerCase(),
      input.usdcTxHash.toLowerCase(),
      now
    ) as FaucetClaimRow;
}
