import { onchainTable } from "ponder";

/**
 * Sprint J skeleton — 5 tables for the highest-value events:
 *   1. policy            ← CoverRouterV2.PolicyPurchased
 *   2. bond              ← BondVault.BondIssued + .BondRedeemed
 *   3. burn              ← TWAPBurner.BurnExecuted
 *   4. trigger           ← CoverRouterV2.TriggerSubmitted (post-Sprint J expansion)
 *   5. vestingClaim      ← FounderVesting.TrancheReleased (stubbed until ABI added)
 *
 * Other tables (marketplace, USDC flows, oracle observability, capacity ops)
 * are listed in `Fase 2 Hardening` follow-up checklist items — they require
 * either new contract events that don't yet exist or new ABIs to be wired.
 *
 * All timestamps stored as bigint (Unix seconds, EVM `block.timestamp`).
 */

export const policy = onchainTable("policy", (t) => ({
  // `txHash-logIndex` is the canonical primary key Ponder recommends for
  // event-sourced rows — guarantees uniqueness even on reorgs.
  id: t.text().primaryKey(),
  policyId: t.bigint().notNull(),
  buyer: t.text().notNull(),
  shield: t.text().notNull(),
  productId: t.text().notNull(),
  premium: t.bigint().notNull(),
  coverageAmount: t.bigint().notNull(),
  expiresAt: t.bigint().notNull(),
  status: t.text().notNull(), // "active" | "expired" | "triggered"
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const bond = onchainTable("bond", (t) => ({
  id: t.text().primaryKey(),
  owner: t.text().notNull(),
  epochId: t.bigint().notNull(),
  amount: t.bigint().notNull(), // ERC1155 token amount (1 unit = $1 USD claim)
  faceValueUsd: t.bigint().notNull(), // amount * 1e18 (kept for analytics convenience)
  issuedAt: t.bigint().notNull(),
  maturityAt: t.bigint().notNull(),
  redeemed: t.boolean().notNull(),
  redeemedAt: t.bigint(),
  txHash: t.text().notNull(),
}));

export const burn = onchainTable("burn", (t) => ({
  id: t.text().primaryKey(),
  usdcSpent: t.bigint().notNull(),
  luminaBurned: t.bigint().notNull(),
  effectivePriceUsdc: t.bigint().notNull(), // USDC per LUMINA, wei units
  source: t.text().notNull(), // "TWAPBurner" | "BuybackEngine"
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.text().notNull(),
}));

export const trigger = onchainTable("trigger", (t) => ({
  id: t.text().primaryKey(),
  policyId: t.bigint().notNull(),
  shield: t.text().notNull(),
  submittedBy: t.text().notNull(),
  status: t.text().notNull(), // "submitted" | "executed" | "rejected"
  payoutAmount: t.bigint(),
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
}));

export const vestingClaim = onchainTable("vesting_claim", (t) => ({
  id: t.text().primaryKey(),
  recipient: t.text().notNull(),
  vestingType: t.text().notNull(), // "founder" | "treasury"
  trancheNumber: t.integer().notNull(),
  amount: t.bigint().notNull(),
  txHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));
