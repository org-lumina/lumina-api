# lumina-agent-bot

Autonomous bot that exercises the Lumina Protocol API as a third-party AI agent. Built from public sources (homepage, /docs, /skills, github.com/org-lumina) plus probing the live API.

## Strategies (per the brief)

| # | Name | Cadence | What it does |
|---|---|---|---|
| 1 | Hedger | every 15 min | Holds 1 active policy on each of the 9 products; buys $50 cover where missing. |
| 2 | Yield farmer | every 30 min | Scans the marketplace for discounted bonds. **Currently no-op** — the API has no `GET /marketplace/listings`; on-chain `Listed`-event scan is required. Logged as a gap. |
| 3 | Trigger hunter | every 5 min | Inspects own active policies; would call `submitTrigger` on-chain. **Currently logs only** — the on-chain `submitTrigger` flow + oracle proof is undocumented end-to-end. |

## Safety rails

- USDC < $1000 → halt buying, log "low balance"
- ETH < 0.01 → halt buying, log "needs gas refund"
- 3 consecutive errors → pause 1 hour
- 5 buy failures on a single shield → disable that shield for 24 h

## Run locally

```bash
npm install
cp .env.example .env  # fill BOT_PRIVATE_KEY + LUMINA_API_KEY
npm run smoke         # read-only dependency check
npm run dry           # full loop, no writes (DRY_RUN=1)
npm start             # full loop, real API calls
curl http://localhost:3000/agent-bot/log
```

## Live blockers observed during this stress-test (2026-05-05)

1. **Relayer unauthorized on-chain.** `POST /api/v1/policies` returns
   `503 relayer_unauthorized: Relayer 0x168dC7... is not authorized in CoverRouter`.
   No purchase can succeed until ops calls `setRelayer(0x168dC7..., true)`.
2. **Bot was funded on the wrong USDC.** `/health` says USDC=`0xD944…3Ab6AE`, but the
   bot wallet holds $10,000 on `0x63D340…3693` (the address shown by the stale
   `approve-usdc.md` skill). Even if the relayer is authorised, the API would
   try to pull premium from the wallet's $0 balance on the live USDC.
3. **`GET /api/v1/bonds/:wallet` returns 503** because the handler does
   `eth_getLogs` from block 0 and exceeds the public RPC's 50 000-block range.

The bot is structured so that, the moment those blockers are cleared, lifting
`DRY_RUN=0` makes the Hedger loop go live without a redeploy.

## Files

```
bot/
├── package.json
├── Dockerfile
├── railway.json
├── .env.example
└── src/
    ├── index.js          ← express server + scheduler
    ├── config.js         ← env, wallet, ASSET_USDC = keccak256("USDC")
    ├── api.js            ← typed wrappers around the 8 live endpoints
    ├── onchain.js        ← ETH + ERC-20 balanceOf reads via ethers
    ├── state.js          ← log ring buffer + safety-rail counters
    ├── strategies.js     ← Hedger / YieldFarmer / TriggerHunter
    └── smoke.js          ← read-only dependency check
```
