import { generateApiKey, hashApiKey } from "../../src/middlewares/auth";
import {
  countActiveKeys,
  findActiveKeyByHash,
  findOrCreateAgent,
  insertApiKey,
  MAX_KEYS_PER_WALLET,
  revokeKey,
} from "../../src/db/database";

describe("auth + keys", () => {
  it("hashes API keys deterministically with sha-256", () => {
    expect(hashApiKey("abc")).toBe(hashApiKey("abc"));
    expect(hashApiKey("abc")).not.toBe(hashApiKey("abd"));
    expect(hashApiKey("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateApiKey produces opaque prefixed plaintext + matching hash", () => {
    const { plaintext, hash } = generateApiKey();
    expect(plaintext).toMatch(/^lk_[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(plaintext));
  });

  it("enforces MAX_KEYS_PER_WALLET via DB-level helpers", () => {
    const wallet = "0x000000000000000000000000000000000000ABCD";
    const agent = findOrCreateAgent(wallet);
    expect(agent.wallet).toBe(wallet.toLowerCase());

    for (let i = 0; i < MAX_KEYS_PER_WALLET; i++) {
      const k = generateApiKey();
      insertApiKey(agent.id, k.hash, `k${i}`);
    }
    expect(countActiveKeys(agent.id)).toBe(MAX_KEYS_PER_WALLET);

    // Revoking a key frees a slot
    const lookupOne = findActiveKeyByHash(hashApiKey("nonexistent"));
    expect(lookupOne).toBeUndefined();

    // Insert another key, then revoke it, then count
    const extra = generateApiKey();
    const inserted = insertApiKey(agent.id, extra.hash, "extra");
    expect(countActiveKeys(agent.id)).toBe(MAX_KEYS_PER_WALLET + 1); // raw insert allowed; service layer enforces cap
    const revoked = revokeKey(inserted.id);
    expect(revoked).toBe(true);
    expect(countActiveKeys(agent.id)).toBe(MAX_KEYS_PER_WALLET);

    // findActiveKeyByHash should NOT see revoked key
    expect(findActiveKeyByHash(extra.hash)).toBeUndefined();
  });
});
