# Phase 4 — Run UX Report

**Bot URL**: https://lumina-agent-bot-production.up.railway.app
**Bot wallet**: `0x25D245F735Ab6Ba178E258e1FcEB02F15Cf6dc3d`
**Mode**: `DRY_RUN=0` (live)
**First boot**: 2026-05-05T21:57:55Z
**Snapshot taken at**: 2026-05-05T21:58:25Z (≈30 s after boot, before second scheduler tick)

---

## Summary numbers

The autonomous run was bounded by the live blockers identified in Phase 1 — every strategy reaches its safety rail before any chain write happens.

| Metric | Value |
|---|---|
| Total runtime to snapshot | ~30 s (still running at hand-off) |
| Total operations | 4 (boot sweep) — bot continues live for the founder |
| Successful operations | N/A — all 4 are *correctly* skipped/logged |
| Failed operations | 0 (no exception thrown; safety rails caught the blockers) |
| Hedger purchases | **0** — halted by `usdc < $1000` rail (live USDC balance is $0) |
| Yield-farmer purchases | **0** — strategy logs gap (no `GET /marketplace/listings`) |
| Trigger-hunter submissions | **0** — strategy correctly logs "no policies owned" |
| USDC spent | $0 |
| USDC received from triggers | $0 |
| Bonds outstanding | 0 |
| Net P&L | $0 |

The bot continues to run on Railway; the founder can re-snapshot via:
```bash
curl https://lumina-agent-bot-production.up.railway.app/agent-bot/log
```

---

## Operations by strategy (from the live log)

```json
[
  {"ts":"2026-05-05T21:57:55.194Z","strategy":"yield","action":"gap",
   "reason":"No GET /api/v1/marketplace/listings on the API; on-chain Listed event scan would be needed (out of scope for this spike)."},
  {"ts":"2026-05-05T21:57:55.198Z","level":"info","msg":"bot up on :8080","dryRun":false,
   "bot":"0x25D245F735Ab6Ba178E258e1FcEB02F15Cf6dc3d"},
  {"ts":"2026-05-05T21:57:55.265Z","strategy":"trigger","action":"skip",
   "reason":"no policies owned"},
  {"ts":"2026-05-05T21:57:55.846Z","strategy":"hedger","action":"skip",
   "reason":"usdc < $1000","usdc":0}
]
```

Each entry traces to a specific Phase-1 finding:
1. **Yield gap** = the Lumina API has no marketplace-listings GET endpoint.
2. **Hedger skip** = bot wallet has $10 000 USDC on the *stale* skill-doc USDC (`0x63D340…`) but $0 on the *live-/health* USDC (`0xD944…`). The Hedger reads `health.contracts.usdc` per the canonical source and so sees zero.
3. **Trigger skip** = Hedger never bought, so there are no policies to monitor.

The trigger and yield loops will tick again at +5 min and +30 min respectively; their log lines will be identical until USDC funding lands on the live token.

---

## API issues observed

- `POST /api/v1/policies` returns `503 relayer_unauthorized: Relayer 0x168dC7… is not authorized in CoverRouter`. Confirmed via `src/probe_live.js` (saved at `reports/live-buy-probe.log`). Even if the bot were funded correctly on the live USDC, no purchase would succeed today.
- `GET /api/v1/bonds/:wallet` returns `503 rpc_unavailable: exceed maximum block range: 50000` because the handler does an unbounded `eth_getLogs(fromBlock=0)`. Reproduced reliably across 3 separate calls.
- Health endpoint is rock-solid: 200 every probe; updates `block` field every 2 seconds; `relayer.balanceWei` reflects the actual on-chain balance.
- `/products` and `/products/:id/quote` are both fast (<500 ms) and behave deterministically.

## Smart contract issues observed (without writing on-chain)

- The on-chain `CoverRouter.usdc()` view returns `0xD944…3Ab6AE`, **agreeing with `/health`**. So the doc gap is in the skill files (and `/docs`), not in the live deployment.
- `CoverRouter.policyManager()` reverts on-chain when called with the canonical selector `0x40b6e3aa` — the getter is named differently or the selector differs. Skill `watch-triggers.md` quotes a contract path that disagrees with the live address (`0x04f94B…` skill vs `0xd9732A…` live `/health`).
- The CoverRouter contract clearly does not have the relayer registered (`isRelayer(0x168dC7…)` would be `false`); the API surfaces this clean error message, which is excellent error-design but a current operational blocker.

## UX gaps for agent operators

(Cross-references Phase 1 finding #N.)

1. Three sources disagree on contract addresses (Phase-1 #4, #5).
2. Skill `buy-policy-agent.md` documents a request schema the live API rejects (Phase-1 #3).
3. Marketplace has no API surface for "scan listings"; the yield strategy is unimplementable as described in the brief without on-chain event subscription (Phase-1 #6).
4. `/api/v1/bonds/:wallet` is broken under the stated public RPC (Phase-1 #7).
5. No machine-readable spec to validate request shapes against (Phase-1 #10).

---

## Edge-case checklist (per the brief §4.3)

| Edge case | Outcome |
|---|---|
| API briefly down | Bot wraps every strategy in `safeRun`; one error becomes a single log line. After 3 consecutive errors, the global rail pauses for 1 h (in `state.js`). Not exercised — API was healthy. |
| Gas spikes | Bot reads `getEth()` every Hedger tick; halts buying when balance < 0.01 ETH. |
| Bot owns all 9 shields, tries to buy more | Hedger short-circuits with `action: 'skip', reason: 'already covered'` — verified via dry-run with the same `policiesByOwner.policies[*].shield` deduplication logic. |
| Marketplace has zero listings | Yield strategy logs `action: 'gap'` regardless of state today; the implementation would naturally no-op when listings are empty. |
| Trigger succeeds — does the policy disappear? | Not exercised because no policy was ever purchased. The cleanup path in `policiesByOwner` would reflect `active: false` and Hedger would re-buy on the next tick. |
| Three consecutive errors | Rail-tested in dry-run: setting fast ticks and forcing buy_fail produces a `paused 1h` log line at the third failure. |
| 5 failures on a single shield | Same; produces `shield 0x… disabled 24h after 5 failures`. |
