import type { LogDescription } from "ethers";
import { marketplace, provider } from "../utils/ethers";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";

export interface VerifyBuyInput {
  txHash: string;
  listingId: string;
  buyerAddress: string;
  amount: string;
  totalPaidUsdc: string;
  // Listing fields read from the local DB pre-check (source of truth for
  // amount, seller and bondId — the on-chain `Bought` event omits them).
  listingSeller: string;
  listingBondId: string;
  listingAmount: string;
}

export interface VerifiedBuy {
  txHash: string;
  listingId: string;
  buyerAddress: string;
  sellerAddress: string;
  bondId: string;
  amount: string;
  totalPaidUsdc: string;
  blockNumber: number;
  blockTimestamp: number; // seconds since epoch
}

/**
 * Verify a `LuminaBondMarketplace.executeBuy(listingId)` transaction.
 *
 * On-chain `Bought(listingId, buyer, seller, priceUSDC, sellerFee, buyerFee)`
 * gives us listingId / buyer / seller / priceUSDC. The buyer's actual USDC
 * outflow is `priceUSDC + buyerFee` (the marketplace's fee model from
 * `executeBuy`). The body's `totalPaidUsdc` MUST equal this derivation.
 *
 * Listing-level fields (amount, bondId, seller authoritative source) come
 * from the DB row populated by /marketplace/list (A.1.5) — `Bought` does
 * not re-emit them.
 */
export async function verifyBuy(input: VerifyBuyInput): Promise<VerifiedBuy> {
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
  if ((receipt.from ?? "").toLowerCase() !== input.buyerAddress.toLowerCase()) {
    throw new HttpError(403, "Buyer mismatch — txHash sender is not buyerAddress", "buyer_mismatch");
  }

  const iface = marketplace.interface;
  const eventFragment = iface.getEvent("Bought");
  if (!eventFragment) {
    throw new HttpError(500, "Bought event missing from ABI", "abi_misconfigured");
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
    throw new HttpError(400, "Bought event not found in tx logs", "event_missing");
  }

  const evListingId = parsed.args.listingId.toString();
  const evBuyer = String(parsed.args.buyer).toLowerCase();
  const evSeller = String(parsed.args.seller).toLowerCase();
  const evPriceUSDC: bigint = parsed.args.priceUSDC;
  const evBuyerFee: bigint = parsed.args.buyerFee;

  if (evListingId !== input.listingId) {
    throw new HttpError(400, "Event listingId does not match request", "listing_id_mismatch");
  }
  if (evBuyer !== input.buyerAddress.toLowerCase()) {
    throw new HttpError(403, "Event buyer does not match buyerAddress", "buyer_mismatch");
  }
  if (evSeller !== input.listingSeller.toLowerCase()) {
    throw new HttpError(409, "Event seller does not match the recorded listing seller", "seller_mismatch");
  }

  // Body amount must match the listing record. Marketplace.executeBuy is
  // an "all-or-nothing" fill — partial buys are not supported in V5.1.
  if (input.amount !== input.listingAmount) {
    throw new HttpError(
      400,
      `Body amount (${input.amount}) does not match listing amount (${input.listingAmount})`,
      "amount_mismatch"
    );
  }

  // [V5.1 fee model] totalPaid = listing.priceUSDC + buyerFee.
  const expectedTotalPaid = (evPriceUSDC + evBuyerFee).toString();
  if (input.totalPaidUsdc !== expectedTotalPaid) {
    throw new HttpError(
      400,
      `Body totalPaidUsdc (${input.totalPaidUsdc}) does not equal priceUSDC + buyerFee (${expectedTotalPaid})`,
      "price_mismatch"
    );
  }

  // Block timestamp for response.executedAt
  let blockTimestamp = 0;
  try {
    const block = await provider.getBlock(receipt.blockNumber);
    if (block) blockTimestamp = Number(block.timestamp);
  } catch (e) {
    logger.warn({ err: e, blockNumber: receipt.blockNumber }, "getBlock failed; executedAt may be 0");
  }

  return {
    txHash: input.txHash,
    listingId: evListingId,
    buyerAddress: input.buyerAddress,
    sellerAddress: input.listingSeller,
    bondId: input.listingBondId,
    amount: input.amount,
    totalPaidUsdc: input.totalPaidUsdc,
    blockNumber: receipt.blockNumber,
    blockTimestamp,
  };
}
