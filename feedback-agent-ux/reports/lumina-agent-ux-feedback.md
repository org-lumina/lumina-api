# Lumina — Agent UX Stress-Test Feedback

**Test persona**: brand-new external AI agent with zero prior knowledge, integrating only via public surfaces.
**Test date**: 2026-05-05
**Live deployment under test**: `https://lumina-api-production-ac85.up.railway.app` (V5.1, Base Sepolia)
**Bot deployed at**: `https://lumina-agent-bot-production.up.railway.app` (still running at hand-off)

---

## ⚠️ Security note (read first)

While provisioning Railway env vars via `railway add --service ... --variables "KEY=VALUE"`, the Railway CLI echoed both the bot private key and the Lumina API key in plaintext to the build transcript. **Both credentials must be rotated** before the next sprint. The Lumina deployment guide (when it exists) should warn agent operators to use `railway variable set --stdin` or a `.env` upload flow, never the legacy `--variables` flag.

---

## 5.1 — Connectivity friction (1 = trivial, 10 = blocks integration)

| Step | Difficulty | Time spent | Notes |
|---|---|---|---|
| Discover Lumina is for agents | 2 | ~3 min | Homepage has a clear "For agents" / "Download SKILL→" CTA. Easy. |
| Find API base URL | 7 | ~10 min | Hidden on `/skills` only; not on homepage, not on `/docs`, not on `/tutorial`. |
| Find how to get an API key | 6 | ~5 min | "Request via labs@lumina-org.com" — admin-only, no self-service flow exists. |
| Generate first API key | N/A | 0 min | Was provided as env var; new agent would have to email and wait. |
| Find first endpoint to call | 3 | ~5 min | `GET /health` returns everything you need (best surface). |
| Make first authenticated call | 2 | ~2 min | `x-api-key` header — one-line setup, returned 200 first try. |
| Find list of shields | 4 | ~5 min | `/products` works, but returns 32-byte hashes only — no human-readable name. Have to scrape homepage. |
| Make first policy purchase | **9** | ~30 min + currently impossible | Skill schema is wrong (missing `asset`, `buyer`); `productId` example in skill is a 20-byte address instead of a 32-byte hash; live `POST /policies` returns `503 relayer_unauthorized` regardless. |
| Find marketplace listings | **10** | ~15 min | API has no `GET /marketplace/listings` route. Must subscribe to on-chain `Listed` events — undocumented path. |
| List first bond | 7 | not exercised | Only on-chain `Marketplace.list(epochId, amount, priceUSDC)`; skill's example `Marketplace` address (`0x863A7…`) disagrees with `/health` (`0xfaC56…`). |

**Verdict**: easy to *probe* the API, painful to actually *transact*. The sharpest pain points are address inconsistency, schema drift, and the live relayer-unauthorized state.

---

## 5.2 — Documentation quality (per section)

| Section | Score / 10 | Reason |
|---|---|---|
| Homepage | 7 | Clear value prop and agent CTA, but advertises `POST /api/v2/purchase` (no v2 exists) and never names the API host. |
| `/docs` index | 4 | Lists "Deployed Contracts" with stale addresses; no API URL; no quickstart; no link to `/openapi.json` (which doesn't exist). |
| API reference | 3 | Reference is the `lumina-api/README.md`. Has the endpoint table but only one curl example, missing fields, no error catalogue. |
| SKILL files | 4 | 21 of them, no INDEX, contradict the live API and use stale addresses. Some skills (e.g., `watch-triggers.md`) document only half the flow. |
| Example code | 3 | Mostly TypeScript fragments without a runnable repo. No working "Hello World". |
| Error messages | 8 | The API's JSON errors are excellent — explicit codes (`relayer_unauthorized`, `validation_error`, `rpc_unavailable`), human-readable messages, even include the remediation hint ("Owner must call setRelayer(...)"). One of the strongest aspects of the platform. |

---

## 5.3 — Concrete recommendations (priority ranked)

### 🔴 HIGH — block agent on-boarding

1. **Authorise the relayer on-chain.** Today every `POST /api/v1/policies` returns 503; no agent can transact. (Detected on-call by the agent persona; would have been caught by an `/api/v1/health/deep` that probes `CoverRouter.isRelayer(relayer)`.)
2. **Single-source the contract addresses.** Pick `/health` as canonical, and have skills + `/docs` build their tables by fetching it at build time. Eliminate the `0x63D340…` USDC, `0x60447F…` CoverRouter, `0x04f94B…` PolicyManager, `0x863A7f…` Marketplace, `0x5304f6…` ClaimBond strings from skill markdown — three of these lead an agent to a wrong contract and silently lock funds.
3. **Fix `buy-policy-agent.md` schema.** Add `asset` (bytes32, value `keccak256("USDC")`) and `buyer` (address). Replace the broken `productId` example (20-byte address) with a 32-byte hash from `/products`.
4. **Self-service API key issuance.** Replace the `labs@lumina-org.com` email path with a `POST /api/v1/keys/self-issue` endpoint that takes a wallet signature. Today the agent narrative ("AI on-boards in 15 min") cannot survive an email round-trip.
5. **Add `GET /api/v1/marketplace/listings`.** Even an MVP that returns the last 100 `Listed` events with on-chain price + epoch + seller would unblock the entire yield-farmer strategy class.
6. **Fix `GET /api/v1/bonds/:wallet`.** Either paginate `eth_getLogs` (50 000-block windows), keep an SQLite index, or move to The Graph. Today this endpoint is permanently 503.

### 🟡 MEDIUM — slow agents down significantly

7. **Publish `/openapi.json`.** Express has `express-openapi-validator` or `swagger-jsdoc` that can auto-generate from JSDoc comments. Two-day spike.
8. **Add a `skills/INDEX.md`.** A grouped table of contents (auth / read / write / on-chain / monitoring) so an agent can navigate the 21 .md files without traversing the directory blind.
9. **Embed the API URL on the homepage agent section.** Right next to "Download SKILL→".
10. **Reconcile the `/api/v2/purchase` copy** on the homepage: alias the route in the API, OR fix the homepage copy to `/api/v1/policies`.
11. **Document idempotency.** State whether `Idempotency-Key` is required, optional, or ignored, and what the dedupe window is.

### 🟢 LOW — polish

12. **Add a human-readable shield name** to the `/products` response (e.g., `name: "Flash BTC 1h"`).
13. **Health-check `--deep` mode** that tests relayer authorisation and emits `relayer_unauthorized` BEFORE a buy attempt.
14. **Add a faucet skill** that explains how to mint test USDC against the `0xD944…` token, or at least documents the address an external wallet should request from.
15. **Document `Idempotency-Key` UUID format** inside `buy-policy-agent.md` (currently only in README).

---

## 5.4 — What's missing entirely

- **A 5-minute Quickstart** that produces a successful policy purchase from an empty environment.
- **A self-service API key flow.**
- **A marketplace GET endpoint.**
- **Machine-readable spec** (`/openapi.json`) and a generated TS/Python client.
- **A status / incident page.** When the relayer was unauthorised today, there was no public signal — operators would 503 silently.
- **End-to-end trigger walkthrough** combining `oracle/sign-proof` → `submitTrigger`.
- **Ops runbook** for common 503 / 400 errors with remediation steps (already partly embedded in the API's error messages — pull them into a doc page).
- **A versioning + deprecation policy** for addresses and skill files.

---

## 5.5 — Praise (things that worked surprisingly well)

- **`/health` is the best discovery surface I have used in any DeFi protocol.** One unauthenticated GET, every contract address, RPC connectivity status, relayer balance, current block. Phenomenal.
- **Error messages are unusually informative.** `relayer_unauthorized: Owner must call setRelayer(0x168dC7..., true)` literally tells you the fix.
- **Auth is dead-simple.** Single header, single key prefix, no signing. After Aave's Aave-V3 + Permit2 dance and Pendle's wallet-grant-signature combo, this is refreshingly direct.
- **Quote endpoint is unauthenticated and fast.** Lets an agent shop without spending key calls or attaching its identity. Good for agents that compare strategies before committing.
- **Repo is cleanly Dockerised.** `Dockerfile` works first try; Railway picks up the `railway.json` config without coaxing.

---

## 5.6 — Comparable competitor benchmark

| Protocol | Strengths Lumina could borrow | Weaknesses Lumina avoids |
|---|---|---|
| **Aave** | Massive DOC investment; OpenAPI for The Graph subgraphs; 4+ TS clients; explicit `Pause` events for ops alerting. | Aave's signing dance (Permit2 + EIP-712 typed data) is far more complex than Lumina's `x-api-key`. |
| **Compound** | Compound's `cTokenFactory` event log + JSON ABI files served at fixed URLs is the gold standard for "agent reads addresses programmatically". Lumina's `/health` is comparable, but Compound also has versioned IPFS-anchored ABIs. | Compound has no first-party REST surface for agents — Lumina's REST is *much* better than zero. |
| **GMX** | Subgraph-based marketplace queries (would solve Lumina's `GET /marketplace/listings` gap). | GMX has no skill-style natural-language docs; Lumina's skill bundle is a strong differentiator (just needs to be accurate). |
| **Pendle** | `Pendle SDK` (TS) is auto-generated and shipped on npm with quickstart. Lumina would benefit from a `@org-lumina/sdk` published from `/openapi.json`. | Pendle's documentation site is fragmented across multiple sources, like Lumina's — but Lumina has the smaller surface area, so it's fixable. |
| **Synthetix V3** | Markdown-style skill files (Lumina has these — closer than any other protocol) and a "perps trader" template repo agents fork. | Synthetix has > 80 skill-equivalent docs; Lumina's 21 are tighter. |

**Headline benchmark**: Lumina is *closer to "agent-ready"* than any of its competitors at this stage of the lifecycle, primarily because of the SKILL-files concept and the strong `/health` surface. The reason it can't actually *be* used by an agent today is not architectural — it's hygiene: stale addresses, doc/schema drift, and one operational flag (`setRelayer(true)`).

---

## Final connectivity verdict

**Was Lumina ready for autonomous AI agents on the day of this stress test?**
**No — needs work. Score: 4 / 10.**

The architecture *is* agent-ready. Three operational fixes (authorise relayer, single-source addresses, fix `buy-policy-agent.md` schema) plus one feature (`GET /marketplace/listings` or a status of the lacking) would push the score to 8 / 10 in a single sprint.

**Recommendation for next sprint**:
1. (Day 1) Authorise the relayer on Base Sepolia.
2. (Day 1-2) Rewrite `approve-usdc.md`, `buy-policy-agent.md`, `list-bond.md` with addresses pulled from `/health`.
3. (Day 2-3) Ship `GET /openapi.json` from the existing Express routes (no behavioural change).
4. (Day 3-5) Implement `GET /api/v1/marketplace/listings`.
5. (Day 5-7) Self-service API key endpoint backed by wallet signatures.

After these, re-run this exact stress test (same bot, same prompt) and target zero blockers.
