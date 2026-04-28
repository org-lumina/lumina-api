// IDOR (Insecure Direct Object Reference) checks for endpoints that take
// an `owner` query parameter or operate on someone else's resources.
//
// Findings will be carried into the audit report. The intent here is to
// LOCK IN behaviour, not to assert that we are happy with it: if the API
// permits cross-owner reads on purpose, the test documents that decision
// so it cannot regress silently.

jest.mock("../../src/utils/ethers", () => ({
  provider: {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  },
  relayer: { address: "0x0000000000000000000000000000000000000001" },
  coverRouter: {},
  policyManager: {},
  coverRouterRelayer: {},
  claimBond: {},
  bondVault: {},
  luminaToken: {},
  usdc: {},
}));

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";
import { recordPolicy } from "../../src/db/database";

const app = createApp();
const ALICE = "0x000000000000000000000000000000000000A11C";
const BOB = "0x000000000000000000000000000000000000B0B0";

describe("GET /api/v1/policies?owner= cross-owner read", () => {
  let aliceKey: string;
  let bobKey: string;
  let aliceAgentId: number;

  beforeAll(() => {
    const a = issueKey(ALICE, "alice-key");
    const b = issueKey(BOB, "bob-key");
    aliceKey = a.plaintext;
    bobKey = b.plaintext;
    aliceAgentId = a.agentId;

    // Seed: Alice owns one policy in the local mirror.
    recordPolicy({
      product_id: "0x" + "1".repeat(64),
      policy_id: 1,
      buyer: ALICE,
      coverage_amount: "1000000000",
      premium_paid: "3200000",
      tx_hash: "0x" + "f".repeat(64),
      submitted_by: aliceAgentId,
    });
  });

  test("Alice can read her own policies (default = caller wallet)", async () => {
    const res = await request(app).get("/api/v1/policies").set("x-api-key", aliceKey);
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe(ALICE.toLowerCase());
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  test("Alice can also read her own policies via explicit owner param", async () => {
    const res = await request(app)
      .get(`/api/v1/policies?owner=${ALICE}`)
      .set("x-api-key", aliceKey);
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe(ALICE.toLowerCase());
  });

  // ─────────────────────────────────────────────────────────────────
  // INV-1 fix (audit #33): cross-owner reads MUST return 403.
  // ─────────────────────────────────────────────────────────────────

  test("INV-1: Bob cannot read Alice's policy list (returns 403)", async () => {
    const res = await request(app)
      .get(`/api/v1/policies?owner=${ALICE}`)
      .set("x-api-key", bobKey);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("INV-1: omitting `owner` defaults to caller's wallet (no cross-owner leak)", async () => {
    // Bob queries without ?owner=, must see HIS list (not Alice's).
    const res = await request(app).get("/api/v1/policies").set("x-api-key", bobKey);
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe(BOB.toLowerCase());
    // Bob has no policies seeded — so count is 0.
    expect(res.body.count).toBe(0);
  });

  test("INV-1: explicit owner = caller's own wallet (case-insensitive) is allowed", async () => {
    // ALICE is "0x...A11C"; the API stores the wallet lowercase. Caller passes
    // an all-lowercase form of their own address; comparison must succeed.
    const sameAddrLower = ALICE.toLowerCase();
    const res = await request(app)
      .get(`/api/v1/policies?owner=${sameAddrLower}`)
      .set("x-api-key", aliceKey);
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe(ALICE.toLowerCase());
  });

  test("INV-1: explicit owner = different wallet (any casing) still 403", async () => {
    // Bob asks for Alice's policies with the address spelled in lowercase.
    const aliceLower = ALICE.toLowerCase();
    const res = await request(app)
      .get(`/api/v1/policies?owner=${aliceLower}`)
      .set("x-api-key", bobKey);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/keys/:id ownership", () => {
  test("admin can revoke any key by id (intended behaviour)", async () => {
    const issued = issueKey("0x000000000000000000000000000000000000C0DE", "del-test");
    const res = await request(app)
      .delete(`/api/v1/keys/${issued.keyId}`)
      .set("x-admin-token", process.env.ADMIN_TOKEN!);
    expect(res.status).toBe(204);

    // Second deletion fails — the row is already revoked, not deleted.
    const res2 = await request(app)
      .delete(`/api/v1/keys/${issued.keyId}`)
      .set("x-admin-token", process.env.ADMIN_TOKEN!);
    expect(res2.status).toBe(404);
  });

  test("non-admin cannot revoke a key", async () => {
    const issued = issueKey("0x000000000000000000000000000000000000DEAD", "del-noauth");
    const res = await request(app).delete(`/api/v1/keys/${issued.keyId}`);
    expect(res.status).toBe(401);
  });
});
