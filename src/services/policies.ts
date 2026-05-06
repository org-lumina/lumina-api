import { ethers } from "ethers";
import {
  bondVault,
  coverRouter,
  coverRouterRelayer,
  getGlobalPauseRegistry,
  getShield,
  policyManager,
  provider,
  relayer,
  usdc,
} from "../utils/ethers";
import { getProductName } from "../utils/productNames";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";

/**
 * On-chain CoverRouterV2 enforces `coverageAmount >= 100e6` ($100 USDC).
 * Mirrored here so we can return a clean 400 instead of an opaque
 * `InvalidCoverage` revert (selector 0x2340cc3a).
 */
export const MIN_COVERAGE_USDC = 100_000_000n; // $100 in USDC base units (6 decimals)

/**
 * Custom-error decoder for purchase reverts.
 *
 * Maps the 4-byte selectors raised by CoverRouterV2 / PolicyManagerV2 to
 * human-readable messages. Pre-flights catch most of these before submission,
 * but a stale read (e.g. product flipped inactive between preflight and tx)
 * can still surface them — and an undecoded selector is the worst dev-UX bug
 * found in the 10/10 verification report.
 *
 * Returns `undefined` when the selector is unknown so the caller falls back
 * to the raw ethers message.
 */
const KNOWN_REVERT_SELECTORS: Record<string, string> = {
  "0x2340cc3a": `InvalidCoverage — coverage amount is below the on-chain minimum (${MIN_COVERAGE_USDC} base units = $100). Send a coverageAmount of at least ${MIN_COVERAGE_USDC}.`,
  "0x6d417ea4": "ProductNotConfigured — productId is not configured on CoverRouter. Check GET /api/v1/products for valid productIds.",
  "0x5d042eb9": "ProductInactive — product is configured but currently disabled. Try again later or pick a different product.",
  "0xacf52825": "NotAuthorizedRelayer — relayer wallet is not authorized on CoverRouter. Owner must call setRelayer(relayer, true).",
  "0xab35696f": "ContractPaused — CoverRouter is paused (local circuit breaker). Try again later.",
  // Solady / OZ ERC20 errors
  "0xfb8f41b2": "ERC20InsufficientAllowance — buyer must approve(coverRouter, amount) first. Use the SDK helper: lumina.policies.ensureAllowance(buyer, premium).",
  "0xe450d38c": "ERC20InsufficientBalance — buyer wallet has less USDC than the premium. Top up at the testnet faucet.",
  "0x5274afe7": "SafeERC20FailedOperation — USDC transfer failed (insufficient allowance or balance).",
  "0xb12d13eb": "GloballyPaused — protocol-wide kill switch is active. All purchases temporarily disabled.",
  // PolicyManager
  "0xb9780c7f": "ProductNotFound — productId not registered with PolicyManager.",
  "0xaa62be1a": "ProductNotActive — product flag is currently inactive at the policy-manager level.",
  "0x1040f089": "InsufficientCapacity — coverage exceeds remaining product capacity. Pick a smaller cover amount.",
};

export function decodeRevertMessage(err: unknown): string | undefined {
  if (!err) return undefined;
  const e = err as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  // ethers v6 wraps revert data variously across providers
  const candidates: string[] = [];
  for (const v of [e.data, e.info?.error?.data, e.error?.data]) {
    if (typeof v === "string") candidates.push(v);
    else if (v && typeof v === "object" && "data" in v && typeof (v as { data: unknown }).data === "string") {
      candidates.push((v as { data: string }).data);
    }
  }
  // also scan stringified message for "0x........" that looks like custom-error data
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/0x[0-9a-fA-F]{8,}/);
  if (m) candidates.push(m[0]);

  for (const data of candidates) {
    const sel = data.slice(0, 10).toLowerCase();
    const human = KNOWN_REVERT_SELECTORS[sel];
    if (human) return human;
  }
  return undefined;
}

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
  /**
   * [V5.1 H-6] LUMINA/USD price snapshot (18-dec) recorded at `recordPolicy`
   * time. When the policy triggers, BondVault uses this price to issue the
   * bond — protecting the buyer from oracle drift between purchase and trigger.
   * `"0"` when not yet set (e.g. legacy V5.0 policies stored before H-6).
   */
  priceSnapshot: string;
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

  // [10x10 fix C-1] Pre-flight: coverage minimum. CoverRouterV2._purchase
  // reverts with `InvalidCoverage(amount)` (0x2340cc3a) when coverageAmount
  // is below 100e6. Catching it here avoids the opaque on-chain revert that
  // blocked every first integration in the verification report.
  if (input.coverageAmount < MIN_COVERAGE_USDC) {
    throw new HttpError(
      400,
      `coverageAmount ${input.coverageAmount} is below the on-chain minimum (${MIN_COVERAGE_USDC} = $100). Send at least ${MIN_COVERAGE_USDC}.`,
      "coverage_below_minimum"
    );
  }

  // [10x10 fix C-1] Pre-flight: product must be configured on CoverRouter.
  // `products(productId).durationSeconds == 0` means unconfigured — reverts
  // with `ProductNotConfigured(productId)` on submission. Returning 404
  // matches the API style for "unknown resource".
  const config = await coverRouter.products(input.productId);
  const durationSeconds: bigint = (config.durationSeconds ?? config[4]) as bigint;
  if (durationSeconds === undefined || BigInt(durationSeconds) === 0n) {
    throw new HttpError(
      404,
      `Product ${input.productId} is not configured on CoverRouter. List available products at GET /api/v1/products.`,
      "product_not_found"
    );
  }

  // [10x10 fix C-1] Compute the premium (read-only) so we can preflight the
  // buyer's USDC balance + allowance. Same formula the contract uses.
  const quote = await coverRouter.quotePremium(input.productId, input.coverageAmount);
  const premium: bigint = BigInt(quote.premium ?? quote[0]);

  // [10x10 fix C-1] Pre-flight: buyer USDC balance >= premium.
  const buyerBalance: bigint = await usdc.balanceOf(input.buyer);
  if (buyerBalance < premium) {
    throw new HttpError(
      400,
      `Buyer ${input.buyer} has ${buyerBalance} USDC base units; needs ${premium} for this purchase. Top up at the testnet faucet.`,
      "insufficient_balance"
    );
  }

  // [10x10 fix C-1] Pre-flight: buyer USDC allowance for CoverRouter >= premium.
  // The docs explicitly promise this preflight; before this fix, an unapproved
  // wallet got a raw `tx_submit_failed` with no hint.
  const coverRouterAddr = (coverRouter.target ?? (coverRouter as { address?: string }).address) as string;
  const buyerAllowance: bigint = await usdc.allowance(input.buyer, coverRouterAddr);
  if (buyerAllowance < premium) {
    throw new HttpError(
      400,
      `Buyer must approve CoverRouter to spend USDC. Required allowance: ${premium}; current: ${buyerAllowance}. Call: usdc.approve("${coverRouterAddr}", MaxUint256). Or use the SDK helper: lumina.policies.ensureAllowance(buyer, premium).`,
      "insufficient_allowance"
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
    // [10x10 fix C-1] Decode known custom-error selectors so the caller gets a
    // human-readable message instead of "execution reverted (unknown custom error)".
    const decoded = decodeRevertMessage(e);
    const raw = e instanceof Error ? e.message : String(e);
    throw new HttpError(
      400,
      decoded ? `Transaction submission failed: ${decoded}` : `Transaction submission failed: ${raw}`,
      decoded ? "tx_submit_failed_decoded" : "tx_submit_failed"
    );
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
