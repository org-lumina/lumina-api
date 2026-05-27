# Ponder Indexer — Setup & Runbook

The indexer reconstructs protocol state from on-chain events into Postgres so
the API serves reads from a DB (≈ms) instead of live `eth_getLogs` scans
(0.8–2.2s, flaky under load). It runs **alongside** `lumina-api` on the same
Railway service.

## Architecture
```
Base Sepolia ──events──▶ Ponder (indexer/) ──writes──▶ Postgres ◀──reads── lumina-api (/api/v1/...)
```
- `indexer/ponder.config.ts` — chains + 6 contracts (addresses from env).
- `indexer/ponder.schema.ts` — 6 tables (policy, trigger, bond, burn, marketplace_listing, vesting_claim).
- `indexer/src/index.ts` — event handlers (verified against ./abis via `ponder codegen` + tsc).
- `src/routes/indexer.ts` — read endpoints (each catches DB errors → clean 5xx, never crashes the API).
- Legacy on-chain `/api/v1/public/*` endpoints are untouched and keep serving during/after migration.

## First-time setup (FOUNDER — requires Railway access)
1. **Create Postgres** — Railway dashboard → the lumina-api project → New → Database → PostgreSQL.
2. **Set service env vars** on the lumina-api service (Variables tab). Copy from `indexer/.env.example`:
   - `DATABASE_URL` (Railway injects the Postgres URL — reference it, never paste a literal in code)
   - `RPC_URL_QUICKNODE` (preferred) and/or `RPC_URL` (Alchemy)
   - `COVER_ROUTER`, `CLAIM_BOND`, `BOND_VAULT`, `TWAP_BURNER`, `MARKETPLACE`, (optional `FOUNDER_VESTING`)
   - `DEPLOYMENT_BLOCK_CLAIMBOND=41680286`
3. **Run both processes** — the repo's `npm run concurrent` runs `api` + `indexer` together
   (`concurrently`). Ensure the Railway start command / Dockerfile uses it (or run the indexer
   as a second Railway service pointed at the same DB).
4. **Backfill** — on first boot Ponder backfills from `DEPLOYMENT_BLOCK_CLAIMBOND` to head, then
   tails live. Backfill time depends on RPC quality (archive endpoint ≪ public).
5. **Verify** — `GET /api/v1/indexer/health` → `{status:"synced", lagBlocks:"<n>"}`.

## Validate locally (no Railway)
```bash
cd indexer
npm install
npx ponder codegen      # regenerates ponder-env.d.ts from the ABIs
npx tsc -p tsconfig.json --noEmit   # typechecks handlers against real ABI types
# Full local run needs a Postgres (or `ponder dev` with a local PG) + RPC.
```

## Restore if the indexer goes down
- **API stays up.** Indexer endpoints return a clean 5xx; the legacy on-chain
  `/api/v1/public/*` endpoints keep working, so the frontend degrades, not dies.
- Restart the indexer process (Railway → Deployments → Restart). Ponder resumes
  from its last-synced block in Postgres — no full re-backfill.
- If the DB is lost/corrupt: drop the Ponder schema and restart; it re-backfills
  from `DEPLOYMENT_BLOCK_CLAIMBOND`. Idempotent — safe to re-run.
- Reorgs: Ponder handles Base Sepolia reorgs natively (reverts affected rows).

## Cost
A Railway Postgres starter plugin is ~$5/mo (Hobby) and shares the existing
service's compute. No new service required if run via `npm run concurrent`.
