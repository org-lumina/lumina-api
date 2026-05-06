import { ethers } from "ethers";

/**
 * Static reverse-lookup of `bytes32 productId` -> human-readable name.
 *
 * Each Shield in `release/v5.1-pre-mainnet` declares
 *   `bytes32 public constant PRODUCT_ID = keccak256("<preimage>");`
 * Since keccak256 is one-way, the API has to maintain the preimage list.
 * If you deploy a new Shield, append its preimage + display name + asset here.
 *
 * Source: src/products/*.sol PRODUCT_ID constants in
 *   github.com/org-lumina/LUMINA-PROTOCOL@release/v5.1-pre-mainnet
 */
export type AssetSymbol = "BTC" | "ETH" | "USDC" | "USDT";

// Each tuple is [canonical preimage, display name, expected asset symbol].
// The third column is the literal each Shield's createPolicy() validates:
//   - FlashBTC*: params.asset == "BTC"
//   - FlashETH*: params.asset == "ETH"
//   - MicroDepegShield: "USDT"
//   - RateShockShield: "USDC"
// Sending the wrong asset reverts with InvalidAsset(bytes32). The API uses
// this column to auto-resolve the asset for any caller that supplies a
// productId/productName but omits the asset field.
const PREIMAGES: ReadonlyArray<readonly [string, string, AssetSymbol]> = [
  ["FLASHBTC1H-001", "Flash BTC 1h", "BTC"],
  ["FLASHBTC4H-001", "Flash BTC 4h", "BTC"],
  ["FLASHBTC24-001", "Flash BTC 24h", "BTC"],
  ["FLASHBTC48-001", "Flash BTC 48h", "BTC"],
  ["FLASHETH1H-001", "Flash ETH 1h", "ETH"],
  ["FLASHETH24-001", "Flash ETH 24h", "ETH"],
  ["FLASHETH48-001", "Flash ETH 48h", "ETH"],
  ["MICRODEPEG-001", "Micro Depeg", "USDT"],
  ["RATESHOCK-001", "Rate Shock", "USDC"],
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

const ASSET_BY_ID: ReadonlyMap<string, AssetSymbol> = new Map(
  PREIMAGES.map(([preimage, , asset]) => [
    ethers.keccak256(ethers.toUtf8Bytes(preimage)).toLowerCase(),
    asset,
  ])
);

const ASSET_BY_NAME: ReadonlyMap<string, AssetSymbol> = new Map(
  PREIMAGES.map(([preimage, , asset]) => [preimage, asset])
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

/**
 * Resolve `productId` (bytes32 hex) to the asset literal the matching Shield
 * expects in `params.asset`. Returns `undefined` for unknown products so
 * callers can decide whether to require the caller-supplied asset instead.
 */
export function getExpectedAsset(productId: string): AssetSymbol | undefined {
  return ASSET_BY_ID.get(productId.toLowerCase());
}

/**
 * Resolve a canonical product name (e.g. "FLASHBTC1H-001") to its expected
 * asset literal. Returns `undefined` if the name is not in the registry.
 */
export function getExpectedAssetForName(name: string): AssetSymbol | undefined {
  return ASSET_BY_NAME.get(name);
}

/** Compute the on-chain `bytes32` productId for a canonical name. */
export function productIdFromName(name: string): string | undefined {
  if (!ASSET_BY_NAME.has(name)) return undefined;
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}
