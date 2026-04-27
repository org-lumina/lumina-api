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

  // CURRENT BEHAVIOUR: the API does NOT prevent Bob from reading
  // Alice's policies via ?owner=. This is a documented IDOR — see
  // docs/audit/v5.1-uups/33-api-architecture/REPORT.md, finding INV-1.
  // The test asserts the current behaviour so that if a fix is
  // applied later, this test will start failing and the finding can
  // be marked resolved.
  test("INV-1: Bob can currently read Alice's policy list (cross-owner read is allowed)", async () => {
    const res = await request(app)
      .get(`/api/v1/policies?owner=${ALICE}`)
      .set("x-api-key", bobKey);
    expect(res.status).toBe(200); // <-- when fixed this should become 403
    expect(res.body.owner).toBe(ALICE.toLowerCase());
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
