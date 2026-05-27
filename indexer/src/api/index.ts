import { Hono } from "hono";

/**
 * Ponder 0.16 requires an API entrypoint at `src/api/index.ts` or the indexer
 * aborts on boot (`BuildError: API endpoint file not found`).
 *
 * Kept to the ABSOLUTE MINIMUM on purpose: importing Ponder's `client`/`graphql`
 * helpers + `ponder:api`/`ponder:schema` here passed local tsc/codegen but
 * failed Ponder's runtime build (`Build failed stage=api` → SIGTERM on Railway).
 * A bare Hono app with a liveness route satisfies the requirement and cannot
 * break the build. The public data surface is the lumina-api Express server
 * (/api/v1/...), which reads the same Postgres — this Hono app only needs to
 * exist + serve a health check on Ponder's own port.
 */
const app = new Hono();

app.get("/", (c) => c.json({ ok: true, service: "lumina-ponder-indexer" }));

export default app;
