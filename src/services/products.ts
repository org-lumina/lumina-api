import { coverRouter, policyManager } from "../utils/ethers";
import { getCanonicalName, getProductName } from "../utils/productNames";

export interface ProductDto {
  productId: string;          // bytes32 hex
  /** [10x10 fix M-6] Canonical keccak256 preimage (e.g. "FLASHBTC1H-001"). */
  name: string | null;
  /** Human-friendly display label (e.g. "Flash BTC 1h"). */
  displayName: string;
  shield: string;             // address
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
    out.push({
      productId,
      name: getCanonicalName(productId) ?? null,
      displayName: getProductName(productId),
      shield,
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
  return {
    productId,
    name: getCanonicalName(productId) ?? null,
    displayName: getProductName(productId),
    shield,
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
