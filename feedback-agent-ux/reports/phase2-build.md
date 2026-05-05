# Phase 2 — Build UX Report

**Stack chosen**: Node.js 20 + ESM, `ethers` v6 (on-chain reads), `express` v4 (log endpoint). No TypeScript transpile to keep deploy simple.

**Why**: The Lumina README is `Express 4 + TypeScript + ethers v6 + SQLite` and every public skill uses TypeScript + viem/ethers. Sticking to the same family kept the schema and address types interchangeable. ESM JS (instead of TS) avoided a build step on Railway — `node src/index.js` boots in <1 s.

---

## Bot architecture (final)

```
src/
├── index.js          ← express server + setInterval scheduler
├── config.js         ← env parsing, ethers wallet, ASSET_USDC = keccak256("USDC")
├── api.js            ← thin typed wrappers around the 8 live endpoints
├── onchain.js        ← ETH + ERC-20 balanceOf reads
├── state.js          ← log ring buffer + pause/disable counters
├── strategies.js     ← Hedger / YieldFarmer / TriggerHunter
├── smoke.js          ← read-only dependency check
└── probe_live.js     ← one-shot real POST /policies attempt (proof of failure)
```

Three independent `setInterval` loops, each wrapped in `safeRun` so one strategy's
exception never kills the others.

---

## What was easy

- **Fetch + JSON.** The API uses standard headers and returns clean JSON with predictable error shapes (`{ "error": "...", "message": "..." }`). Wrapping it in `api.js` was 30 lines.
- **Health endpoint as bootstrap.** `GET /health` gives every contract address the bot needs in one call; `getEth()` and `getUsdc(h.contracts.usdc)` then derive on-chain balances directly. Total bootstrap is 3 fetches.
- **Ethers v6 ergonomics.** `ethers.id('USDC')` for the bytes32 asset, `ethers.JsonRpcProvider` for reads, `new ethers.Contract` for ERC-20 calls — 4 lines total for both balances.
- **Quote endpoint is unauth.** Lets the bot get pricing without spending a key call, useful for both planning and pre-trade sanity checks.

---

## What was hard

1. **Discovering the request schema by error-driven probing.** The skill files said `{ productId, coverageAmount }`. The first POST got `400 validation_error: asset and buyer are Required`. Adding them as `address` strings got `400 asset must be bytes32 hex`. I had to guess that `asset` is a `keccak256` of an asset symbol; tried `keccak256("USDC")` and the API moved past validation. **An agent without the ability to retry-with-new-shapes would be stuck.**
2. **Three contradictory address sources.** Live `/health`, `/docs` "Deployed Contracts" table, and `approve-usdc.md` skill each list different USDC + CoverRouter addresses. The bot had to pick one — chose `/health` based on the on-chain `CoverRouter.usdc()` reading agreeing with it.
3. **Marketplace strategy is not API-implementable.** README hints at `POST /api/v1/marketplace/list` but there is no GET listing endpoint. To "scan listings" the bot would need to subscribe to on-chain `Listed` events — meaningful complexity for a 30-minute strategy. I downgraded the yield-farmer to a logging stub that records the gap.
4. **Trigger strategy is half-documented.** The skill `watch-triggers.md` says to subscribe to `PolicyTriggered`, but the *submission* path (turning a Chainlink price + EIP-712 proof from `/api/v1/oracle/sign-proof` into a `submitTrigger` on-chain tx) is never walked through end-to-end. I downgraded the trigger-hunter to a check-then-log stub.
5. **No idempotency contract.** The README example shows `Idempotency-Key` but the live API didn't reject its absence. Sent it as a UUID anyway out of caution; verified no double-spends in dry-run.
6. **Bonds endpoint is broken.** `GET /api/v1/bonds/:wallet` returns 503 because of an unbounded `eth_getLogs`. The bot still calls it (so the failure is logged and tracked) but doesn't depend on the response.

---

## What I had to figure out by trial-and-error (= doc gaps)

| Gap | Time lost |
|---|---|
| Real schema for POST /policies (asset + buyer) | ~10 min of probing |
| Which USDC address the live router actually uses | ~15 min (read `CoverRouter.usdc()` on-chain) |
| keccak256 derivation for the `asset` field | ~5 min |
| Realising marketplace is not exposed via API | ~15 min |
| Realising bonds endpoint is broken (not a key issue) | ~10 min |
| **Total time lost to doc gaps** | **~55 min on top of the build itself** |

---

## Time-to-each-milestone

| Milestone | Time |
|---|---|
| Connect to API (first 200 from `/health`) | <1 min |
| Make first authenticated call (`/oracle/signer`) | ~3 min (find host + key) |
| Make first **valid** policy purchase request shape | ~30 min (schema discovery) |
| Implement marketplace scan | **N/A** — not implementable via API |
| Implement trigger logic | partial (logs gap; on-chain submitTrigger not wired) |
| Bot loops cleanly in dry-run | ~2 h total |

---

## Tests run

- `npm install --omit=dev` → 78 packages, 0 vulns.
- `npm run smoke` → all live GETs succeed except `/api/v1/bonds/BOT` (503, expected).
- `DRY_RUN=1 PORT=3001 ... node src/index.js` for 35 s with fast ticks → 13 log lines, all skips correctly motivated (low USDC, no policies owned, marketplace gap).
- `node src/probe_live.js` → captures the live `503 relayer_unauthorized` on a real
  POST /api/v1/policies call. Saved to `reports/live-buy-probe.log`.

---

## Engineering verdict

The bot is **production-shaped but blocked**: it would happily buy 9 policies on every 15-minute tick the moment three operational issues are fixed (relayer authorisation, USDC funding on the live token, marketplace+bonds endpoint hardening). The strategies file uses `if (config.dryRun)` to bypass writes — flipping `DRY_RUN=0` is the entire change to go live.
