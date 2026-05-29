# Lumina Indexer (Ponder)

Sprint J — skeleton scope. Sub-package inside `lumina-api/` that runs Ponder against the Lumina protocol contracts on Base mainnet. Ships **alongside** the API on the same Railway service. See [`tracking/architectural-decisions.md` ADR-008](https://github.com/org-lumina/lumina-testnet-tracker/blob/main/tracking/architectural-decisions.md) for the "same repo" decision and the migration plan to a separate `lumina-indexer` service when traffic justifies it.

## Status

- **Skeleton ready** (Sprint J): config + schema + 4 of 5 handlers (FounderVesting awaits ABI drop). NO `npm install` ran from CI/Claude — founder runs it locally before the first deploy.
- **API endpoints** that consume the indexer's Postgres are stubbed in `src/routes/indexer.ts` (parent repo). Hardening tasks are listed as new checklist items in `lumina-testnet-tracker` post-Sprint J.

## Local dev

Prereqs: Node 20+, Postgres 16+ (or Docker), the contract ABIs in `../abis/`.

```bash
cd indexer
npm install
cp .env.example .env
# edit .env with QuickNode endpoint + Postgres DATABASE_URL + DEPLOYMENT_BLOCK_CLAIMBOND
npm run dev
```

Healthcheck: `http://localhost:42069/_ponder/status` once `ponder dev` is running.

## Wired events (Sprint J skeleton)

| # | Contract | Event | Table |
|---|---|---|---|
| 1 | CoverRouterV2 | `PolicyPurchased` | `policy` |
| 2a | BondVault | `BondIssued` | `bond` (insert) |
| 2b | BondVault | `BondRedeemed` | `bond` (insert with `redeemed=true`) |
| 3 | TWAPBurner | `BurnExecuted` | `burn` |
| 4 | CoverRouterV2 | `TriggerSubmitted` | `trigger` |
| 5 | FounderVesting | `TrancheReleased` | _stubbed (ABI pending)_ |

## Pending implementation work (post-skeleton)

Tracked as items in `checklists/01-infraestructura.md` of the tracker repo:

- Drop `abis/FounderVesting.json` into the parent `abis/` directory + enable the FounderVesting handler.
- Replace the `(event.args as any)` casts with the strict types Ponder generates after `npm run codegen`.
- Add bond-redemption JOIN logic (current skeleton inserts a redeem row instead of updating the matching issuance row — needs a migration to `update()`).
- Add API endpoints in `src/routes/indexer.ts` (parent) querying the Ponder Postgres: `/api/v1/stats/total-policies`, `/api/v1/policies/by-buyer/:address`, `/api/v1/burns/recent`, `/api/v1/vesting/founder/claims`, etc.
- Wire the `DATABASE_URL` for indexer-postgres in Railway (different DB than the API's SQLite).
- Add concurrent process management to `railway.toml` so the API and the indexer both run.
- Indexer healthcheck endpoint surfaced under the API at `/api/v1/indexer/health` returning `{ lag_blocks, last_synced_block }`.

## Why Ponder (vs The Graph / Goldsky)

- TypeScript-native; reuses ABIs from foundry's `out/` without a separate subgraph manifest.
- Self-hosted on Railway; no per-query fees.
- Postgres native — joins with the existing API DB feasible without ETL.
- Fast cold-start from a known `startBlock` (vs The Graph requiring full sync from genesis).

## Why same repo (Sprint J)

- < 50 active agents on Base mainnet today → operational simplicity > scaling headroom.
- Single Railway service / single deploy / single env-vars surface.
- Migration to a dedicated `lumina-indexer` repo is a one-day task (see ADR-008 plan) once traffic justifies the split.
