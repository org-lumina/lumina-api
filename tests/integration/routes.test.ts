// Integration tests: spin up Express app with ethers/contract calls mocked.
// These tests cover routing, validation, auth, and serialization — they do NOT
// hit a real RPC node.

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(12345),
    getBalance: jest.fn().mockResolvedValue(BigInt("123000000000000000")),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  };
  const fakeRelayer = { address: "0x000000000000000000000000000000000000BEEF" };
  const fakeCoverRouter = {
    getProductCount: jest.fn().mockResolvedValue(2n),
    productList: jest.fn(async (i: bigint) => `0x${i.toString(16).padStart(64, "0")}`),
    products: jest.fn().mockResolvedValue([
      "0x" + "0".repeat(64),
      8000n, // payoutRatioBps
      20n,   // triggerProbBps
      15000n, // marginBps
      3600n,  // durationSeconds
      true,
    ]),
    quotePremium: jest.fn().mockResolvedValue([1_000_000n, 5_000_000n]),
    authorizedRelayers: jest.fn().mockResolvedValue(true),
    // [V5.1 H-4 / M-7] Pre-flight surface for purchaseViaRelayer.
    paused: jest.fn().mockResolvedValue(false),
    globalPauseRegistry: jest.fn().mockResolvedValue("0x0000000000000000000000000000000000000000"),
  };
  const fakePolicyManager = {
    productShield: jest.fn().mockResolvedValue("0x000000000000000000000000000000000000FEED"),
    productActive: jest.fn().mockResolvedValue(true),
    policies: jest.fn().mockResolvedValue([
      "0x" + "0".repeat(64),
      "0x000000000000000000000000000000000000abcd",
      "0x000000000000000000000000000000000000abcd",
      1_000_000_000n,
      1_000_000n,
      800_000_000n,
      1_700_000_000n,
      1_700_003_600n,
      false,
      false,
    ]),
    // [V5.1 H-6] Per-policy LUMINA price snapshot.
    policyPriceSnapshot: jest.fn().mockResolvedValue(36_000_000_000_000_000n),
    // [V5.1] Trigger metadata lookup. Default: empty (no PolicyTriggered events).
    filters: { PolicyTriggered: jest.fn(() => ({})) },
    queryFilter: jest.fn().mockResolvedValue([]),
  };
  // [V5.1] Shield handle returned by getShield(address).
  const fakeShield = {
    getPolicyInfo: jest.fn().mockResolvedValue([
      1n,                         // policyId
      "0x000000000000000000000000000000000000abcd", // insuredAgent
      1_000_000_000n,             // coverageAmount
      1_000_000n,                 // premiumPaid
      800_000_000n,               // maxPayout
      1_700_000_000n,             // startTimestamp
      1_700_001_800n,             // waitingEndsAt
      1_700_003_600n,             // expiresAt
      1_700_007_200n,             // cleanupAt
      2,                          // status (ACTIVE)
    ]),
    target: "0x000000000000000000000000000000000000FEED",
  };
  return {
    provider: fakeProvider,
    relayer: fakeRelayer,
    coverRouter: fakeCoverRouter,
    policyManager: fakePolicyManager,
    coverRouterRelayer: fakeCoverRouter,
    claimBond: {},
    bondVault: { target: "0x000000000000000000000000000000000000B00D" },
    luminaToken: {},
    usdc: {},
    getGlobalPauseRegistry: jest.fn().mockResolvedValue(undefined),
    getShield: jest.fn().mockReturnValue(fakeShield),
  };
});

import request from "supertest";
import { ethers } from "ethers";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";

const app = createApp();

describe("GET /health", () => {
  it("returns ok with chain + relayer info", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.chain.chainId).toBe(84532);
    expect(res.body.relayer.address).toBe("0x000000000000000000000000000000000000BEEF");
    expect(res.body.contracts.coverRouter).toBeDefined();
  });
});

describe("GET /products", () => {
  it("lists products from CoverRouter", async () => {
    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.products[0].active).toBe(true);
    expect(res.body.products[0].payoutRatioBps).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// [feat/products-coveredAsset] Validate that the canonical 9-product registry
// gets the correct coveredAsset/paymentAsset/coverageDescription. We re-mock
// the CoverRouter inputs per test so productList() returns real keccak256
// hashes that the productNames util can reverse-resolve.
// ---------------------------------------------------------------------------
describe("GET /products — coveredAsset / paymentAsset registry", () => {
  const PRODUCTS: ReadonlyArray<readonly [string, "BTC" | "ETH" | "USDT" | "USDC", string]> = [
    ["FLASHBTC1H-001", "BTC", "Insures BTC against rapid price crashes within 1 hour"],
    ["FLASHBTC4H-001", "BTC", "Insures BTC against rapid price crashes within 4 hours"],
    ["FLASHBTC24-001", "BTC", "Insures BTC against rapid price crashes within 24 hours"],
    ["FLASHBTC48-001", "BTC", "Insures BTC against rapid price crashes within 48 hours"],
    ["FLASHETH1H-001", "ETH", "Insures ETH against rapid price crashes within 1 hour"],
    ["FLASHETH24-001", "ETH", "Insures ETH against rapid price crashes within 24 hours"],
    ["FLASHETH48-001", "ETH", "Insures ETH against rapid price crashes within 48 hours"],
    ["MICRODEPEG-001", "USDT", "Insures against USDT losing its peg to $1.00"],
    ["RATESHOCK-001", "USDC", "Insures against USDC borrow rate shocks on Aave V3"],
  ];
  const IDS = PRODUCTS.map(([name]) => ethers.keccak256(ethers.toUtf8Bytes(name)).toLowerCase());

  // Re-program the CoverRouter mock so productList() returns the 9 real ids.
  beforeEach(() => {
    const ethersMock = require("../../src/utils/ethers");
    ethersMock.coverRouter.getProductCount.mockResolvedValueOnce(BigInt(IDS.length));
    ethersMock.coverRouter.productList.mockImplementation(async (idx: bigint) => IDS[Number(idx)]);
    // products() is called once per id; each call returns the same shape.
    for (let n = 0; n < IDS.length; n++) {
      ethersMock.coverRouter.products.mockResolvedValueOnce([
        IDS[n],
        8000n,
        20n,
        15000n,
        3600n,
        true,
      ]);
    }
    // productShield() called once per id.
    for (let n = 0; n < IDS.length; n++) {
      ethersMock.policyManager.productShield.mockResolvedValueOnce(
        "0x000000000000000000000000000000000000FEED",
      );
    }
  });

  it("/products returns coveredAsset for all 9 products", async () => {
    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(9);
    for (const p of res.body.products) {
      expect(p.coveredAsset).toBeDefined();
      expect(["BTC", "ETH", "USDT", "USDC"]).toContain(p.coveredAsset);
      expect(p.coverageDescription).toEqual(expect.any(String));
      expect(p.coverageDescription.length).toBeGreaterThan(0);
    }
  });

  it("MicroDepeg.coveredAsset === 'USDT'", async () => {
    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    const md = res.body.products.find((p: any) => p.name === "MICRODEPEG-001");
    expect(md).toBeDefined();
    expect(md.coveredAsset).toBe("USDT");
    expect(md.paymentAsset).toBe("USDC");
    expect(md.coverageDescription).toBe("Insures against USDT losing its peg to $1.00");
  });

  it("RateShock.coveredAsset === 'USDC'", async () => {
    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    const rs = res.body.products.find((p: any) => p.name === "RATESHOCK-001");
    expect(rs).toBeDefined();
    expect(rs.coveredAsset).toBe("USDC");
    expect(rs.paymentAsset).toBe("USDC");
    expect(rs.coverageDescription).toBe("Insures against USDC borrow rate shocks on Aave V3");
  });

  it("FlashBTC*.coveredAsset === 'BTC' for all variants", async () => {
    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    const btcs = res.body.products.filter(
      (p: any) => typeof p.name === "string" && p.name.startsWith("FLASHBTC"),
    );
    expect(btcs.length).toBe(4);
    for (const p of btcs) {
      expect(p.coveredAsset).toBe("BTC");
      expect(p.coverageDescription).toMatch(/^Insures BTC against rapid price crashes/);
    }
  });

  it("FlashETH*.coveredAsset === 'ETH' for all variants", async () => {
    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    const eths = res.body.products.filter(
      (p: any) => typeof p.name === "string" && p.name.startsWith("FLASHETH"),
    );
    expect(eths.length).toBe(3);
    for (const p of eths) {
      expect(p.coveredAsset).toBe("ETH");
      expect(p.coverageDescription).toMatch(/^Insures ETH against rapid price crashes/);
    }
  });

  it("All products have paymentAsset === 'USDC'", async () => {
    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(9);
    for (const p of res.body.products) {
      expect(p.paymentAsset).toBe("USDC");
    }
  });
});

describe("GET /products/:id/quote", () => {
  it("validates productId format", async () => {
    const res = await request(app).get("/products/0xabc/quote?coverageAmount=1000000");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("returns quote for valid productId", async () => {
    const productId = "0x" + "0".repeat(64);
    const res = await request(app).get(`/products/${productId}/quote?coverageAmount=1000000000`);
    expect(res.status).toBe(200);
    expect(res.body.premium).toBe("1000000");
    expect(res.body.payout).toBe("5000000");
  });
});

describe("GET /policies/:productId/:policyId", () => {
  it("returns 404 for nonexistent (zero buyer)", async () => {
    const ethersMock = require("../../src/utils/ethers");
    ethersMock.policyManager.policies.mockResolvedValueOnce([
      "0x" + "0".repeat(64),
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      0n, 0n, 0n, 0n, 0n, false, false,
    ]);
    const productId = "0x" + "0".repeat(64);
    const res = await request(app).get(`/policies/${productId}/9999`);
    expect(res.status).toBe(404);
  });

  it("returns policy data when present", async () => {
    const productId = "0x" + "0".repeat(64);
    const res = await request(app).get(`/policies/${productId}/1`);
    expect(res.status).toBe(200);
    expect(res.body.policyId).toBe("1");
    expect(res.body.coverageAmount).toBe("1000000000");
  });
});

describe("POST /api/v1/policies (auth)", () => {
  it("rejects without API key", async () => {
    const res = await request(app)
      .post("/api/v1/policies")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });

  it("rejects with malformed API key", async () => {
    const res = await request(app)
      .post("/api/v1/policies")
      .set("x-api-key", "wrongprefix_xxx")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });
});

describe("POST /api/v1/keys/generate (admin)", () => {
  it("rejects without admin token", async () => {
    const res = await request(app)
      .post("/api/v1/keys/generate")
      .send({ wallet: "0x000000000000000000000000000000000000ABCD" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_admin_token");
  });

  it("issues a key with valid admin token", async () => {
    const res = await request(app)
      .post("/api/v1/keys/generate")
      .set("x-admin-token", process.env.ADMIN_TOKEN!)
      .send({ wallet: "0x000000000000000000000000000000000000ABCD", label: "test" });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^lk_[0-9a-f]{64}$/);
    expect(res.body.tier).toBe("free");
    expect(res.body.warning).toMatch(/not be shown again/i);
  });

  it("validates wallet format", async () => {
    const res = await request(app)
      .post("/api/v1/keys/generate")
      .set("x-admin-token", process.env.ADMIN_TOKEN!)
      .send({ wallet: "not-a-wallet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });
});

describe("authenticated request flow", () => {
  it("accepts valid API key and lists policies (empty by default)", async () => {
    const issued = issueKey("0x000000000000000000000000000000000000FACE", "flow-test");
    const res = await request(app)
      .get("/api/v1/policies")
      .set("x-api-key", issued.plaintext);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.policies).toEqual([]);
  });
});
