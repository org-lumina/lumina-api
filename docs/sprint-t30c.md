# Sprint T-30c — Flash Shield V5.3 Deployment

**Network:** Base mainnet (chainId 8453)
**Deployer:** `0xe585e76A0b8CbbC2d10b1110a9ac3F4c11dBfDa8`
**Deployed:** 2026-05-21
**Sprint scope:** 6 new Flash shields + 6 UUPS `FlashShieldAdapter` proxies, all
registered as products in CoverRouterV2 with `marginBps=20000`,
`payoutRatioBps=8000`.

> Since Sprint Z.2, the API no longer carries hardcoded testnet addresses in
> source — all contract addresses are resolved from Railway environment
> variables (`POLICY_MANAGER`, `COVER_ROUTER`, …) and surfaced via
> `GET /health`. This document is the canonical reference for the **shield**
> + **adapter** addresses themselves, which the API does not need to load
> directly (it interacts with shields via `CoverRouterV2.purchasePolicy()` →
> `PolicyManager` → product registry on-chain).
>
> Updating the Railway env (if any of these need to be added there for ops /
> monitoring) is a **separate founder action** and is not part of this PR.

## Shields + Adapters

| Product | Shield | Adapter (UUPS proxy) |
| --- | --- | --- |
| FlashBTCShield1h  | `0x06ED1ffB6bA493c036472bf1C58EC9301B5A2363` | `0x5fC732D28c09DfcA2e7eF0AAd6C9491c8474eAdB` |
| FlashBTCShield24h | `0x9E4C1E799AA41a36ae074768b33198b9D8aCC173` | `0x844A5fDb3C910DC33Eb720fDB5387C3d55eC867d` |
| FlashBTCShield48h | `0x815802E93cD7fB0C4Ce49f290F1A1Ee9473F0406` | `0x0840d638a3E79919afE3b1AB589E6D4b5E8C45Bb` |
| FlashETHShield1h  | `0xF858b572De264DF8980dF57A680762B7cb88E351` | `0xeC42c7169B4D80F4D8A113607367F75c2df02935` |
| FlashETHShield24h | `0x18ccC1eE644C8A79DD93D0F4694960FeC5348eFA` | `0xb0f143beF75F32BcAB569766e9159366f8fD69C4` |
| FlashETHShield48h | `0xC42360BC94401B07ca337Bc4d0Fb338604F8f4cE` | `0x26db224D3Ddc00F4bFcF8ab26A92B9f7c81A47E6` |

## Product IDs (keccak256 preimage → bytes32)

The canonical preimages are already registered in
[`src/utils/productNames.ts`](../src/utils/productNames.ts) — no source change
was required for this sprint.

| Canonical name | `bytes32` productId |
| --- | --- |
| `FLASHBTC1H-001` | `0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd` |
| `FLASHBTC24-001` | `0xdc5bcc7d6e2e9ca89d46d4f6672db80985d5e86509243dcca44a4e87d871a7b9` |
| `FLASHBTC48-001` | `0xb630608784616003f974941232dd618003e5a182176cc14010db95cda2ab1ee8` |
| `FLASHETH1H-001` | `0x6cedbccfc3dc131aec7bdd9a9761ac0a8e665daa87763328ffca700f9b678915` |
| `FLASHETH24-001` | `0xcc03aef924fc23ad01e6391af37bcfdb9ad40cce7c76218e51be62c38167f240` |
| `FLASHETH48-001` | `0x89a37df7cf246013d58a6b121e57b1e6417cea854b354183025ed0b41663712d` |

## Risk parameters

All 6 products were configured in `CoverRouterV2.setProduct(...)` with:

- `marginBps = 20000` (200% of premium reserved against payout)
- `payoutRatioBps = 8000` (80% of cover paid out on trigger)

## Notes for ops

- The API does not need the shield/adapter addresses at runtime — it only
  needs `COVER_ROUTER`, `POLICY_MANAGER`, `BOND_VAULT` etc. (already in
  Railway).
- Off-chain consumers (SDK, landing, agents) discover products via the
  on-chain `CoverRouterV2` registry, so they pick up these 6 new products
  automatically once registered.
- If any monitoring / alerting needs a per-shield env var, add it in Railway
  (not in this repo) and document the variable name here in a follow-up PR.
