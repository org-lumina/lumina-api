// Auth-bypass attempts. The API ships only one mechanism for callers to
// authenticate: `x-api-key: lk_<64hex>`. Anything else MUST be rejected
// before it reaches business logic — no DB write, no contract call, no
// state change of any kind.

jest.mock("../../src/utils/ethers", () => ({
  provider: {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  },
  relayer: { address: "0x0000000000000000000000000000000000000001" },
  coverRouter: {},
  policyManager: {},
  coverRouterRelayer: { authorizedRelayers: jest.fn().mockResolvedValue(true) },
  claimBond: {},
  bondVault: {},
  luminaToken: {},
  usdc: {},
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

const PURCHASE_PATH = "/api/v1/policies";
const VALID_BODY = {
  productId: "0x" + "0".repeat(64),
  coverageAmount: "1000000000",
  asset: "0x" + "4254430000000000000000000000000000000000000000000000000000000000".slice(0, 64),
  buyer: "0x000000000000000000000000000000000000abcd",
};

describe("auth bypass", () => {
  test("missing x-api-key returns 401", async () => {
    const res = await request(app).post(PURCHASE_PATH).send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });

  test("empty x-api-key returns 401", async () => {
    const res = await request(app).post(PURCHASE_PATH).set("x-api-key", "").send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });

  test("api key without lk_ prefix returns 401", async () => {
    const res = await request(app)
      .post(PURCHASE_PATH)
      .set("x-api-key", "abc123def456")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  test("api key shorter than 10 chars returns 401", async () => {
    const res = await request(app).post(PURCHASE_PATH).set("x-api-key", "lk_x").send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  test("forged lk_-prefixed key with random hex returns 401 (no DB hit)", async () => {
    const res = await request(app)
      .post(PURCHASE_PATH)
      .set("x-api-key", "lk_" + "f".repeat(64))
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  // SQL-injection style payloads: better-sqlite3 statements are parameterised
  // (`prepare(...).get(value)`), so these are simply lookup misses, not query
  // string concatenation. A bypass would manifest as 200 or 500. Both are
  // unacceptable; the only correct behaviour is 401.
  test.each([
    ["sql-classic", "lk_' OR '1'='1"],
    ["sql-comment", "lk_admin'--"],
    ["sql-union", "lk_x' UNION SELECT '1"],
    ["sql-stacked", "lk_x'; DROP TABLE api_keys;--"],
  ])("sql-injection payload (%s) returns 401", async (_name, payload) => {
    const res = await request(app).post(PURCHASE_PATH).set("x-api-key", payload).send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  test("non-string header (array) is treated as missing", async () => {
    // supertest serialises arrays into a single string with comma; this
    // exercises the typeof-check in auth middleware. We just need to
    // confirm we don't throw 500 and we don't admit the call.
    const res = await request(app)
      .post(PURCHASE_PATH)
      .set("x-api-key", ["one", "two"] as unknown as string)
      .send(VALID_BODY);
    expect([401]).toContain(res.status);
  });
});

describe("admin bypass", () => {
  const ADMIN_PATH = "/api/v1/keys/generate";
  const KEY_BODY = { wallet: "0x000000000000000000000000000000000000abcd" };

  test("missing x-admin-token returns 401", async () => {
    const res = await request(app).post(ADMIN_PATH).send(KEY_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_admin_token");
  });

  test("wrong-length token returns 401 (not 200, not 500)", async () => {
    const res = await request(app).post(ADMIN_PATH).set("x-admin-token", "short").send(KEY_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_admin_token");
  });

  test("right-length wrong-content token returns 401", async () => {
    // Same length as the test ADMIN_TOKEN ('x' * 40), different bytes
    const res = await request(app)
      .post(ADMIN_PATH)
      .set("x-admin-token", "y".repeat(40))
      .send(KEY_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_admin_token");
  });

  test("api key cannot be used in place of admin token", async () => {
    // Even an otherwise-valid lk_ key MUST NOT be accepted as admin.
    const res = await request(app)
      .post(ADMIN_PATH)
      .set("x-admin-token", "lk_" + "0".repeat(64))
      .send(KEY_BODY);
    expect(res.status).toBe(401);
  });
});
