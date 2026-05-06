// Tests for GET /api/v1/marketplace/history — paginated trade history.
//
// DB-backed (purchases table). No on-chain calls; ethers util is stubbed
// just so module load works.

const MARKETPLACE_ADDR = "0x863A7fB4A676106db4b03449b01AC5615c6C9D51";

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getTransactionReceipt: jest.fn(),
    getBlock: jest.fn(),
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  };
  return {
    provider: fakeProvider,
    relayer: { address: "0x0000000000000000000000000000000000000001" },
    coverRouter: {},
    coverRouterRelayer: {},
    policyManager: {},
    claimBond: {},
    bondVault: {},
    luminaToken: {},
    usdc: {},
    marketplace: { target: MARKETPLACE_ADDR },
  };
});

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";
import { getDb } from "../../src/db/database";
import { _resetMarketplaceCaches } from "../../src/services/marketplace";

const app = createApp();

let txCounter = 0;
function nextTxHash(prefix = "ee"): string {
  txCounter += 1;
  const tag = prefix.padStart(2, "0").slice(-2);
  return "0x" + tag + txCounter.toString(16).padStart(62, "0");
}

interface SeedTradeArgs {
  listingId: string;
  totalPaidUsdc: string;
  executedAtMs: number;
}

function seedTrade(args: SeedTradeArgs): void {
  // FK-correct seeding: listings row first (status='executed'), then purchase.
  getDb()
    .prepare(
      `INSERT INTO listings (listing_id, seller_address, bond_id, amount, total_price_usdc, tx_hash, block_number, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.listingId,
      "0x2222222222222222222222222222222222222222",
      "202804",
      "100",
      args.totalPaidUsdc,
      nextTxHash("aa"),
      1,
      "executed"
    );
  getDb()
    .prepare(
      `INSERT INTO purchases (listing_id, buyer_address, seller_address, bond_id, amount, total_paid_usdc, tx_hash, block_number, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.listingId,
      "0x3333333333333333333333333333333333333333",
      "0x2222222222222222222222222222222222222222",
      "202804",
      "100",
      args.totalPaidUsdc,
      nextTxHash("bb"),
      1,
      args.executedAtMs
    );
}

let apiKey: string;
let walletCounter = 0;
function freshKey(label: string): string {
  walletCounter += 1;
  const wallet = "0x" + walletCounter.toString(16).padStart(40, "0");
  return issueKey(wallet, label).plaintext;
}

beforeAll(() => {
  apiKey = freshKey("history-default");
});

beforeEach(() => {
  getDb().prepare("DELETE FROM purchases").run();
  getDb().prepare("DELETE FROM listings").run();
  txCounter = 0;
  _resetMarketplaceCaches();
});

describe("GET /api/v1/marketplace/history", () => {
  test("returns array with default limit=50 and offset=0", async () => {
    const now = Date.now();
    seedTrade({ listingId: "1", totalPaidUsdc: "100", executedAtMs: now - 3_000 });
    seedTrade({ listingId: "2", totalPaidUsdc: "200", executedAtMs: now - 2_000 });
    seedTrade({ listingId: "3", totalPaidUsdc: "300", executedAtMs: now - 1_000 });

    const res = await request(app)
      .get("/api/v1/marketplace/history")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.trades)).toBe(true);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.count).toBe(3);
    // Newest first → listingId 3, 2, 1.
    expect(res.body.trades.map((t: { listingId: string }) => t.listingId)).toEqual([
      "3",
      "2",
      "1",
    ]);
    // Trade shape sanity-check.
    const t = res.body.trades[0];
    expect(t).toEqual(
      expect.objectContaining({
        listingId: "3",
        buyer: "0x3333333333333333333333333333333333333333",
        seller: "0x2222222222222222222222222222222222222222",
        bondId: "202804",
        amount: "100",
        totalPaidUsdc: "300",
        blockNumber: 1,
      })
    );
    expect(typeof t.txHash).toBe("string");
    expect(t.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("paginates correctly with limit + offset", async () => {
    const now = Date.now();
    // Seed 5 trades with strictly-increasing timestamps so DESC order is
    // deterministic regardless of insertion order.
    for (let i = 0; i < 5; i++) {
      seedTrade({
        listingId: String(i + 1),
        totalPaidUsdc: String((i + 1) * 100),
        executedAtMs: now - (5 - i) * 1_000,
      });
    }

    const page1 = await request(app)
      .get("/api/v1/marketplace/history?limit=2&offset=0")
      .set("x-api-key", apiKey);
    expect(page1.status).toBe(200);
    expect(page1.body.trades.map((t: { listingId: string }) => t.listingId)).toEqual([
      "5",
      "4",
    ]);
    expect(page1.body.count).toBe(2);

    const page2 = await request(app)
      .get("/api/v1/marketplace/history?limit=2&offset=2")
      .set("x-api-key", apiKey);
    expect(page2.status).toBe(200);
    expect(page2.body.trades.map((t: { listingId: string }) => t.listingId)).toEqual([
      "3",
      "2",
    ]);

    const page3 = await request(app)
      .get("/api/v1/marketplace/history?limit=2&offset=4")
      .set("x-api-key", apiKey);
    expect(page3.status).toBe(200);
    expect(page3.body.trades.map((t: { listingId: string }) => t.listingId)).toEqual([
      "1",
    ]);
  });

  test("returns 400 on non-numeric limit", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/history?limit=abc")
      .set("x-api-key", apiKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  test("returns 400 on non-numeric offset", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/history?offset=xyz")
      .set("x-api-key", apiKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  test("returns 400 when limit exceeds 100", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/history?limit=500")
      .set("x-api-key", apiKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  test("requires authentication", async () => {
    const res = await request(app).get("/api/v1/marketplace/history");
    expect(res.status).toBe(401);
  });
});
