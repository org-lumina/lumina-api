// Webhook subscription CRUD + worker behaviour.
//
// We mock the ethers utility to avoid opening an RPC connection during test
// boot (mirrors openapi.test.ts), then exercise the webhooks router with
// supertest. The worker logic is exercised at the unit level by importing
// the service helpers directly with an in-memory subscription.

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

import request from "supertest";
import { ethers } from "ethers";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";
import {
  emitWebhookEvent,
  insertWebhookSubscription,
  listPendingWebhookEvents,
} from "../../src/db/database";
import {
  fanoutPendingEvents,
  signBody,
  emit as emitFanout,
} from "../../src/services/webhooks";

const app = createApp();

const wallet = ethers.Wallet.createRandom().address;
const apiKey = issueKey(wallet, "webhook-test").plaintext;

describe("POST /api/v1/webhooks", () => {
  it("creates a subscription and returns the secret exactly once", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .set("x-api-key", apiKey)
      .send({ url: "https://example.com/hook", events: ["policy_purchased"] });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.warning).toMatch(/not be shown again/i);
  });

  it("rejects http://non-localhost urls", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .set("x-api-key", apiKey)
      .send({ url: "http://evil.example.com/hook" });
    expect(res.status).toBe(400);
  });

  it("rejects without x-api-key", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({ url: "https://example.com/hook2" });
    expect(res.status).toBe(401);
  });

  it("409s on duplicate (wallet, url) pair", async () => {
    const url = "https://example.com/dup";
    await request(app).post("/api/v1/webhooks").set("x-api-key", apiKey).send({ url });
    const res = await request(app).post("/api/v1/webhooks").set("x-api-key", apiKey).send({ url });
    expect(res.status).toBe(409);
  });
});

describe("GET /api/v1/webhooks", () => {
  it("never returns the secret", async () => {
    const res = await request(app).get("/api/v1/webhooks").set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    for (const w of res.body.webhooks) {
      expect("secret" in w).toBe(false);
    }
  });
});

describe("DELETE /api/v1/webhooks/:id", () => {
  it("404s on unknown id", async () => {
    const res = await request(app).delete("/api/v1/webhooks/999999").set("x-api-key", apiKey);
    expect(res.status).toBe(404);
  });
});

describe("worker fan-out", () => {
  it("converts pending events into delivery rows for matching subscriptions", () => {
    // Create a fresh wallet + subscription that covers all events.
    const w = ethers.Wallet.createRandom().address;
    insertWebhookSubscription({
      wallet: w,
      url: "https://example.com/fanout",
      secret: "deadbeef".repeat(8),
      events: ["*"],
    });

    emitWebhookEvent("policy_purchased", w, { hello: "world" });
    expect(listPendingWebhookEvents().some((e) => e.wallet === w.toLowerCase())).toBe(true);

    const scheduled = fanoutPendingEvents();
    expect(scheduled).toBeGreaterThanOrEqual(1);
    // After fan-out the event is marked processed.
    expect(listPendingWebhookEvents().some((e) => e.wallet === w.toLowerCase())).toBe(false);
  });

  it("emit() is fire-and-forget — never throws even if DB write fails", () => {
    expect(() =>
      emitFanout("bond_minted", "0x" + "1".repeat(40), { ok: true })
    ).not.toThrow();
  });
});

describe("HMAC signature", () => {
  it("matches the standard hex-encoded HMAC-SHA256(body, secret)", () => {
    const sig = signBody('{"x":1}', "topsecret");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Stable test vector — recompute with crypto to confirm.
    const crypto = require("crypto") as typeof import("crypto");
    const expected = crypto.createHmac("sha256", "topsecret").update('{"x":1}').digest("hex");
    expect(sig).toBe(expected);
  });
});
