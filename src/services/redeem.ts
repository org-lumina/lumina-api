import type { LogDescription } from "ethers";
import { provider, bondVault } from "../utils/ethers";
import { HttpError } from "../middlewares/error";

export interface VerifyInput {
  epochId: string;
  usdAmount: string;
  txHash: string;
  ownerAddress: string;
}

export interface VerifiedRedemption {
  epochId: string;
  ownerAddress: string;
  usdAmount: string;
  luminaReceived: string;
  priceUsed: string;
  blockNumber: number;
  txHash: string;
}

/**
 * Verify a `BondVault.redeemBond` transaction submitted by an end-user wallet.
 *
 * Verifier pattern (Option C): the API never broadcasts the tx — the agent /
 * owner submits it from their own wallet, then calls this endpoint with the
 * resulting `txHash`. We confirm the on-chain effect against the receipt and
 * the `BondRedeemed` event and return the verified parameters.
 */
export async function verifyRedemption(input: VerifyInput): Promise<VerifiedRedemption> {
  const bondVaultAddress = (bondVault.target as string).toLowerCase();

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
  if ((receipt.to ?? "").toLowerCase() !== bondVaultAddress) {
    throw new HttpError(400, "Tx is not a BondVault call", "tx_not_bond_vault");
  }
  if ((receipt.from ?? "").toLowerCase() !== input.ownerAddress.toLowerCase()) {
    throw new HttpError(403, "Owner mismatch — txHash sender is not ownerAddress", "owner_mismatch");
  }

  const iface = bondVault.interface;
  const eventFragment = iface.getEvent("BondRedeemed");
  if (!eventFragment) {
    throw new HttpError(500, "BondRedeemed event missing from ABI", "abi_misconfigured");
  }
  const eventTopic = eventFragment.topicHash;

  let parsed: LogDescription | null = null;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === bondVaultAddress &&
      log.topics[0] === eventTopic
    ) {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) break;
    }
  }

  if (!parsed) {
    throw new HttpError(400, "BondRedeemed event not found in tx logs", "event_missing");
  }

  const evHolder = String(parsed.args.holder).toLowerCase();
  const evEpochId = parsed.args.epochId.toString();
  const evUsdAmount = parsed.args.usdAmount.toString();
  const evLuminaAmount = parsed.args.luminaAmount.toString();
  const evPriceUsed = parsed.args.priceUsed.toString();

  if (evHolder !== input.ownerAddress.toLowerCase()) {
    throw new HttpError(403, "Event holder does not match ownerAddress", "holder_mismatch");
  }
  if (evEpochId !== input.epochId) {
    throw new HttpError(400, "Event epochId does not match request", "epoch_mismatch");
  }
  if (evUsdAmount !== input.usdAmount) {
    throw new HttpError(400, "Event usdAmount does not match request", "amount_mismatch");
  }

  return {
    epochId: evEpochId,
    ownerAddress: input.ownerAddress,
    usdAmount: evUsdAmount,
    luminaReceived: evLuminaAmount,
    priceUsed: evPriceUsed,
    blockNumber: receipt.blockNumber,
    txHash: input.txHash,
  };
}
