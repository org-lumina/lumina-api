import { ethers } from "ethers";
import { generateApiKey } from "../middlewares/auth";
import {
  countActiveKeys,
  findOrCreateAgent,
  insertApiKey,
  MAX_KEYS_PER_WALLET,
  revokeKey,
} from "../db/database";
import { HttpError } from "../middlewares/error";

export interface IssuedKey {
  keyId: number;
  plaintext: string;
  agentId: number;
  wallet: string;
  tier: "free" | "paid";
  label: string | null;
  createdAt: number;
}

export function issueKey(wallet: string, label?: string): IssuedKey {
  if (!ethers.isAddress(wallet)) {
    throw new HttpError(400, "Invalid wallet address", "invalid_wallet");
  }
  const agent = findOrCreateAgent(wallet);
  if (countActiveKeys(agent.id) >= MAX_KEYS_PER_WALLET) {
    throw new HttpError(
      409,
      `Wallet already has ${MAX_KEYS_PER_WALLET} active API keys. Revoke one before issuing more.`,
      "key_limit_reached"
    );
  }
  const { plaintext, hash } = generateApiKey();
  const record = insertApiKey(agent.id, hash, label ?? null);
  return {
    keyId: record.id,
    plaintext,
    agentId: agent.id,
    wallet: agent.wallet,
    tier: agent.tier,
    label: record.label,
    createdAt: record.created_at,
  };
}

export function revoke(keyId: number): boolean {
  return revokeKey(keyId);
}
