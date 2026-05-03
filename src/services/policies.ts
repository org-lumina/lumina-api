import { ethers } from "ethers";
import { coverRouter, coverRouterRelayer, getGlobalPauseRegistry, policyManager, relayer } from "../utils/ethers";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";

export interface PolicyOnChain {
  productId: string;
  policyId: string;
  shield: string;
  buyer: string;
  coverageAmount: string;
  payoutAmount: string;
  premiumPaid: string;
  createdAt: string;
  expiresAt: string;
  triggered: boolean;
  expired: boolean;
  /**
   * [V5.1 H-6] LUMINA/USD price snapshot (18-dec) recorded at `recordPolicy`
   * time. When the policy triggers, BondVault uses this price to issue the
   * bond — protecting the buyer from oracle drift between purchase and trigger.
   * `"0"` when not yet set (e.g. legacy V5.0 policies stored before H-6).
   */
  priceSnapshot: string;
}

export async function getPolicy(productId: string, policyId: bigint): Promise<PolicyOnChain | undefined> {
  // PolicyManagerV2.PolicyRecord layout (verified against src/core/PolicyManagerV2.sol):
  //   0: bytes32 productId
  //   1: address shield
  //   2: address buyer
  //   3: uint256 coverageAmount
  //   4: uint256 payoutAmount   (coverage × payoutRatioBps / 10000)
  //   5: uint256 premiumPaid
  //   6: uint256 createdAt
  //   7: uint256 expiresAt
  //   8: bool    triggered
  //   9: bool    expired
  const r = await policyManager.policies(productId, policyId);
  const buyer = r[2] as string;
  if (buyer === "0x0000000000000000000000000000000000000000") return undefined;
  // [V5.1 H-6] Surface the per-policy price snapshot. Read in parallel with
  // the policies() call to keep latency flat.
  const priceSnapshot: bigint = await policyManager.policyPriceSnapshot(productId, policyId);
  return {
    productId: r[0],
    policyId: policyId.toString(),
    shield: r[1],
    buyer,
    coverageAmount: r[3].toString(),
    payoutAmount: r[4].toString(),
    premiumPaid: r[5].toString(),
    createdAt: r[6].toString(),
    expiresAt: r[7].toString(),
    triggered: Boolean(r[8]),
    expired: Boolean(r[9]),
    priceSnapshot: priceSnapshot.toString(),
  };
}

export interface PurchaseInput {
  productId: string;       // bytes32 hex
  coverageAmount: bigint;  // USDC base units (6 decimals)
  asset: string;           // bytes32 hex
  buyer: string;           // 0x address
}

export interface PurchaseReceipt {
  txHash: string;
  blockNumber: number | null;
  policyId: string;
  buyer: string;
  productId: string;
  coverageAmount: string;
  premiumPaid: string;
}

const POLICY_CREATED_EVENT_SIG = ethers.id(
  "PolicyCreated(bytes32,uint256,address,uint256,uint256,uint256)"
);

/**
 * Submit a purchasePolicyFor tx via relayer. Decodes PolicyCreated event from
 * the receipt to extract the assigned policyId and premium charged.
 */
export async function purchaseViaRelayer(input: PurchaseInput): Promise<PurchaseReceipt> {
  logger.info(
    { productId: input.productId, buyer: input.buyer, coverage: input.coverageAmount.toString() },
    "submitting purchasePolicyFor"
  );

  // Pre-flight: relayer must be authorized
  const isRelayer: boolean = await coverRouterRelayer.authorizedRelayers(relayer.address);
  if (!isRelayer) {
    throw new HttpError(
      503,
      `Relayer ${relayer.address} is not authorized in CoverRouter. Owner must call setRelayer(${relayer.address}, true).`,
      "relayer_unauthorized"
    );
  }

  // [V5.1 H-4] Pre-flight: CoverRouterV2 local pause flag. The on-chain
  // `whenNotPaused` modifier reverts with `ContractPaused()` — pre-flighting
  // here returns a clean 503 without consuming gas estimation.
  const localPaused: boolean = await coverRouter.paused();
  if (localPaused) {
    throw new HttpError(503, "CoverRouter is paused (local circuit breaker)", "cover_router_paused");
  }

  // [V5.1 M-7] Pre-flight: GlobalPauseRegistry. CoverRouterV2's `whenNotPaused`
  // modifier ALSO calls `globalPauseRegistry.isGloballyPaused()` (defense-in-
  // depth multisig kill switch). Skip when the registry is unset (address(0))
  // — matches the modifier's null-check.
  const registry = await getGlobalPauseRegistry();
  if (registry) {
    const globallyPaused: boolean = await registry.isGloballyPaused();
    if (globallyPaused) {
      throw new HttpError(503, "Protocol is globally paused", "globally_paused");
    }
  }

  // [V5.1 H-5] Pre-flight: product must be active. PolicyManagerV2.recordPolicy
  // reverts with `ProductNotActive(productId)` — pre-flighting returns a 400
  // with the specific code so clients can distinguish from generic tx errors.
  const productActive: boolean = await policyManager.productActive(input.productId);
  if (!productActive) {
    throw new HttpError(
      400,
      `Product ${input.productId} is not active`,
      "product_inactive"
    );
  }

  let tx;
  try {
    tx = await coverRouterRelayer.purchasePolicyFor(
      input.productId,
      input.coverageAmount,
      input.asset,
      input.buyer
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(400, `Transaction submission failed: ${msg}`, "tx_submit_failed");
  }

  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new HttpError(502, `Transaction reverted: ${tx.hash}`, "tx_reverted");
  }

  // Find PolicyCreated event in logs to get policyId + premium
  let policyId = "0";
  let premiumPaid = "0";
  for (const log of receipt.logs as ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }>) {
    if (log.topics[0] !== POLICY_CREATED_EVENT_SIG) continue;
    // PolicyCreated(bytes32 indexed productId, uint256 indexed policyId, address buyer, uint256 coverage, uint256 premium, uint256 payout)
    policyId = BigInt(log.topics[2]).toString();
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "uint256", "uint256"],
      log.data
    );
    premiumPaid = (decoded[2] as bigint).toString();
    break;
  }

  return {
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    policyId,
    buyer: input.buyer,
    productId: input.productId,
    coverageAmount: input.coverageAmount.toString(),
    premiumPaid,
  };
}
