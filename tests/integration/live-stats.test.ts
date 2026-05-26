// /api/v1/live-stats — verifies 200, JSON shape, and that the 30s cache collapses
// rapid requests to a single set of chain reads. ethers + utils/ethers are mocked.

const oracleCalls = { n: 0 };

jest.mock("ethers", () => {
  const actual = jest.requireActual("ethers");
  class FakeContract {
    target: string;
    constructor(addr: string) {
      this.target = addr;
    }
    priceOracle = jest.fn().mockResolvedValue("0x" + "a".repeat(40));
    getLuminaPrice = jest.fn(() => {
      oracleCalls.n += 1;
      return Promise.resolve(36000000000000000n); // $0.036 (18-dec)
    });
    totalSupply = jest.fn().mockResolvedValue(100_000_000n * 10n ** 18n);
    balanceOf = jest.fn().mockResolvedValue(69_997_777n * 10n ** 18n);
    totalCommittedUSD = jest.fn().mockResolvedValue(80n * 10n ** 18n); // $80 (18-dec)
    availableCapacityUSD = jest.fn().mockResolvedValue(1_259_120n); // integer USD
  }
  return { ...actual, ethers: { ...actual.ethers, Contract: FakeContract }, Contract: FakeContract };
});

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(42_000_000),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  };
  const noop = {};
  return {
    provider: fakeProvider,
    relayer: { address: "0x" + "be".repeat(20) },
    coverRouter: noop,
    policyManager: noop,
    bondVault: noop,
    luminaToken: noop,
    coverRouterRelayer: noop,
    claimBond: noop,
    usdc: noop,
    getGlobalPauseRegistry: jest.fn(),
    getShield: jest.fn(),
  };
});

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("GET /api/v1/live-stats", () => {
  it("returns 200 with the expected shape + real-derived values", async () => {
    const res = await request(app).get("/api/v1/live-stats");
    expect(res.status).toBe(200);
    expect(res.body.luminaPrice.usd).toBeCloseTo(0.036, 3);
    expect(res.body.bondReserve.lumina).toBe("69997777.00");
    expect(res.body.capacity.committedUSD).toBe("80.00");
    expect(res.body.totalSupply.lumina).toBe("100,000,000");
    expect(res.body.chainStatus.chainId).toBe(84532);
    expect(res.body.chainStatus.blockNumber).toBe(42000000);
    expect(typeof res.body.lastUpdated).toBe("string");
  });

  it("caches: two rapid requests trigger only one oracle read", async () => {
    const before = oracleCalls.n;
    await request(app).get("/api/v1/live-stats");
    await request(app).get("/api/v1/live-stats");
    expect(oracleCalls.n - before).toBe(0); // both served from the cache primed in test 1
  });
});
