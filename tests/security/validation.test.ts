// Schema validation: every public route uses zod for input validation.
// Malformed inputs MUST surface as 400 validation_error with `details[]`,
// never as a 500.

jest.mock("../../src/utils/ethers", () => ({
  provider: {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
  },
  relayer: { address: "0x0000000000000000000000000000000000000001" },
  coverRouter: {
    getProductCount: jest.fn().mockResolvedValue(0n),
    productList: jest.fn(),
    products: jest.fn(),
    quotePremium: jest.fn().mockResolvedValue([1_000n, 5_000n]),
  },
  policyManager: {
    productShield: jest.fn().mockResolvedValue("0x000000000000000000000000000000000000FEED"),
    productActive: jest.fn().mockResolvedValue(true),
    policies: jest.fn(),
  },
  coverRouterRelayer: {},
  claimBond: {},
  bondVault: {},
  luminaToken: {},
  usdc: {},
}));

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";

const app = createApp();
const VALID_BYTES32 = "0x" + "0".repeat(64);

describe("/products/:id/quote query validation", () => {
  test("missing coverageAmount returns 400", async () => {
    const res = await request(app).get(`/products/${VALID_BYTES32}/quote`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  test("non-numeric coverageAmount returns 400", async () => {
    const res = await request(app).get(`/products/${VALID_BYTES32}/quote?coverageAmount=abc`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  test("negative coverageAmount returns 400 (regex disallows '-')", async () => {
    const res = await request(app).get(`/products/${VALID_BYTES32}/quote?coverageAmount=-1`);
    expect(res.status).toBe(400);
  });

  test("malformed productId returns 400", async () => {
    const res = await request(app).get(`/products/0xabc/quote?coverageAmount=1000`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/policies body validation", () => {
  let key: string;
  beforeAll(() => {
    const issued = issueKey("0x000000000000000000000000000000000000ACE0", "validation-test");
    key = issued.plaintext;
  });

  test("empty body returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  test("missing buyer returns 400 with field name in details", async () => {
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .send({
        productId: VALID_BYTES32,
        coverageAmount: "1000000000",
        asset: VALID_BYTES32,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: { path: string }) => d.path.includes("buyer"))).toBe(true);
  });

  test("buyer with checksum-y but invalid address returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .send({
        productId: VALID_BYTES32,
        coverageAmount: "1000000000",
        asset: VALID_BYTES32,
        buyer: "0xnotanaddress",
      });
    expect(res.status).toBe(400);
  });

  test("non-string coverageAmount (number) returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .send({
        productId: VALID_BYTES32,
        coverageAmount: 1000000000,
        asset: VALID_BYTES32,
        buyer: "0x000000000000000000000000000000000000abcd",
      });
    expect(res.status).toBe(400);
  });

  test("oversized request body returns 413 (express.json limit 32 KB)", async () => {
    const huge = "a".repeat(33 * 1024);
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .set("content-type", "application/json")
      .send(`{"junk":"${huge}"}`);
    // express.json with limit returns 413 (PayloadTooLargeError)
    expect([413, 400]).toContain(res.status);
  });
});

describe("/policies/:productId/:policyId path validation", () => {
  test("non-numeric policyId returns 400", async () => {
    const res = await request(app).get(`/policies/${VALID_BYTES32}/abc`);
    expect(res.status).toBe(400);
  });
  test("malformed productId returns 400", async () => {
    const res = await request(app).get(`/policies/0xabc/1`);
    expect(res.status).toBe(400);
  });
});
