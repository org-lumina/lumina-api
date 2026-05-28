// GET /api/v1/agent/{activity,earnings} — auth-scoped, indexer-backed.
// Mock the indexer Postgres + ethers provider so no real services are needed.

jest.mock("../../src/utils/indexerDb", () => ({
  query: jest.fn(async (sql: string) => {
    if (/policy_purchased/.test(sql)) return []; // activity union
    if (/GROUP BY/.test(sql)) return []; // earnings daily series
    // earnings aggregate scalars
    return [{ v: "672256", issued: "200", redeemed: "0", sales: "0", buys: "0" }];
  }),
  getIndexerSyncState: jest.fn(async () => ({ lastSyncedBlock: 42_000_000n })),
}));

jest.mock("../../src/utils/ethers", () => ({
  provider: { getBlockNumber: jest.fn(async () => 42_000_010) },
  relayer: { address: "0x" + "be".repeat(20) },
  coverRouter: {},
  coverRouterRelayer: {},
  policyManager: {},
  bondVault: {},
  claimBond: {},
  luminaToken: {},
  usdc: {},
  getGlobalPauseRegistry: jest.fn(),
  getShield: jest.fn(),
}));

import request from "supertest";
import { ethers } from "ethers";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";

const app = createApp();
const wallet = ethers.Wallet.createRandom().address;
const apiKey = issueKey(wallet, "dash-test").plaintext;

describe("GET /api/v1/agent/activity", () => {
  it("401 without an API key", async () => {
    const res = await request(app).get("/api/v1/agent/activity");
    expect(res.status).toBe(401);
  });
  it("200 with key — scoped shape + indexer block", async () => {
    const res = await request(app).get("/api/v1/agent/activity").set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(wallet.toLowerCase());
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.indexer.status).toBe("synced"); // lag 10 ≤ 50
  });
});

describe("GET /api/v1/agent/earnings", () => {
  it("401 without an API key", async () => {
    const res = await request(app).get("/api/v1/agent/earnings");
    expect(res.status).toBe(401);
  });
  it("200 with key — computes summary from indexer sums", async () => {
    const res = await request(app).get("/api/v1/agent/earnings").set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    // SUM(premium)=672256 (6-dec) → $0.67; outstanding face = issued 200 - redeemed 0.
    expect(res.body.summary.premiumsPaidUsd).toBeCloseTo(0.67, 2);
    expect(res.body.summary.outstandingFaceUsd).toBe(200);
    expect(res.body.indexer.status).toBe("synced");
  });
});
