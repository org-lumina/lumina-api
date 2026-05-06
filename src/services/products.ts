import { coverRouter, policyManager } from "../utils/ethers";
import { getCanonicalName, getProductName } from "../utils/productNames";

/**
 * [feat/products-coveredAsset] Static metadata enriching the on-chain
 * product config with the *covered asset* (what the policy insures
 * against), the *payment asset* (always USDC), and a one-line plain
 * English coverage description. Keyed by canonical product name (the
 * keccak256 preimage of `productId`).
 *
 * IMPORTANT: `coveredAsset` is NOT the premium token. Premium is always
 * USDC across every product. `coveredAsset` answers: "what event does
 * this policy insure against?".
 */
const PRODUCT_META: Record<
  string,
  { coveredAsset: ProductDto["coveredAsset"]; coverageDescription: string }
> = {
  "FLASHBTC1H-001": {
    coveredAsset: "BTC",
    coverageDescription: "Insures BTC against rapid price crashes within 1 hour",
  },
  "FLASHBTC4H-001": {
    coveredAsset: "BTC",
    coverageDescription: "Insures BTC against rapid price crashes within 4 hours",
  },
  "FLASHBTC24-001": {
    coveredAsset: "BTC",
    coverageDescription: "Insures BTC against rapid price crashes within 24 hours",
  },
  "FLASHBTC48-001": {
    coveredAsset: "BTC",
    coverageDescription: "Insures BTC against rapid price crashes within 48 hours",
  },
  "FLASHETH1H-001": {
    coveredAsset: "ETH",
    coverageDescription: "Insures ETH against rapid price crashes within 1 hour",
  },
  "FLASHETH24-001": {
    coveredAsset: "ETH",
    coverageDescription: "Insures ETH against rapid price crashes within 24 hours",
  },
  "FLASHETH48-001": {
    coveredAsset: "ETH",
    coverageDescription: "Insures ETH against rapid price crashes within 48 hours",
  },
  "MICRODEPEG-001": {
    coveredAsset: "USDT",
    coverageDescription: "Insures against USDT losing its peg to $1.00",
  },
  "RATESHOCK-001": {
    coveredAsset: "USDC",
    coverageDescription: "Insures against USDC borrow rate shocks on Aave V3",
  },
};

function metaFor(name: string | null): {
  coveredAsset: ProductDto["coveredAsset"];
  paymentAsset: "USDC";
  coverageDescription: string;
} {
  if (name && PRODUCT_META[name]) {
    return { ...PRODUCT_META[name], paymentAsset: "USDC" };
  }
  // Unknown product (e.g. shield deployed after this map was last updated).
  // Falling back to USDC is the *safest* default because every existing
  // shield's payment token is USDC; the description is intentionally generic.
  if (name) {
    // eslint-disable-next-line no-console
    console.warn(
      `[products] unknown canonical name "${name}" — falling back to coveredAsset=USDC. Update PRODUCT_META in src/services/products.ts.`,
    );
  }
  return {
    coveredAsset: "USDC",
    paymentAsset: "USDC",
    coverageDescription: "Insurance product (covered asset metadata not yet registered)",
  };
}

export interface ProductDto {
  productId: string;          // bytes32 hex
  /** [10x10 fix M-6] Canonical keccak256 preimage (e.g. "FLASHBTC1H-001"). */
  name: string | null;
  /** Human-friendly display label (e.g. "Flash BTC 1h"). */
  displayName: string;
  shield: string;             // address
  /**
   * [feat/products-coveredAsset] The asset whose event is being insured
   * against (NOT the premium token). E.g. FlashBTC* covers BTC; MicroDepeg
   * covers USDT; RateShock covers USDC.
   */
  coveredAsset: "USDC" | "USDT" | "BTC" | "ETH";
  /** Always "USDC". The token used to pay the premium. */
  paymentAsset: "USDC";
  /** One-line plain-English description of what this product insures against. */
  coverageDescription: string;
  payoutRatioBps: number;
  triggerProbBps: number;
  marginBps: number;
  durationSeconds: number;
  active: boolean;
}

export async function listProducts(): Promise<ProductDto[]> {
  const count: bigint = await coverRouter.getProductCount();
  const out: ProductDto[] = [];
  for (let i = 0n; i < count; i++) {
    const productId: string = await coverRouter.productList(i);
    const cfg = await coverRouter.products(productId);
    // products(bytes32) -> (bytes32 id, uint256 payoutRatioBps, uint256 triggerProbBps,
    //                       uint256 marginBps, uint32 durationSeconds, bool active)
    const shield: string = await policyManager.productShield(productId);
    const name = getCanonicalName(productId) ?? null;
    const meta = metaFor(name);
    out.push({
      productId,
      name,
      displayName: getProductName(productId),
      shield,
      coveredAsset: meta.coveredAsset,
      paymentAsset: meta.paymentAsset,
      coverageDescription: meta.coverageDescription,
      payoutRatioBps: Number(cfg[1]),
      triggerProbBps: Number(cfg[2]),
      marginBps: Number(cfg[3]),
      durationSeconds: Number(cfg[4]),
      active: Boolean(cfg[5]),
    });
  }
  return out;
}

export async function getProduct(productId: string): Promise<ProductDto | undefined> {
  const isActive: boolean = await policyManager.productActive(productId);
  if (!isActive) {
    // Check whether it exists at all
    const shield: string = await policyManager.productShield(productId);
    if (shield === "0x0000000000000000000000000000000000000000") return undefined;
  }
  const cfg = await coverRouter.products(productId);
  const shield: string = await policyManager.productShield(productId);
  const name = getCanonicalName(productId) ?? null;
  const meta = metaFor(name);
  return {
    productId,
    name,
    displayName: getProductName(productId),
    shield,
    coveredAsset: meta.coveredAsset,
    paymentAsset: meta.paymentAsset,
    coverageDescription: meta.coverageDescription,
    payoutRatioBps: Number(cfg[1]),
    triggerProbBps: Number(cfg[2]),
    marginBps: Number(cfg[3]),
    durationSeconds: Number(cfg[4]),
    active: Boolean(cfg[5]),
  };
}

export async function quotePremium(productId: string, coverageAmount: bigint): Promise<{ premium: string; payout: string }> {
  const result: [bigint, bigint] = await coverRouter.quotePremium(productId, coverageAmount);
  return { premium: result[0].toString(), payout: result[1].toString() };
}
