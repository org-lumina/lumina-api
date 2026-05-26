// /api/v1/public/{policies,bonds}/:wallet — must respond WITHOUT an API key
// (all public on-chain data). ethers is mocked to return no events → empty lists.

jest.mock("../../src/utils/ethers", () => {
  const emptyLogs = jest.fn().mockResolvedValue([]);
  const fakeProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(42_000_000),
    getBlock: jest.fn().mockResolvedValue({ timestamp: 1_700_000_000 }),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  };
  const claimBond = {
    filters: { EpochCreated: jest.fn(() => ({})), TransferSingle: jest.fn(() => ({})) },
    queryFilter: emptyLogs,
    balanceOf: jest.fn().mockResolvedValue(0n),
    getEpochInfo: jest.fn().mockResolvedValue([false, 0n, 0n, false]),
  };
  const policyManager = {
    filters: { PolicyCreated: jest.fn(() => ({})) },
    queryFilter: emptyLogs,
  };
  return {
    provider: fakeProvider,
    relayer: { address: "0x" + "be".repeat(20) },
    coverRouter: {},
    coverRouterRelayer: {},
    policyManager,
    bondVault: { previewRedemption: jest.fn().mockResolvedValue(0n), target: "0x" + "b0".repeat(20) },
    claimBond,
    luminaToken: {},
    usdc: {},
    getGlobalPauseRegistry: jest.fn(),
    getShield: jest.fn(),
  };
});

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();
const WALLET = "0x" + "ab".repeat(20);

describe("public by-wallet endpoints (no auth)", () => {
  it("GET /api/v1/public/policies/:wallet → 200 without API key", async () => {
    const res = await request(app).get(`/api/v1/public/policies/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.wallet.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(res.body.count).toBe(0);
    expect(Array.isArray(res.body.policies)).toBe(true);
  });

  it("GET /api/v1/public/bonds/:wallet → 200 without API key", async () => {
    const res = await request(app).get(`/api/v1/public/bonds/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.totalBonds).toBe(0);
    expect(Array.isArray(res.body.bonds)).toBe(true);
  });

  it("rejects a malformed wallet with 400", async () => {
    const res = await request(app).get(`/api/v1/public/policies/not-an-address`);
    expect(res.status).toBe(400);
  });

  it("the AUTH bonds endpoint still requires a key (401)", async () => {
    const res = await request(app).get(`/api/v1/bonds/${WALLET}`);
    expect(res.status).toBe(401);
  });
});
