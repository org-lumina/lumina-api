import { onchainTable } from "ponder";

/**
 * LUMINA Ponder schema — Sprint "Ponder revival".
 *
 * Tables map 1:1 to the real V5.4 on-chain events (verified against the
 * committed ABIs in ./abis). Field names match the Solidity event args so the
 * handlers in src/index.ts stay a thin `event → row` translation.
 *
 *   policy            ← CoverRouterV2.PolicyPurchased
 *   trigger           ← CoverRouterV2.TriggerSubmitted
 *   bond              ← BondVault.BondIssued / .BondRedeemed
 *   burn              ← TWAPBurner.BurnExecuted
 *   marketplaceListing← LuminaBondMarketplace.Listed / .Cancelled / .Bought
 *   vestingClaim      ← FounderVesting.TrancheReleased
 *
 * All timestamps are bigint Unix seconds (EVM `block.timestamp`).
 * Primary key convention for append-only event rows: `${txHash}-${logIndex}`
 * (unique per emitted log, reorg-safe). Mutable rows keyed by their on-chain
 * id (policyId / listingId) so later events can update() them in place.
 */

// CoverRouterV2.PolicyPurchased(productId*, policyId*, buyer*, coverage,
//   premium, payout, paidBy). Keyed by policyId so TriggerSubmitted can flip
//   the status in place.
export const policy = onchainTable("policy", (t) => ({
  id: t.text().primaryKey(), // policyId as decimal string
  policyId: t.bigint().notNull(),
  productId: t.text().notNull(),
  buyer: t.text().notNull(),
  coverage: t.bigint().notNull(),
  premium: t.bigint().notNull(),
  payout: t.bigint().notNull(),
  paidBy: t.text().notNull(),
  status: t.text().notNull(), // "active" | "triggered"
  triggeredTxHash: t.text(),
  triggeredAt: t.bigint(),
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

// CoverRouterV2.TriggerSubmitted(productId*, policyId*, submitter).
export const trigger = onchainTable("trigger", (t) => ({
  id: t.text().primaryKey(), // `${txHash}-${logIndex}`
  policyId: t.bigint().notNull(),
  productId: t.text().notNull(),
  submitter: t.text().notNull(),
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

// BondVault.BondIssued(to*, epochId*, usdAmount) and
// BondVault.BondRedeemed(holder*, epochId*, usdAmount, luminaAmount, priceUsed).
// Append-only ledger of bond movements; net holdings are computed at query
// time by summing issued − redeemed per (owner, epochId).
export const bond = onchainTable("bond", (t) => ({
  id: t.text().primaryKey(), // `${txHash}-${logIndex}`
  kind: t.text().notNull(), // "issued" | "redeemed"
  owner: t.text().notNull(),
  epochId: t.bigint().notNull(),
  usdAmount: t.bigint().notNull(), // ERC-1155 units (1 unit = $1 face)
  luminaAmount: t.bigint(), // redeemed only
  maturityAt: t.bigint().notNull(),
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

// TWAPBurner.BurnExecuted(usdcSpent, luminaBurned, effectivePrice, timestamp).
export const burn = onchainTable("burn", (t) => ({
  id: t.text().primaryKey(), // `${txHash}-${logIndex}`
  usdcSpent: t.bigint().notNull(),
  luminaBurned: t.bigint().notNull(),
  effectivePriceUsdc: t.bigint().notNull(),
  source: t.text().notNull(), // "TWAPBurner"
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.text().notNull(),
}));

// LuminaBondMarketplace.Listed / .Cancelled / .Bought. Keyed by listingId so
// Cancelled/Bought update the same row in place.
export const marketplaceListing = onchainTable("marketplace_listing", (t) => ({
  id: t.text().primaryKey(), // listingId as decimal string
  listingId: t.bigint().notNull(),
  seller: t.text().notNull(),
  epochId: t.bigint().notNull(),
  amount: t.bigint().notNull(),
  priceUsdc: t.bigint().notNull(),
  status: t.text().notNull(), // "active" | "cancelled" | "filled"
  createdAtBlock: t.bigint().notNull(),
  createdTxHash: t.text().notNull(),
  createdAt: t.bigint().notNull(),
  filledBy: t.text(),
  sellerFee: t.bigint(),
  buyerFee: t.bigint(),
  filledAtBlock: t.bigint(),
  filledTxHash: t.text(),
}));

// FounderVesting.TrancheReleased(trancheNumber, amount, recipient).
export const vestingClaim = onchainTable("vesting_claim", (t) => ({
  id: t.text().primaryKey(),
  recipient: t.text().notNull(),
  vestingType: t.text().notNull(),
  trancheNumber: t.integer().notNull(),
  amount: t.bigint().notNull(),
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));
