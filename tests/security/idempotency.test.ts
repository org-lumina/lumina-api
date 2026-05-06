// Idempotency-Key on POST /api/v1/policies. Same (key, agent_id) MUST
// return the cached response on replay; the underlying contract call
// MUST happen exactly once.

const purchaseSpy = jest.fn();
let purchaseCallCount = 0;

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  };
  const fakeRelayer = { address: "0x0000000000000000000000000000000000000001" };
  const fakeRouter = {
    target: "0x000000000000000000000000000000000000ABCD",
    authorizedRelayers: jest.fn().mockResolvedValue(true),
    // [V5.1 H-4 / M-7] Pre-flights — both unpaused for idempotency tests.
    paused: jest.fn().mockResolvedValue(false),
    globalPauseRegistry: jest.fn().mockResolvedValue("0x0000000000000000000000000000000000000000"),
    // [10x10 fix C-1] new preflights
    products: jest.fn().mockResolvedValue({
      durationSeconds: 3600n,
      0: "0x" + "0".repeat(64), 1: 8000n, 2: 1000n, 3: 12000n, 4: 3600n, 5: true,
    }),
    quotePremium: jest.fn().mockResolvedValue({ premium: 1_000_000n, payout: 800_000_000n, 0: 1_000_000n, 1: 800_000_000n }),
    purchasePolicyFor: jest.fn(async () => {
      purchaseCallCount += 1;
      return {
        hash: "0x" + "a".repeat(64),
        wait: async () => ({
          status: 1,
          blockNumber: 12345,
          logs: [],
        }),
      };
    }),
  };
  // [V5.1 H-5] Pre-flight productActive used by purchaseViaRelayer.
  const fakePolicyManager = { productActive: jest.fn().mockResolvedValue(true) };
  const fakeUsdc = {
    balanceOf: jest.fn().mockResolvedValue(10_000_000_000n),
    allowance: jest.fn().mockResolvedValue(115792089237316195423570985008687907853269984665640564039457584007913129639935n),
  };
  return {
    provider: fakeProvider,
    relayer: fakeRelayer,
    coverRouter: fakeRouter,
    coverRouterRelayer: fakeRouter,
    policyManager: fakePolicyManager,
    claimBond: {},
    bondVault: {},
    luminaToken: {},
    usdc: fakeUsdc,
    getGlobalPauseRegistry: jest.fn().mockResolvedValue(undefined),
  };
});

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";

const app = createApp();
const VALID_BYTES32 = "0x" + "0".repeat(64);
const VALID_BUYER = "0x000000000000000000000000000000000000abcd";

describe("Idempotency-Key replay protection", () => {
  let key: string;

  beforeAll(() => {
    purchaseSpy.mockClear();
    purchaseCallCount = 0;
    const issued = issueKey("0x000000000000000000000000000000000000FACE", "idem-test");
    key = issued.plaintext;
  });

  test("same idempotency key returns identical response and triggers ONE on-chain call", async () => {
    const idem = "uniq-key-" + Date.now();
    const body = {
      productId: VALID_BYTES32,
      coverageAmount: "1000000000",
      asset: VALID_BYTES32,
      buyer: VALID_BUYER,
    };

    const before = purchaseCallCount;
    const r1 = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .set("Idempotency-Key", idem)
      .send(body);

    const r2 = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .set("Idempotency-Key", idem)
      .send(body);

    const after = purchaseCallCount;

    // Both responses must be 2xx with the same body (modulo status code 201 vs 200).
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    expect(r2.body.txHash).toBe(r1.body.txHash);
    expect(r2.body.policyId).toBe(r1.body.policyId);

    // Crucially: only ONE on-chain submission, even though we called twice.
    expect(after - before).toBe(1);
  });

  test("different idempotency keys produce two on-chain calls", async () => {
    const body = {
      productId: VALID_BYTES32,
      coverageAmount: "1000000000",
      asset: VALID_BYTES32,
      buyer: VALID_BUYER,
    };
    const before = purchaseCallCount;

    await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .set("Idempotency-Key", "k-aaa-" + Date.now())
      .send(body);
    await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", key)
      .set("Idempotency-Key", "k-bbb-" + Date.now())
      .send(body);

    const after = purchaseCallCount;
    expect(after - before).toBe(2);
  });

  test("no idempotency key always submits a new tx", async () => {
    const body = {
      productId: VALID_BYTES32,
      coverageAmount: "1000000000",
      asset: VALID_BYTES32,
      buyer: VALID_BUYER,
    };
    const before = purchaseCallCount;

    await request(app).post("/api/v1/policies").set("x-api-key", key).send(body);
    await request(app).post("/api/v1/policies").set("x-api-key", key).send(body);

    expect(purchaseCallCount - before).toBe(2);
  });
});
