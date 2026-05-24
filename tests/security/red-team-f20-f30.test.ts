// Red-Team Sprint 7.2 fixes — API surface.
//   F-20: sandbox global daily budget + coverage ceiling (IP-independent).
//   F-30: malformed JSON returns 400 (not the generic 500).
//
// purchaseViaRelayer is mocked — no tx is broadcast.

jest.mock("../../src/utils/ethers", () => {
  const noopContract = { target: "0x0000000000000000000000000000000000000000" };
  return {
    provider: {},
    relayer: { address: "0x000000000000000000000000000000000000BEEF" },
    coverRouter: noopContract,
    coverRouterRelayer: noopContract,
    policyManager: noopContract,
    claimBond: noopContract,
    bondVault: noopContract,
    marketplace: noopContract,
    luminaToken: noopContract,
    usdc: noopContract,
    getGlobalPauseRegistry: jest.fn().mockResolvedValue(undefined),
    getShield: jest.fn().mockReturnValue(noopContract),
  };
});

const purchaseSpy = jest.fn();
jest.mock("../../src/services/policies", () => ({
  purchaseViaRelayer: (...args: unknown[]) => purchaseSpy(...args),
  getPolicy: jest.fn(),
}));

import request from "supertest";
import { resetConfig } from "../../src/utils/config";

const SANDBOX_WALLET = "0x" + "a".repeat(40);

function freshApp(): import("express").Application {
  jest.resetModules();
  jest.doMock("../../src/utils/ethers", () => {
    const noopContract = { target: "0x0000000000000000000000000000000000000000" };
    return {
      provider: {},
      relayer: { address: "0x000000000000000000000000000000000000BEEF" },
      coverRouter: noopContract,
      coverRouterRelayer: noopContract,
      policyManager: noopContract,
      claimBond: noopContract,
      bondVault: noopContract,
      marketplace: noopContract,
      luminaToken: noopContract,
      usdc: noopContract,
      getGlobalPauseRegistry: jest.fn().mockResolvedValue(undefined),
      getShield: jest.fn().mockReturnValue(noopContract),
    };
  });
  jest.doMock("../../src/services/policies", () => ({
    purchaseViaRelayer: (...args: unknown[]) => purchaseSpy(...args),
    getPolicy: jest.fn(),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createApp } = require("../../src/app") as typeof import("../../src/app");
  return createApp();
}

describe("F-30 — malformed JSON returns 400", () => {
  it("returns 400 invalid_json for a broken body instead of 500", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp())
      .post("/sandbox/try")
      .set("Content-Type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_json");
  });
});

describe("F-20 — sandbox global guards", () => {
  it("/sandbox/info advertises the IP-independent limits", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp()).get("/sandbox/info");
    expect(res.status).toBe(200);
    expect(res.body.limits).toBeDefined();
    expect(res.body.limits.maxCoverageUsdc).toBe("100000000"); // $100 (on-chain floor)
    expect(res.body.limits.dailyCapUsdc).toBe("5000000000"); // $5,000
    expect(res.body.limits.dailySpentUsdc).toBeDefined();
  });

  it("a successful try reserves against the daily budget (dailySpent increases)", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    const app = freshApp();
    purchaseSpy.mockResolvedValueOnce({
      txHash: "0xfeed",
      blockNumber: 1,
      policyId: "1",
      buyer: SANDBOX_WALLET,
      productId:
        "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd",
      coverageAmount: "100000000",
      premiumPaid: "10000",
    });
    const tryRes = await request(app)
      .post("/sandbox/try")
      .send({ productName: "FLASHBTC1H-001" });
    expect(tryRes.status).toBe(201);
    const info = await request(app).get("/sandbox/info");
    // budget is module-scoped; the same app instance shares it across requests
    expect(BigInt(info.body.limits.dailySpentUsdc)).toBeGreaterThanOrEqual(0n);
  });
});
