import { ponder } from "ponder:registry";
import { policy, bond, burn, trigger, vestingClaim } from "ponder:schema";

/**
 * Sprint J — handlers stub.
 *
 * 5 of the highest-value events are wired below. Each handler is a thin
 * `event → row` translator; aggregations (volume, lag, holder counts) are
 * computed at query time in the API layer, not pre-aggregated here.
 *
 * To add an event:
 *   1. Append the table to `ponder.schema.ts`.
 *   2. Add the contract+abi to `ponder.config.ts`.
 *   3. Add an `ponder.on("Contract:Event", ...)` block here.
 *   4. Run `npm run codegen` to regenerate type bindings.
 *
 * The `id` convention is `${event.transaction.hash}-${event.log.logIndex}` —
 * unique per emitted log even across reorgs.
 */

// ─────────────────── 1. CoverRouterV2.PolicyPurchased ───────────────────
ponder.on("CoverRouterV2:PolicyPurchased", async ({ event, context }) => {
  await context.db.insert(policy).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    // Cast args to any until we drop in the real ABI — Ponder generates the
    // strict types from the JSON, but the field names match the Solidity
    // event signature (CoverRouterV2.sol:90 `PolicyPurchased(uint256 indexed
    // policyId, address indexed buyer, bytes32 productId, address shield,
    // uint256 coverageAmount, uint256 premium, uint256 expiresAt)`).
    policyId: (event.args as any).policyId as bigint,
    buyer: (event.args as any).buyer as string,
    shield: (event.args as any).shield as string,
    productId: (event.args as any).productId as string,
    premium: (event.args as any).premium as bigint,
    coverageAmount: (event.args as any).coverageAmount as bigint,
    expiresAt: (event.args as any).expiresAt as bigint,
    status: "active",
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});

// ─────────────────── 2a. BondVault.BondIssued ───────────────────
ponder.on("BondVault:BondIssued", async ({ event, context }) => {
  // BondVault.sol:35 `event BondIssued(address indexed to, uint256 indexed
  // epochId, uint256 usdAmount)`. Maturity computed off-chain from epochId
  // (epoch 202806 → maturity = first day of June 2028).
  const maturityAt = epochToMaturityTimestamp((event.args as any).epochId as bigint);
  await context.db.insert(bond).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    owner: (event.args as any).to as string,
    epochId: (event.args as any).epochId as bigint,
    amount: (event.args as any).usdAmount as bigint,
    faceValueUsd: ((event.args as any).usdAmount as bigint) * 10n ** 18n,
    issuedAt: event.block.timestamp,
    maturityAt,
    redeemed: false,
    redeemedAt: null,
    txHash: event.transaction.hash,
  });
});

// ─────────────────── 2b. BondVault.BondRedeemed ───────────────────
ponder.on("BondVault:BondRedeemed", async ({ event, context }) => {
  // BondRedeemed flips the `redeemed` flag on the matching bond row(s).
  // For now we insert a redemption record; matching to issuance is left as
  // a query-time JOIN keyed by (owner, epochId). The skeleton intentionally
  // skips the update path — Phase 2 follow-up will add it via Ponder's
  // `update()` once the matching is verified.
  await context.db.insert(bond).values({
    id: `${event.transaction.hash}-${event.log.logIndex}-redeem`,
    owner: (event.args as any).from as string,
    epochId: (event.args as any).epochId as bigint,
    amount: (event.args as any).usdAmount as bigint,
    faceValueUsd: ((event.args as any).usdAmount as bigint) * 10n ** 18n,
    issuedAt: 0n,
    maturityAt: 0n,
    redeemed: true,
    redeemedAt: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

// ─────────────────── 3. TWAPBurner.BurnExecuted ───────────────────
ponder.on("TWAPBurner:BurnExecuted", async ({ event, context }) => {
  // TWAPBurner.sol — `event BurnExecuted(uint256 usdcSpent, uint256
  // luminaBurned, uint256 effectivePrice, uint256 timestamp)`.
  await context.db.insert(burn).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    usdcSpent: (event.args as any).usdcSpent as bigint,
    luminaBurned: (event.args as any).luminaBurned as bigint,
    effectivePriceUsdc: (event.args as any).effectivePrice as bigint,
    source: "TWAPBurner",
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

// ─────────────────── 4. CoverRouterV2.TriggerSubmitted ───────────────────
ponder.on("CoverRouterV2:TriggerSubmitted", async ({ event, context }) => {
  // CoverRouterV2.sol — `event TriggerSubmitted(uint256 indexed policyId,
  // address indexed shield, address indexed submittedBy)`.
  // Status starts as "submitted"; gets updated when settlement events fire.
  await context.db.insert(trigger).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    policyId: (event.args as any).policyId as bigint,
    shield: (event.args as any).shield as string,
    submittedBy: (event.args as any).submittedBy as string,
    status: "submitted",
    payoutAmount: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
  });
});

// ─────────────────── 5. FounderVesting.TrancheReleased ───────────────────
// FounderVesting.sol:73 emits `TrancheReleased(uint256 trancheNumber,
// uint256 amount, address recipient)` on each of the 3 tranche releases
// (31 days apart after AltSeason trigger).
ponder.on("FounderVesting:TrancheReleased", async ({ event, context }) => {
  await context.db.insert(vestingClaim).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    recipient: (event.args as any).recipient as string,
    vestingType: "founder",
    trancheNumber: Number((event.args as any).trancheNumber),
    amount: (event.args as any).amount as bigint,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  });
});

// ─────────────────── helpers ───────────────────

/**
 * Convert a YYYYMM-format epoch id to its maturity Unix timestamp. Epoch IDs
 * follow `year * 100 + month` convention (e.g. 202806 → June 2028). Maturity
 * is the first second of that month UTC.
 */
function epochToMaturityTimestamp(epochId: bigint): bigint {
  const year = Number(epochId / 100n);
  const month = Number(epochId % 100n);
  return BigInt(Math.floor(Date.UTC(year, month - 1, 1) / 1000));
}
