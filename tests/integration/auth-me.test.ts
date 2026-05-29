// Tests for GET /api/v1/auth/me — wallet introspection used by the SDK
// to auto-resolve the calling wallet for bonds.list / policies.list.

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(12345),
    getBalance: jest.fn().mockResolvedValue(BigInt("123000000000000000")),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
  };
  return {
    provider: fakeProvider,
    relayer: { address: "0x000000000000000000000000000000000000BEEF" },
    coverRouter: {},
    policyManager: {},
    coverRouterRelayer: {},
    claimBond: {},
    bondVault: { target: "0x000000000000000000000000000000000000B00D" },
    luminaToken: {},
    usdc: {},
    getGlobalPauseRegistry: jest.fn().mockResolvedValue(undefined),
    getShield: jest.fn(),
  };
});

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";

const app = createApp();
const WALLET = "0x000000000000000000000000000000000000FACE";

describe("GET /api/v1/auth/me", () => {
  it("returns the wallet, prefix, and tier for a valid API key", async () => {
    const issued = issueKey(WALLET, "auth-me-test");
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-api-key", issued.plaintext);

    expect(res.status).toBe(200);
    expect(res.body.wallet.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(res.body.tier).toBe("free");
    expect(typeof res.body.apiKeyPrefix).toBe("string");
    // Format: "lk_" + 8 hex chars = 11 chars total. NEVER full key.
    expect(res.body.apiKeyPrefix).toBe(issued.plaintext.slice(0, 11));
    expect(res.body.apiKeyPrefix.length).toBe(11);
  });

  it("returns 401 without x-api-key header", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code ?? res.body.error).toBe("missing_api_key");
  });

  it("returns 401 with malformed key", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-api-key", "not-a-real-key");
    expect(res.status).toBe(401);
  });

  it("returns 401 with valid-format but unknown key", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-api-key", "lk_" + "0".repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.code ?? res.body.error).toBe("invalid_api_key");
  });
});
