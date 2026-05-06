import { ethers } from "ethers";

/**
 * Static reverse-lookup of `bytes32 productId` -> human-readable name.
 *
 * Each Shield in `release/v5.1-pre-mainnet` declares
 *   `bytes32 public constant PRODUCT_ID = keccak256("<preimage>");`
 * Since keccak256 is one-way, the API has to maintain the preimage list.
 * If you deploy a new Shield, append its preimage + display name here.
 *
 * Source: src/products/*.sol PRODUCT_ID constants in
 *   github.com/org-lumina/LUMINA-PROTOCOL@release/v5.1-pre-mainnet
 */
const PREIMAGES: ReadonlyArray<readonly [string, string]> = [
  ["FLASHBTC1H-001", "Flash BTC 1h"],
  ["FLASHBTC4H-001", "Flash BTC 4h"],
  ["FLASHBTC24-001", "Flash BTC 24h"],
  ["FLASHBTC48-001", "Flash BTC 48h"],
  ["FLASHETH1H-001", "Flash ETH 1h"],
  ["FLASHETH24-001", "Flash ETH 24h"],
  ["FLASHETH48-001", "Flash ETH 48h"],
  ["MICRODEPEG-001", "Micro Depeg"],
  ["RATESHOCK-001", "Rate Shock"],
];

const NAMES: ReadonlyMap<string, string> = new Map(
  PREIMAGES.map(([preimage, name]) => [
    ethers.keccak256(ethers.toUtf8Bytes(preimage)).toLowerCase(),
    name,
  ])
);

/**
 * [10x10 fix M-6] Reverse map productId (bytes32 hex) -> the canonical
 * keccak256 preimage (e.g. "FLASHBTC1H-001"). Agents need this to
 * round-trip productId -> name without having to pre-compute hashes
 * from the Shields docs.
 */
const CANONICAL: ReadonlyMap<string, string> = new Map(
  PREIMAGES.map(([preimage]) => [
    ethers.keccak256(ethers.toUtf8Bytes(preimage)).toLowerCase(),
    preimage,
  ])
);

/**
 * Resolve `productId` (bytes32 hex) to a display name. Returns "Unknown product"
 * for ids not in the registry (e.g. shields deployed after this map was last
 * updated). Comparison is case-insensitive.
 */
export function getProductName(productId: string): string {
  return NAMES.get(productId.toLowerCase()) ?? "Unknown product";
}

/**
 * Resolve `productId` (bytes32 hex) to its canonical name (the
 * keccak256 preimage, e.g. "FLASHBTC1H-001"). Returns `undefined` for
 * unknown products so callers can decide whether to fall back to the
 * raw bytes32.
 */
export function getCanonicalName(productId: string): string | undefined {
  return CANONICAL.get(productId.toLowerCase());
}
