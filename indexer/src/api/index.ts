import { Hono } from "hono";
import { client, graphql } from "ponder";
import { db } from "ponder:api";
import schema from "ponder:schema";

/**
 * Ponder 0.16 requires an API entrypoint at `src/api/index.ts` — without it
 * the indexer aborts on boot with `BuildError: API endpoint file not found`,
 * which is why the process started but never indexed (DB stayed empty,
 * /indexer/health stuck at lastSyncedBlock=0). This file satisfies that
 * requirement and exposes the indexed data read-only.
 *
 * The lumina-api Express server is the public surface; this Hono app runs on
 * Ponder's own port and is used internally / for debugging.
 */
const app = new Hono();

// Liveness for Ponder's HTTP server.
app.get("/", (c) => c.json({ status: "ok", service: "lumina-ponder-indexer" }));

// Standard Ponder read-only surfaces over the indexed tables.
app.use("/sql/*", client({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

export default app;
