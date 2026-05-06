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
    // [10x10 fix C-1] default cap is now $100 (the on-chain `InvalidCoverage`
    // floor enforced by CoverRouterV2). Lower values revert.
    expect(res.body.coverageCapUsdc).toBe("100000000");
  });
});

describe("POST /sandbox/try", () => {
  beforeEach(() => purchaseSpy.mockReset());

  // Live keccak hashes from /products on Base Sepolia; matches src/utils/productNames.ts.
  const FLASHBTC1H_ID =
    "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd";
  const FLASHETH1H_ID =
    "0x6cedbccfc3dc131aec7bdd9a9761ac0a8e665daa87763328ffca700f9b678915";
  const RATESHOCK_ID =
    "0x8ae1e4140e1713abfdbbba9bc4cbf4afdc0d60e3f98687bd02d6dad5a60a347f";
  const BTC_BYTES32 =
    "0x4254430000000000000000000000000000000000000000000000000000000000";
  const ETH_BYTES32 =
    "0x4554480000000000000000000000000000000000000000000000000000000000";
  const USDC_BYTES32 =
    "0x5553444300000000000000000000000000000000000000000000000000000000";

  it("503s when SANDBOX_WALLET is unset", async () => {
    delete process.env.SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp()).post("/sandbox/try").send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("sandbox_disabled");
  });

  it("auto-resolves asset='BTC' for default FLASHBTC1H-001 productId", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    purchaseSpy.mockResolvedValueOnce({
      txHash: "0xfeed",
      blockNumber: 1,
      policyId: "42",
      buyer: SANDBOX_WALLET,
      productId: FLASHBTC1H_ID,
      coverageAmount: "100000000",
      premiumPaid: "10000",
    });

    const res = await request(freshApp())
      .post("/sandbox/try")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.sandbox).toBe(true);
    expect(res.body.assetSymbol).toBe("BTC");
    expect(purchaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: FLASHBTC1H_ID,
        asset: BTC_BYTES32,
        buyer: SANDBOX_WALLET,
        coverageAmount: 100_000_000n,
      })
    );
  });

  it("resolves asset from productName (productName wins over default productId)", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    purchaseSpy.mockResolvedValueOnce({
      txHash: "0xfeed",
      blockNumber: 1,
      policyId: "43",
      buyer: SANDBOX_WALLET,
      productId: FLASHETH1H_ID,
      coverageAmount: "100000000",
      premiumPaid: "10000",
    });

    const res = await request(freshApp())
      .post("/sandbox/try")
      .send({ productName: "FLASHETH1H-001" });

    expect(res.status).toBe(201);
    expect(res.body.assetSymbol).toBe("ETH");
    expect(purchaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: FLASHETH1H_ID,
        asset: ETH_BYTES32,
      })
    );
  });

  it("resolves asset='USDC' for RATESHOCK-001 productId", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    purchaseSpy.mockResolvedValueOnce({
      txHash: "0xfeed",
      blockNumber: 1,
      policyId: "44",
      buyer: SANDBOX_WALLET,
      productId: RATESHOCK_ID,
      coverageAmount: "100000000",
      premiumPaid: "10000",
    });

    const res = await request(freshApp())
      .post("/sandbox/try")
      .send({ productId: RATESHOCK_ID });

    expect(res.status).toBe(201);
    expect(res.body.assetSymbol).toBe("USDC");
    expect(purchaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: RATESHOCK_ID,
        asset: USDC_BYTES32,
      })
    );
  });

  it("400s when productId is not in the canonical asset registry", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp())
      .post("/sandbox/try")
      .send({ productId: "0x" + "1".repeat(64) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_product");
    expect(purchaseSpy).not.toHaveBeenCalled();
  });

  it("400s on unknown productName", async () => {
    process.env.SANDBOX_WALLET = SANDBOX_WALLET;
    resetConfig();
    const res = await request(freshApp())
      .post("/sandbox/try")
      .send({ productName: "UNKNOWN-001" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_product");
    expect(purchaseSpy).not.toHaveBeenCalled();
  });
});
