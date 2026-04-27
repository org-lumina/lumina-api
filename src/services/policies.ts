import { ethers } from "ethers";
import { coverRouterRelayer, policyManager, relayer } from "../utils/ethers";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";

export interface PolicyOnChain {
  productId: string;
  policyId: string;
  buyer: string;
  payoutTo: string;
  coverageAmount: string;
  premiumPaid: string;
  payoutAmount: string;
  startTime: string;
  endTime: string;
  triggered: boolean;
  expired: boolean;
}

export async function getPolicy(productId: string, policyId: bigint): Promise<PolicyOnChain | undefined> {
  // policies(productId, policyId) ->
  //   (bytes32 productId, address buyer, address payoutTo, uint256 coverageAmount,
  //    uint256 premiumPaid, uint256 payoutAmount, uint256 startTime, uint256 endTime,
  //    bool triggered, bool expired)
  const r = await policyManager.policies(productId, policyId);
  const buyer = r[1] as string;
  if (buyer === "0x0000000000000000000000000000000000000000") return undefined;
  return {
    productId: r[0],
    policyId: policyId.toString(),
    buyer,
    payoutTo: r[2],
    coverageAmount: r[3].toString(),
    premiumPaid: r[4].toString(),
    payoutAmount: r[5].toString(),
    startTime: r[6].toString(),
    endTime: r[7].toString(),
    triggered: Boolean(r[8]),
    expired: Boolean(r[9]),
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
