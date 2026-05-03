// Tests covering V5.1-specific behavior in /api/v1/policies (purchase) and
// /policies/:productId/:policyId (read).
//
// Audit fixes exercised:
//   - H-4 (CoverRouter `whenNotPaused` -> 503 cover_router_paused)
//   - H-5 (PolicyManager `productActive` check -> 400 product_inactive)
//   - H-6 (priceSnapshot surfaced in getPolicy response)
//   - M-7 (GlobalPauseRegistry -> 503 globally_paused)

const VALID_BYTES32 = "0x" + "0".repeat(64);
const VALID_BUYER = "0x000000000000000000000000000000000000abcd";

const purchaseSpy = jest.fn(async () => ({
  hash: "0x" + "a".repeat(64),
  wait: async () => ({ status: 1, blockNumber: 12345, logs: [] }),
}));
const fakeRegistry = { isGloballyPaused: jest.fn().mockResolvedValue(false) };

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  };
  const fakeRouter = {
    authorizedRelayers: jest.fn().mockResolvedValue(true),
    paused: jest.fn().mockResolvedValue(false),
    globalPauseRegistry: jest.fn().mockResolvedValue("0x0000000000000000000000000000000000000000"),
    purchasePolicyFor: purchaseSpy,
  };
  const fakePolicyManager = {
    productActive: jest.fn().mockResolvedValue(true),
    productShield: jest.fn().mockResolvedValue("0x000000000000000000000000000000000000FEED"),
    policies: jest.fn().mockResolvedValue([
      VALID_BYTES32,
      "0x000000000000000000000000000000000000FEED",
      VALID_BUYER,
      1_000_000_000n, // coverageAmount
      800_000_000n,   // payoutAmount
      1_000_000n,     // premiumPaid
      1_700_000_000n, // createdAt
      1_700_003_600n, // expiresAt
      false,
      false,
    ]),
    policyPriceSnapshot: jest.fn().mockResolvedValue(36_000_000_000_000_000n),
  };
  return {
    provider: fakeProvider,
    relayer: { address: "0x0000000000000000000000000000000000000001" },
    coverRouter: fakeRouter,
    coverRouterRelayer: fakeRouter,
    policyManager: fakePolicyManager,
    claimBond: {},
    bondVault: {},
    luminaToken: {},
    usdc: {},
    getGlobalPauseRegistry: jest.fn().mockImplementation(async () => {
      const addr: string = await fakeRouter.globalPauseRegistry();
      if (!addr || addr === "0x0000000000000000000000000000000000000000") return undefined;
      return fakeRegistry;
    }),
  };
});

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";
import { getDb } from "../../src/db/database";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ethersMock = require("../../src/utils/ethers");

const app = createApp();
let apiKey: string;

beforeAll(() => {
  const issued = issueKey("0x000000000000000000000000000000000000FACE", "v5.1-purchase");
  apiKey = issued.plaintext;
});

beforeEach(() => {
  // Reset to "happy" defaults + clear call history before each test.
  ethersMock.coverRouter.paused.mockResolvedValue(false);
  ethersMock.coverRouter.globalPauseRegistry.mockResolvedValue(
    "0x0000000000000000000000000000000000000000"
  );
  ethersMock.policyManager.productActive.mockResolvedValue(true);
  fakeRegistry.isGloballyPaused.mockClear();
  fakeRegistry.isGloballyPaused.mockResolvedValue(false);
  purchaseSpy.mockClear();
  // Mock receipt has no PolicyCreated log → service falls back to policy_id=0.
  // Successive happy-path tests would collide on UNIQUE(product_id, policy_id);
  // wipe the table so each test starts from a clean slate.
  getDb().prepare("DELETE FROM policies").run();
});

const VALID_BODY = {
  productId: VALID_BYTES32,
  coverageAmount: "1000000000",
  asset: VALID_BYTES32,
  buyer: VALID_BUYER,
};

describe("V5.1 H-4 — CoverRouter local pause pre-flight", () => {
  test("returns 503 cover_router_paused when CoverRouter.paused() == true", async () => {
    ethersMock.coverRouter.paused.mockResolvedValueOnce(true);
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", apiKey)
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("cover_router_paused");
    expect(purchaseSpy).not.toHaveBeenCalled();
  });
});

describe("V5.1 M-7 — GlobalPauseRegistry pre-flight", () => {
  test("returns 503 globally_paused when registry reports paused", async () => {
    ethersMock.coverRouter.globalPauseRegistry.mockResolvedValueOnce(
      "0xCAFEBABEcafebabecafebabecafebabecafebabe"
    );
    fakeRegistry.isGloballyPaused.mockResolvedValueOnce(true);
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", apiKey)
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("globally_paused");
    expect(purchaseSpy).not.toHaveBeenCalled();
  });

  test("skips registry check when registry is unset (address(0))", async () => {
    // Default mock already returns 0x0...0 — purchase should proceed.
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", apiKey)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(fakeRegistry.isGloballyPaused).not.toHaveBeenCalled();
  });
});

describe("V5.1 H-5 — PolicyManager productActive pre-flight", () => {
  test("returns 400 product_inactive when product is deactivated", async () => {
    ethersMock.policyManager.productActive.mockResolvedValueOnce(false);
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", apiKey)
      .send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("product_inactive");
    expect(purchaseSpy).not.toHaveBeenCalled();
  });
});

describe("V5.1 H-6 — priceSnapshot surfaced in getPolicy", () => {
  test("GET /policies/:productId/:policyId includes priceSnapshot", async () => {
    const res = await request(app).get(`/policies/${VALID_BYTES32}/1`);
    expect(res.status).toBe(200);
    expect(res.body.priceSnapshot).toBe("36000000000000000");
    expect(ethersMock.policyManager.policyPriceSnapshot).toHaveBeenCalledWith(VALID_BYTES32, 1n);
  });

  test("priceSnapshot returns '0' for legacy policies without snapshot", async () => {
    ethersMock.policyManager.policyPriceSnapshot.mockResolvedValueOnce(0n);
    const res = await request(app).get(`/policies/${VALID_BYTES32}/2`);
    expect(res.status).toBe(200);
    expect(res.body.priceSnapshot).toBe("0");
  });
});

describe("V5.1 — successful purchase under all gates open", () => {
  test("200/201 when not paused, not globally paused, product active", async () => {
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", apiKey)
      .send(VALID_BODY);
    expect([200, 201]).toContain(res.status);
    expect(res.body.ok).toBe(true);
    expect(purchaseSpy).toHaveBeenCalledTimes(1);
  });
});
