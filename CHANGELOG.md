# Changelog

All notable changes to `lumina-api` are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with ISO
dates.

## 2026-05-21 — Sprint T-30c (V5.3 live)

### Added
- 6 new Flash shields + 6 UUPS `FlashShieldAdapter` proxies deployed on
  **Base Sepolia (84532)** by `0xe585e76A0b8CbbC2d10b1110a9ac3F4c11dBfDa8`
  and registered as products in `CoverRouterV2`
  (`marginBps=20000`, `payoutRatioBps=8000`):
  - `FlashBTCShield1h`  — shield `0x06ED1ffB6bA493c036472bf1C58EC9301B5A2363` | adapter `0x5fC732D28c09DfcA2e7eF0AAd6C9491c8474eAdB`
  - `FlashBTCShield24h` — shield `0x9E4C1E799AA41a36ae074768b33198b9D8aCC173` | adapter `0x844A5fDb3C910DC33Eb720fDB5387C3d55eC867d`
  - `FlashBTCShield48h` — shield `0x815802E93cD7fB0C4Ce49f290F1A1Ee9473F0406` | adapter `0x0840d638a3E79919afE3b1AB589E6D4b5E8C45Bb`
  - `FlashETHShield1h`  — shield `0xF858b572De264DF8980dF57A680762B7cb88E351` | adapter `0xeC42c7169B4D80F4D8A113607367F75c2df02935`
  - `FlashETHShield24h` — shield `0x18ccC1eE644C8A79DD93D0F4694960FeC5348eFA` | adapter `0xb0f143beF75F32BcAB569766e9159366f8fD69C4`
  - `FlashETHShield48h` — shield `0xC42360BC94401B07ca337Bc4d0Fb338604F8f4cE` | adapter `0x26db224D3Ddc00F4bFcF8ab26A92B9f7c81A47E6`
- `docs/sprint-t30c.md` deployment manifest (addresses + productIds + risk
  params). The 6 canonical product names were already registered in
  `src/utils/productNames.ts`, so no source change was needed.

### Notes
- Since Sprint Z.2, contract addresses live in Railway env vars (not in
  source). Updating Railway env / monitoring with any per-shield variables
  is a separate founder action.
- API behaviour is unchanged — `CoverRouterV2` resolves the new products
  on-chain, and the SDK / landing / agents discover them automatically.
