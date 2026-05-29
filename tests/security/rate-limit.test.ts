// Rate-limit behaviour. The implementation uses express-rate-limit with
// a per-tier max picked dynamically from req.agent.tier. Free tier ceiling
// is 10 req/min; admin endpoints are 20/min by IP.

jest.mock("../../src/utils/ethers", () => ({
  provider: {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
  },
  relayer: { address: "0x0000000000000000000000000000000000000001" },
  coverRouter: {},
  policyManager: {},
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

describe("rate limit: GET /api/v1/policies (free tier = 10/min)", () => {
  let key: string;

  beforeAll(() => {
    const issued = issueKey("0x000000000000000000000000000000000000F00D", "rl-test");
    key = issued.plaintext;
  });

  test("first 10 requests succeed; 11th returns 429", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const r = await request(app).get("/api/v1/policies").set("x-api-key", key);
      lastStatus = r.status;
      expect([200, 401, 429]).toContain(r.status);
    }
    expect(lastStatus).toBe(200);

    // Eleventh in the same window: should be 429.
    const eleventh = await request(app).get("/api/v1/policies").set("x-api-key", key);
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error).toBe("rate_limited");
  });
});

describe("rate limit isolation between API keys", () => {
  test("a different agent's key has its own counter", async () => {
    const a = issueKey("0x000000000000000000000000000000000000AAAA", "rl-a");
    const b = issueKey("0x000000000000000000000000000000000000BBBB", "rl-b");

    // Burn through A's quota.
    let aLast = 0;
    for (let i = 0; i < 10; i++) {
      const r = await request(app).get("/api/v1/policies").set("x-api-key", a.plaintext);
      aLast = r.status;
    }
    expect(aLast).toBe(200);

    // A is now over the limit.
    const aNext = await request(app).get("/api/v1/policies").set("x-api-key", a.plaintext);
    expect(aNext.status).toBe(429);

    // B should still have its full quota.
    const bFirst = await request(app).get("/api/v1/policies").set("x-api-key", b.plaintext);
    expect(bFirst.status).toBe(200);
  });
});
