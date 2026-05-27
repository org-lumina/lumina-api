import { Pool } from "pg";
import { logger } from "./logger";

/**
 * Postgres connection pool for the Ponder indexer DB.
 *
 * The indexer (running in `indexer/` as a separate process via
 * `npm run concurrent`) writes to a Postgres instance attached to the
 * Railway service via `DATABASE_URL`. The API reads from the same Postgres
 * — read-only by convention; we never mutate Ponder's tables from here.
 *
 * Sprint K — Item #8/#9/#10 follow-up.
 */

const DATABASE_URL = process.env.DATABASE_URL;

let pool: Pool | undefined;

/** Lazy-init: tests can run without DATABASE_URL set. */
export function getIndexerPool(): Pool {
  if (pool) return pool;

  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. The indexer endpoints require a Postgres URL " +
        "(Railway plugin attaches it automatically; locally copy from indexer/.env.example)."
    );
  }

  // [schema-align fix] Ponder writes its tables to the schema named by
  // DATABASE_SCHEMA (`--schema` env), NOT necessarily `public`. When that is set
  // (e.g. `ponder_v1`, used to dodge the "schema previously used by a different
  // Ponder app" MigrationError), our unqualified reads (`FROM policy`) resolve
  // against `public` and only see STALE rows from an older run — the indexer
  // looks "stuck at N" while it actually indexes fine into the other schema.
  // Point the connection's search_path at the SAME schema the indexer writes to
  // (then public as fallback), so reader and writer are always aligned.
  // Identifier-validated to stay injection-safe (search_path can't be a param).
  const rawSchema = process.env.DATABASE_SCHEMA?.trim();
  const schema = rawSchema && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawSchema) ? rawSchema : "public";

  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5, // small pool — read-only consumer alongside the indexer's writes
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Resolve unqualified table names against the indexer's schema first.
    options: `-c search_path=${schema},public`,
  });
  logger.info({ schema }, "[indexerDb] pool search_path set to indexer schema");

  pool.on("error", (err) => {
    logger.error({ err }, "[indexerDb] unexpected pool error");
  });

  return pool;
}

/** Graceful shutdown — wired in src/server.ts shutdown handler. */
export async function closeIndexerPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Run a typed query. Caller provides the result row shape. Errors bubble
 * unchanged — route handlers wrap with HttpError as appropriate.
 */
export async function query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = getIndexerPool();
  const result = await client.query<T extends object ? T : Record<string, unknown>>(sql, params);
  return result.rows as T[];
}

/**
 * Indexer health: returns the latest synced block + lag relative to the
 * configured RPC head. Used by `/api/v1/indexer/health`.
 *
 * Ponder writes its sync state to a meta table (`_ponder_meta`) by default;
 * we read the `last_block_number` from there. If Ponder isn't running the
 * query throws and the route returns 503.
 */
export async function getIndexerSyncState(): Promise<{ lastSyncedBlock: bigint }> {
  // Prefer Ponder's REAL sync cursor from `_ponder_checkpoint`. It reflects the
  // block Ponder has actually indexed up to, regardless of whether recent blocks
  // had events — so health stops falsely reporting "lagging" when the latest
  // blocks are simply event-less. The checkpoint is a fixed-width encoded string:
  // blockTimestamp(10) + chainId(16) + blockNumber(16) + ... → block number is
  // the 16 digits at offset 26.
  try {
    const cp = await query<{ latest_checkpoint: string }>(
      `SELECT latest_checkpoint FROM _ponder_checkpoint ORDER BY chain_id LIMIT 1`
    );
    const raw = cp[0]?.latest_checkpoint;
    if (raw && raw.length >= 42) {
      const blockNumber = BigInt(raw.slice(26, 42));
      if (blockNumber > 0n) return { lastSyncedBlock: blockNumber };
    }
  } catch {
    // _ponder_checkpoint absent/renamed across Ponder versions — fall back below.
  }
  // Fallback: MAX(block_number) over the event tables (only advances on events).
  const rows = await query<{ block_number: string }>(
    `SELECT MAX(block_number)::text AS block_number FROM (
       SELECT block_number FROM policy
       UNION ALL
       SELECT block_number FROM burn
       UNION ALL
       SELECT block_number FROM trigger
     ) AS combined;`
  );
  const lastSyncedBlock = rows[0]?.block_number ? BigInt(rows[0].block_number) : 0n;
  return { lastSyncedBlock };
}
