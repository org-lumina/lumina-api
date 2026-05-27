import { ponder } from "ponder:registry";
import { policy, bond, burn, trigger, marketplaceListing, vestingClaim } from "ponder:schema";

/**
 * LUMINA event handlers — Sprint "Ponder revival".
 *
 * Every `event.args.*` reference below is verified against the committed ABIs
 * in ./abis (so `ponder codegen`/typecheck is authoritative). Append-only rows
 * use `${txHash}-${logIndex}` ids; mutable rows (policy, marketplaceListing)
 * are keyed by their on-chain id so later events update() them in place.
 */

// ─────────────────── CoverRouterV2.PolicyPurchased ───────────────────
// event PolicyPurchased(bytes32 indexed productId, uint256 indexed policyId,
//   address indexed buyer, uint256 coverage, uint256 premium, uint256 payout,
//   address paidBy)
ponder.on("CoverRouterV2:PolicyPurchased", async ({ event, context }) => {
  await context.db.insert(policy).values({
    // policyId is a PER-PRODUCT counter (e.g. BTC24 #1 AND BTC48 #1 both exist),
    // so it is NOT globally unique. Using it alone as the primary key caused a
    // unique-violation on the first cross-product collision, which threw inside
    // the handler and HALTED indexing (Ponder froze at the offending block,
    // event_count=0 thereafter). Key by (productId, policyId) — globally unique.
    id: `${event.args.productId}-${event.args.policyId}`,
    policyId: event.args.policyId,
    productId: event.args.productId,
    buyer: event.args.buyer,
    coverage: event.args.coverage,
    premium: event.args.premium,
    payout: event.args.payout,
    paidBy: event.args.paidBy,
    status: "active",
    triggeredTxHash: null,
    triggeredAt: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  }).onConflictDoNothing();
});

// ─────────────────── CoverRouterV2.TriggerSubmitted ───────────────────
// event TriggerSubmitted(bytes32 indexed productId, uint256 indexed policyId,
//   address submitter)
ponder.on("CoverRouterV2:TriggerSubmitted", async ({ event, context }) => {
  await context.db.insert(trigger).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    policyId: event.args.policyId,
    productId: event.args.productId,
    submitter: event.args.submitter,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  }).onConflictDoNothing();
  // Flip the policy status in place (no-op if the purchase predates startBlock).
  // Same composite key as the PolicyPurchased insert.
  const policyKey = `${event.args.productId}-${event.args.policyId}`;
  const existing = await context.db.find(policy, { id: policyKey });
  if (existing) {
    await context.db.update(policy, { id: policyKey }).set({
      status: "triggered",
      triggeredTxHash: event.transaction.hash,
      triggeredAt: event.block.timestamp,
    });
  }
});

// ─────────────────── BondVault.BondIssued ───────────────────
// event BondIssued(address indexed to, uint256 indexed epochId, uint256 usdAmount)
ponder.on("BondVault:BondIssued", async ({ event, context }) => {
  await context.db.insert(bond).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    kind: "issued",
    owner: event.args.to,
    epochId: event.args.epochId,
    usdAmount: event.args.usdAmount,
    luminaAmount: null,
    maturityAt: epochToMaturityTimestamp(event.args.epochId),
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  }).onConflictDoNothing();
});

// ─────────────────── BondVault.BondRedeemed ───────────────────
// event BondRedeemed(address indexed holder, uint256 indexed epochId,
//   uint256 usdAmount, uint256 luminaAmount, uint256 priceUsed)
ponder.on("BondVault:BondRedeemed", async ({ event, context }) => {
  await context.db.insert(bond).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    kind: "redeemed",
    owner: event.args.holder,
    epochId: event.args.epochId,
    usdAmount: event.args.usdAmount,
    luminaAmount: event.args.luminaAmount,
    maturityAt: epochToMaturityTimestamp(event.args.epochId),
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  }).onConflictDoNothing();
});

// ─────────────────── TWAPBurner.BurnExecuted ───────────────────
// event BurnExecuted(uint256 usdcSpent, uint256 luminaBurned,
//   uint256 effectivePrice, uint256 timestamp)
ponder.on("TWAPBurner:BurnExecuted", async ({ event, context }) => {
  await context.db.insert(burn).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    usdcSpent: event.args.usdcSpent,
    luminaBurned: event.args.luminaBurned,
    effectivePriceUsdc: event.args.effectivePrice,
    source: "TWAPBurner",
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

// ─────────────────── LuminaBondMarketplace.Listed ───────────────────
// event Listed(uint256 indexed listingId, address indexed seller,
//   uint256 indexed epochId, uint256 amount, uint256 priceUSDC)
ponder.on("Marketplace:Listed", async ({ event, context }) => {
  await context.db.insert(marketplaceListing).values({
    id: event.args.listingId.toString(),
    listingId: event.args.listingId,
    seller: event.args.seller,
    epochId: event.args.epochId,
    amount: event.args.amount,
    priceUsdc: event.args.priceUSDC,
    status: "active",
    createdAtBlock: event.block.number,
    createdTxHash: event.transaction.hash,
    createdAt: event.block.timestamp,
    filledBy: null,
    sellerFee: null,
    buyerFee: null,
    filledAtBlock: null,
    filledTxHash: null,
  }).onConflictDoNothing();
});

// ─────────────────── LuminaBondMarketplace.Cancelled ───────────────────
// event Cancelled(uint256 indexed listingId, address indexed seller)
ponder.on("Marketplace:Cancelled", async ({ event, context }) => {
  const id = event.args.listingId.toString();
  const existing = await context.db.find(marketplaceListing, { id });
  if (existing) {
    await context.db.update(marketplaceListing, { id }).set({ status: "cancelled" });
  }
});

// ─────────────────── LuminaBondMarketplace.Bought ───────────────────
// event Bought(uint256 indexed listingId, address indexed buyer,
//   address indexed seller, uint256 priceUSDC, uint256 sellerFee, uint256 buyerFee)
ponder.on("Marketplace:Bought", async ({ event, context }) => {
  const id = event.args.listingId.toString();
  const existing = await context.db.find(marketplaceListing, { id });
  if (existing) {
    await context.db.update(marketplaceListing, { id }).set({
      status: "filled",
      filledBy: event.args.buyer,
      sellerFee: event.args.sellerFee,
      buyerFee: event.args.buyerFee,
      filledAtBlock: event.block.number,
      filledTxHash: event.transaction.hash,
    });
  }
});

// ─────────────────── FounderVesting.TrancheReleased ───────────────────
// event TrancheReleased(uint256 trancheNumber, uint256 amount, address recipient)
ponder.on("FounderVesting:TrancheReleased", async ({ event, context }) => {
  await context.db.insert(vestingClaim).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    recipient: event.args.recipient,
    vestingType: "founder",
    trancheNumber: Number(event.args.trancheNumber),
    amount: event.args.amount,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  }).onConflictDoNothing();
});

// ─────────────────── helpers ───────────────────

/**
 * Convert a YYYYMM epoch id to its maturity Unix timestamp (first second of
 * that month, UTC). e.g. 202806 → 1 June 2028 00:00:00Z.
 */
function epochToMaturityTimestamp(epochId: bigint): bigint {
  const year = Number(epochId / 100n);
  const month = Number(epochId % 100n);
  return BigInt(Math.floor(Date.UTC(year, month - 1, 1) / 1000));
}
