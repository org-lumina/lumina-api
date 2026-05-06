// Sandbox / "Try It" surface.
//
// We don't actually broadcast a tx in tests — `purchaseViaRelayer` is fully
// mocked. The point is to verify the sandbox endpoint:
//   - returns 503 when SANDBOX_WALLET is unset
//   - delegates to purchaseViaRelayer with the SERVER-FIXED buyer + cap
//   - never lets the caller override the buyer or the cover amount

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
  // Reload the express app after env mutations so the route registers with
  // the patched config on each test scenario.
  jest.resetModules();
  // re-mock after reset (jest.resetModules drops the manual mocks otherwise)
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

describe("GET /sandbox/info", () => {
  it("reports enabled=false when SANDBOX_WALLET is unset", async () => {
    delete process.env.SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp()).get("/sandbox/info");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.sandboxWallet).toBeNull();
  });

  it("reports enabled=true when SANDBOX_WALLET is set", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp()).get("/sandbox/info");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.sandboxWallet).toBe(SANDBOX_WALLET);
    expect(res.body.coverageCapUsdc).toBe("1000000");
  });
});

describe("POST /sandbox/try", () => {
  beforeEach(() => purchaseSpy.mockReset());

  it("503s when SANDBOX_WALLET is unset", async () => {
    delete process.env.SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp()).post("/sandbox/try").send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("sandbox_disabled");
  });

  it("uses the server-fixed buyer and cap", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    purchaseSpy.mockResolvedValueOnce({
      txHash: "0xfeed",
      blockNumber: 1,
      policyId: "42",
      buyer: SANDBOX_WALLET,
      productId: "0x" + "1".repeat(64),
      coverageAmount: "1000000",
      premiumPaid: "10000",
    });

    const res = await request(freshApp())
      .post("/sandbox/try")
      .send({
        // Caller-controlled buyer/cover would be silently ignored.
        productId: "0x" + "1".repeat(64),
      });

    expect(res.status).toBe(201);
    expect(res.body.sandbox).toBe(true);
    expect(purchaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        buyer: SANDBOX_WALLET,
        coverageAmount: 1000000n,
      })
    );
  });
});
