# Phase 1 — Reconnaissance UX Report

**Persona**: External AI agent with zero prior knowledge of Lumina, integrating from scratch using only public surfaces.
**Date**: 2026-05-05
**Time spent**: ~1h15m

---

## What I learned about Lumina

Lumina is a parametric risk protocol on Base L2 (currently Base Sepolia testnet, `chainId=84532`, called "V5.1 ClaimBond Model"). Users buy short-duration policies covering price-shock conditions; if the trigger fires (Chainlink oracle), the protocol mints a 24-month ClaimBond (USD-denominated) to the policy holder. The ClaimBond can be held to maturity and redeemed in LUMINA, or sold on a secondary marketplace. Premiums fund a sealed BondVault reserve; losing premiums burn LUMINA via on-chain market purchases.

The protocol exposes two interfaces:
- A web app at `/app` for humans
- A REST API + 21 markdown SKILL files under `github.com/org-lumina/lumina-api` for AI agents

---

## Public surfaces enumerated

| Surface | URL | Use |
|---|---|---|
| Homepage | https://www.lumina-org.com | High-level pitch |
| Docs | https://www.lumina-org.com/docs | Architecture + contracts table |
| Skills | https://www.lumina-org.com/skills | 21 skill cards → GitHub |
| Tutorial | https://www.lumina-org.com/tutorial?mode=agent | High-level agent workflow |
| GitHub org | https://github.com/org-lumina | 4 repos: BOTXAGUSTIN, MOLTAGENTINSURANCE, LUMINA-PROTOCOL, lumina-api |
| API base | https://lumina-api-production-ac85.up.railway.app | REST API (Express + ethers) |
| Skills repo dir | `lumina-api/docs/skills/` | 21 .md skill files |

---

## Endpoint map (live, derived from probing /health and skills)

```
GET  /health                          → public, returns chain + contracts + relayer
GET  /products                        → public, lists 9 products with productId+shield+terms
GET  /products/:productId             → public, single product config
GET  /products/:productId/quote       → public, premium quote (?coverageAmount=N USDC base units)
POST /api/v1/policies                 → AUTH, buy policy via relayer (BLOCKED — see findings)
GET  /api/v1/policies?owner=0x...     → AUTH, list policies by buyer
POST /api/v1/oracle/sign-proof        → AUTH, EIP-712 price proof
GET  /api/v1/oracle/signer            → AUTH, signer address
POST /api/v1/keys/generate            → ADMIN, issue API key
DELETE /api/v1/keys/:id               → ADMIN, revoke key
GET  /api/v1/bonds/:wallet            → AUTH, BROKEN — RPC eth_getLogs block range exceeds 50000
?  marketplace listings GET           → DOES NOT EXIST (gap)
```

The `count: 9` in `/products` matches the "9 shields" the founder mentions internally, but the API never returns a human-readable shield name — only a 32-byte productId, the shield contract address, and 4 numeric parameters (`payoutRatioBps`, `triggerProbBps`, `marginBps`, `durationSeconds`). An agent has no way to know "this product covers 1h Flash BTC" without scraping the homepage manually.

---

## Live `/health` reveals canonical addresses (Base Sepolia)

```
relayer       0x168dC7105e907294f9d066cee24f30caa5A17E4a  (balance ≈ 0.02 ETH)
coverRouter   0xebC3A783477FbD2720C024e16A8d63B8Db983D84
policyManager 0xd9732A8d6Cf5266Dd896B825E78E387B7Dd2c379
bondVault     0x101F92fC506C1e60A2A0dD01eA29597EBf222d2B
claimBond     0x3d2F5DB2505367D00ef81c51AD3cA66159271730
marketplace   0xfaC56692c626718aC8953A3d5fAE67fac2f1Be6E
usdc          0xD944d8e5D8329994D83950872Ec210891d3Ab6AE
luminaToken   0x8A0FDc2126eb9b0c88D17711D62713A1c06CF7Ab
```

Confirmed by reading `CoverRouter.usdc()` on-chain → returns `0xD944…D8e5D8…3Ab6AE`. **/health is the canonical source.**

---

## What worked well

- **`/health` is gold**: a single anonymous GET returns chainId, block, RPC connectivity, relayer address+balance, and all 7 protocol contract addresses. Best discovery surface in the entire stack. Should be the *first* thing every onboarding doc points at.
- **`/products` is well-formed**: returns the 9 active products with the on-chain hashes the API needs. Quote endpoint works without auth (great for cost preview).
- **`x-api-key` auth is dead-simple**: no OAuth, no JWT, no signing. Single header, plaintext key starting with `lk_`. Took ~10 seconds to get a 200 from `/api/v1/oracle/signer` once the key was set.
- **Quote math is verifiable**: $50 cover → premium 160000 (= $0.16) → payout 40000000 (= $40). The 80% payout ratio holds.

---

## What was confusing

1. **API base URL is buried.** It is on the `/skills` page only. Not on the homepage. Not on `/docs`. Not on `/tutorial`. An external agent following the homepage CTA "Drop the SKILL file into your agent → POST /api/v2/purchase" cannot find the host. Suggested fix: surface the production URL on the homepage agent-section copy and on `/docs` first.

2. **Endpoint version inconsistency.** Homepage advertises `POST /api/v2/purchase`; README + skills + the live API use `POST /api/v1/policies`. There is no v2 route. Suggested fix: rewrite the homepage copy to match shipping endpoints, or alias v2 to v1.

3. **Skill files contradict the live schema.** `buy-policy-agent.md` shows the request body as:
   ```json
   { "productId": "...", "coverageAmount": "..." }
   ```
   But the live API rejects that with `validation_error: asset and buyer are Required`. The actual schema is:
   ```json
   { "productId": "0x…32B", "coverageAmount": "<USDC base units>",
     "asset": "<bytes32 keccak256('USDC')>", "buyer": "<wallet 0x…>" }
   ```
   Plus `buy-policy-agent.md` shows an example `productId` that is a 20-byte address (`0xAc53Bf7Bb85Fcfb6d3c831F3AD9f6f79ebeeF99f`) instead of a 32-byte hash. Anyone copying the example would get `validation_error: productId must be bytes32`.

4. **Stale contract addresses in `approve-usdc.md`.** Skill says:
   - USDC = `0x63D340AE7229BB464bC801f225651341ebcD3693`
   - CoverRouterV2 = `0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316`
   
   Live `/health` says:
   - USDC = `0xD944d8e5D8329994D83950872Ec210891d3Ab6AE`
   - CoverRouter = `0xebC3A783477FbD2720C024e16A8d63B8Db983D84`
   
   This is the worst possible class of doc gap: an agent will follow the skill, approve USDC to the wrong router, and silently lock its allowance against a contract that never gets used. **The bot wallet itself is funded on the stale USDC address — see Phase 4.**

5. **`/docs` "Deployed Contracts" table is also stale** (lists `claimBond=0x5304…` vs live `0x3d2F…`). Anyone reading docs for ABIs is likely loading them against the wrong proxies.

6. **Marketplace has no GET listings endpoint.** The README hints at `POST /api/v1/marketplace/list` but `GET /api/v1/marketplace*` returns 404. The skill `list-bond.md` confirms listing is direct on-chain (`Marketplace.list(epochId, amount, priceUSDC)`). To "scan listings" an agent must subscribe to `Listed` events — an undocumented requirement.

7. **`/api/v1/bonds/:wallet` is broken on production.** Returns 503 `rpc_unavailable: exceed maximum block range: 50000`. The handler queries `eth_getLogs` from block 0 to latest; the public RPC caps at 50000 blocks. Either the handler needs pagination, an indexer, or a `fromBlock` query param.

8. **Trigger flow is half-documented.** `watch-triggers.md` says "subscribe to `PolicyTriggered`" but never explains how an agent submits a trigger. There IS a `POST /api/v1/oracle/sign-proof` endpoint (per README) that produces an EIP-712 proof, but no skill walks through the proof → on-chain `submitTrigger` flow end-to-end.

9. **Idempotency requirement is hidden.** Only the README's single curl example shows `Idempotency-Key`. The skill files don't mention it. The actual API does not seem to require it (the validation_error did not flag it absent), but unclear behavior under retry.

10. **No machine-readable spec.** No `/openapi.json`, no `/docs` (Swagger UI) on the API. An agent would have to read 21 separate `.md` files from a private-ish GitHub path to assemble a full picture.

11. **No skill INDEX/README.** `lumina-api/docs/skills/` has 21 `.md` files but no `README.md` listing them or grouping by use-case. Agent has to traverse the directory blind.

---

## What was MISSING entirely from public docs

- **Self-service API key flow.** Skills page says "Request via labs@lumina-org.com — admin-only on testnet". The README mentions `POST /api/v1/keys/generate` requires an `x-admin-token`. There is no public form, no OAuth, no wallet-signature path. A real autonomous agent cannot onboard.
- **Faucet for testnet USDC.** No documented faucet for the `0xD944…` USDC token. No mention of how an agent should get test funds.
- **A "Hello World" 5-minute quickstart** that goes from `npm i` to first successful policy purchase. The closest is the README's single curl, which is missing required fields.
- **End-to-end trigger walkthrough** combining `oracle/sign-proof` + on-chain `submitTrigger`.
- **Status / incident page.** When the relayer became unauthorized on-chain (see Phase 4), there was no public signal — an agent would silently rack up 503s with no remediation hint other than the error message.
- **Versioning and deprecation policy.** Are addresses immutable? Are skills versioned with the protocol? Unclear.
- **Comparable competitor benchmark / migration guide.** Nothing that says "if you've integrated Aave, here's how Lumina differs".

---

## Severity ratings (1 = trivial, 10 = blocks all integration)

| Dimension | Rating | One-line justification |
|---|---|---|
| Discoverability of API base URL | 7 | Hidden on `/skills` only; homepage doesn't say where the host is. |
| API documentation accuracy | 9 | Live schema diverges from skills; addresses in skills are stale. |
| Onboarding friction (zero-to-call) | 6 | Auth is simple, but quickstart is missing and key issuance is human-gated. |
| Agent-specific guides | 5 | 21 skills exist but no INDEX, contradict live API, and miss key flows. |
| Endpoint reliability | 8 | `/bonds` is 503; `/policies` is 503 (relayer unauthorized) on the day of test. |
| Address consistency across surfaces | 10 | Three sources (skills, /docs, /health) disagree on every key address. |

---

## What I would tell the Lumina founder

If the agent persona is the long-term go-to-market thesis ("AI agents on-board in 15 minutes"), the current documentation makes it impossible. **Three surfaces (homepage, /docs, skills) all show different contract addresses**, the **only working source of truth is `/health`** (which no doc points to), and **the live `POST /api/v1/policies` schema requires fields that no skill documents** (`asset` + `buyer`). On top of that, the relayer is currently unauthorized on-chain, so even with perfect docs the live API cannot fulfill its primary function today (every policy purchase returns 503 `relayer_unauthorized`).

**Concrete priorities to ship next sprint** (in order):
1. Fix the relayer authorization on-chain (cannot ship a stress test until this passes).
2. Auto-generate `/openapi.json` from the Express routes and serve it; mirror it in `/skills/index.md`.
3. Single-source contract addresses: have skills + docs read `/health` at build time, not hardcode.
4. Add `GET /api/v1/marketplace/listings` (basic) so agents can scan without reading events.
5. Fix `/api/v1/bonds/:wallet` paginated `eth_getLogs` (or stand up an indexer / use The Graph).
6. Self-service key issuance gated by wallet signature → returns key + writes the rate-limit tier on creation.
7. Publish a 5-minute quickstart with a copy-pasteable curl that actually returns 201.
