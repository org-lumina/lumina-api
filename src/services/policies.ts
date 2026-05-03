import { ethers } from "ethers";
import { bondVault, coverRouterRelayer, getShield, policyManager, provider, relayer } from "../utils/ethers";
import { getProductName } from "../utils/productNames";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";

export type PolicyStatus = "Waiting" | "Active" | "Triggered" | "Expired" | "Cancelled";

export interface PolicyOnChain {
  productId: string;
  productName: string;            // [V5.1] derived from PRODUCT_ID preimage
  policyId: string;
  shield: string;
  /** @deprecated kept for backwards-compat; same value as `holder`. */
  buyer: string;
  holder: string;                 // wallet that owns the policy (same as buyer)
  coverageAmount: string;
  payoutAmount: string;
  premiumPaid: string;            // USDC base units (6-dec)
  purchasedAt: string;            // [V5.1 alias of createdAt — names match the spec]
  createdAt: string;
  waitingEndsAt: string | null;   // [V5.1] from Shield.getPolicyInfo
  expiresAt: string;
  status: PolicyStatus;
  triggered: boolean;
  expired: boolean;
  productActive: boolean;         // [V5.1 H-5]
  priceSnapshot: string;          // [V5.1 H-6] LUMINA/USD 18-dec at purchase
  triggeredAt: string | null;     // [V5.1] from PolicyTriggered event block
  bondId: string | null;          // [V5.1] BondVault epochId emitted on trigger
}

const BOND_ISSUED_TOPIC = ethers.id("BondIssued(address,uint256,uint256)");

/**
 * Look up the (epochId, blockNumber) emitted when this policy was triggered.
 * Returns `{triggeredAt, bondId}` (both as strings) or both null when no
 * `PolicyTriggered` event is found on-chain (e.g. legacy data, indexer drift).
 *
 * Heavy: this calls `queryFilter` against `PolicyTriggered(productId, policyId)`
 * — only invoked for policies whose `triggered` flag is already `true` from
 * the on-chain record, so the cost is bounded to one log scan per such read.
 */
async function resolveTriggerMetadata(
  productId: string,
  policyId: bigint
): Promise<{ triggeredAt: string | null; bondId: string | null }> {
  try {
    const filter = policyManager.filters.PolicyTriggered(productId, policyId);
    const events = await policyManager.queryFilter(filter);
    if (events.length === 0) return { triggeredAt: null, bondId: null };
    const ev = events[0];

    let triggeredAt: string | null = null;
    const block = await provider.getBlock(ev.blockNumber);
    if (block) triggeredAt = String(block.timestamp);

    // Bond was minted in the same tx — scan its receipt logs for BondIssued.
    let bondId: string | null = null;
    const receipt = await provider.getTransactionReceipt(ev.transactionHash);
    if (receipt) {
      const bondVaultAddr = (bondVault.target as string).toLowerCase();
      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() === bondVaultAddr &&
          log.topics[0] === BOND_ISSUED_TOPIC
        ) {
          // BondIssued(address indexed to, uint256 indexed epochId, uint256 usdAmount)
          bondId = BigInt(log.topics[2]).toString();
          break;
        }
      }
    }
    return { triggeredAt, bondId };
  } catch (e) {
    logger.warn({ err: e, productId, policyId: policyId.toString() }, "trigger metadata lookup failed");
    return { triggeredAt: null, bondId: null };
  }
}

export async function getPolicy(productId: string, policyId: bigint): Promise<PolicyOnChain | undefined> {
  // PolicyManagerV2.PolicyRecord layout (verified against src/core/PolicyManagerV2.sol):
  //   0: bytes32 productId      | 5: uint256 premiumPaid
  //   1: address shield         | 6: uint256 createdAt
  //   2: address buyer          | 7: uint256 expiresAt
  //   3: uint256 coverageAmount | 8: bool    triggered
  //   4: uint256 payoutAmount   | 9: bool    expired
  const r = await policyManager.policies(productId, policyId);
  const buyer = r[2] as string;
  if (buyer === "0x0000000000000000000000000000000000000000") return undefined;

  // Parallel reads of secondary fields to keep latency flat.
  const [productActiveRaw, priceSnapshotRaw, shieldInfo] = await Promise.all([
    policyManager.productActive(productId) as Promise<boolean>,
    policyManager.policyPriceSnapshot(productId, policyId) as Promise<bigint>,
    // Shield is per-product. `r[1]` is the shield address from the record.
    (async () => {
      try {
        return await getShield(r[1] as string).getPolicyInfo(policyId);
      } catch (e) {
        logger.warn({ err: e, shield: r[1], policyId: policyId.toString() }, "shield getPolicyInfo failed");
        return undefined;
      }
    })(),
  ]);

  const triggered = Boolean(r[8]);
  const expired = Boolean(r[9]);

  // PolicyManagerV2 records `triggered`/`expired` flags only — no explicit
  // "Cancelled" flag. We derive a frontend-friendly status string from the
  // available fields + the Shield's waiting period.
  let status: PolicyStatus;
  if (triggered) status = "Triggered";
  else if (expired) status = "Expired";
  else {
    const nowSec = Math.floor(Date.now() / 1000);
    const waitingEndsRaw = shieldInfo
      ? Number(shieldInfo.waitingEndsAt ?? shieldInfo[6])
      : 0;
    status = nowSec < waitingEndsRaw ? "Waiting" : "Active";
  }

  const waitingEndsAt = shieldInfo
    ? (shieldInfo.waitingEndsAt ?? shieldInfo[6]).toString()
    : null;

  // Trigger metadata is best-effort; only fetched when the on-chain record
  // says the policy was triggered.
  const { triggeredAt, bondId } = triggered
    ? await resolveTriggerMetadata(productId, policyId)
    : { triggeredAt: null, bondId: null };

  return {
    productId: r[0],
    productName: getProductName(r[0] as string),
    policyId: policyId.toString(),
    shield: r[1],
    buyer,
    holder: buyer,
    coverageAmount: r[3].toString(),
    payoutAmount: r[4].toString(),
    premiumPaid: r[5].toString(),
    purchasedAt: r[6].toString(),
    createdAt: r[6].toString(),
    waitingEndsAt,
    expiresAt: r[7].toString(),
    status,
    triggered,
    expired,
    productActive: Boolean(productActiveRaw),
    priceSnapshot: priceSnapshotRaw.toString(),
    triggeredAt,
    bondId,
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
