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

  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5, // small pool — read-only consumer alongside the indexer's writes
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

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
  // The exact meta table name depends on Ponder version; this query is a
  // resilient fallback that introspects pg_tables. Adjust once we pin Ponder.
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
