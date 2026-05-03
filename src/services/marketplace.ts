import type { LogDescription } from "ethers";
import { marketplace, provider } from "../utils/ethers";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";

export interface VerifyListingInput {
  txHash: string;
  sellerAddress: string;
  bondId: string;          // alias of epochId on-chain
  amount: string;
  totalPriceUsdc: string;
}

export interface VerifiedListing {
  txHash: string;
  listingId: string;
  sellerAddress: string;
  bondId: string;
  amount: string;
  totalPriceUsdc: string;
  blockNumber: number;
  blockTimestamp: number;  // seconds since epoch
}

/**
 * Verify a `LuminaBondMarketplace.list(...)` transaction submitted by an
 * end-user wallet (verifier pattern, mirrors services/redeem.ts).
 *
 * - Receipt must be confirmed and target the marketplace contract.
 * - `Listed(listingId, seller, epochId, amount, priceUSDC)` event in the
 *   receipt logs is the source of truth — body fields must match.
 * - [V5.1 M-3] Body's per-unit price must satisfy the on-chain anti-spam
 *   floor (`marketplace.minPricePerUnit()`). Defense-in-depth: if the tx
 *   succeeded the on-chain require already passed, but a body that lies
 *   would be caught here regardless.
 */
export async function verifyListing(input: VerifyListingInput): Promise<VerifiedListing> {
  const marketplaceAddr = (marketplace.target as string).toLowerCase();

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(input.txHash);
  } catch {
    throw new HttpError(502, "RPC error fetching receipt", "rpc_error");
  }
  if (!receipt) {
    throw new HttpError(400, "Tx not found", "tx_not_found");
  }
  if (receipt.status !== 1) {
    throw new HttpError(400, "Tx reverted on-chain", "tx_reverted");
  }
  if ((receipt.to ?? "").toLowerCase() !== marketplaceAddr) {
    throw new HttpError(400, "Tx is not a Marketplace call", "tx_not_marketplace");
  }
  if ((receipt.from ?? "").toLowerCase() !== input.sellerAddress.toLowerCase()) {
    throw new HttpError(403, "Seller mismatch — txHash sender is not sellerAddress", "seller_mismatch");
  }

  const iface = marketplace.interface;
  const eventFragment = iface.getEvent("Listed");
  if (!eventFragment) {
    throw new HttpError(500, "Listed event missing from ABI", "abi_misconfigured");
  }
  const eventTopic = eventFragment.topicHash;

  let parsed: LogDescription | null = null;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === marketplaceAddr &&
      log.topics[0] === eventTopic
    ) {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) break;
    }
  }
  if (!parsed) {
    throw new HttpError(400, "Listed event not found in tx logs", "event_missing");
  }

  const evListingId = parsed.args.listingId.toString();
  const evSeller = String(parsed.args.seller).toLowerCase();
  const evEpochId = parsed.args.epochId.toString();
  const evAmount = parsed.args.amount.toString();
  const evPrice = parsed.args.priceUSDC.toString();

  if (evSeller !== input.sellerAddress.toLowerCase()) {
    throw new HttpError(403, "Event seller does not match sellerAddress", "seller_mismatch");
  }
  if (evEpochId !== input.bondId) {
    throw new HttpError(400, "Event bondId/epochId does not match request", "bond_id_mismatch");
  }
  if (evAmount !== input.amount) {
    throw new HttpError(400, "Event amount does not match request", "amount_mismatch");
  }
  if (evPrice !== input.totalPriceUsdc) {
    throw new HttpError(400, "Event totalPrice does not match request", "price_mismatch");
  }

  // [V5.1 M-3] Anti-spam floor — totalPriceUsdc / amount >= minPricePerUnit.
  // Done after event verification so body and chain are already aligned;
  // this catches any oracle/admin race that lowered the floor between
  // the seller's prep and our recording.
  const amountBn = BigInt(input.amount);
  if (amountBn === 0n) {
    throw new HttpError(400, "Amount must be > 0", "invalid_amount");
  }
  let minPricePerUnit: bigint;
  try {
    minPricePerUnit = await marketplace.minPricePerUnit();
  } catch (e) {
    logger.warn({ err: e }, "minPricePerUnit lookup failed; falling back to DEFAULT_MIN_PRICE_PER_UNIT");
    minPricePerUnit = 1_000_000n; // DEFAULT_MIN_PRICE_PER_UNIT (1 USDC, 6 decimals)
  }
  const pricePerUnit = BigInt(input.totalPriceUsdc) / amountBn;
  if (pricePerUnit < minPricePerUnit) {
    throw new HttpError(
      400,
      `Listing price below M-3 floor: ${pricePerUnit} < ${minPricePerUnit} per unit`,
      "price_below_min"
    );
  }

  // Block timestamp for the response's `createdAt` ISO field.
  let blockTimestamp = 0;
  try {
    const block = await provider.getBlock(receipt.blockNumber);
    if (block) blockTimestamp = Number(block.timestamp);
  } catch (e) {
    logger.warn({ err: e, blockNumber: receipt.blockNumber }, "getBlock failed; createdAt may be 0");
  }

  return {
    txHash: input.txHash,
    listingId: evListingId,
    sellerAddress: input.sellerAddress,
    bondId: evEpochId,
    amount: evAmount,
    totalPriceUsdc: evPrice,
    blockNumber: receipt.blockNumber,
    blockTimestamp,
  };
}
