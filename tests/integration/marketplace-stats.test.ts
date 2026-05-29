// Tests for GET /api/v1/marketplace/stats — Phase 2 macro snapshot.
//
// The endpoint reads exclusively from the local SQLite store (listings +
// purchases tables), so no on-chain wiring is required. The ethers mock
// here just stops `src/utils/ethers.ts` from opening a real provider.

const MARKETPLACE_ADDR = "0x863A7fB4A676106db4b03449b01AC5615c6C9D51";

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getTransactionReceipt: jest.fn(),
    getBlock: jest.fn(),
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
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
function nextTxHash(prefix = ""): string {
  txCounter += 1;
  // Prefix with whatever distinguishing tag the caller wants so two seeds
  // in the same test never collide on the listings.tx_hash UNIQUE.
  const tag = prefix.padStart(2, "0").slice(-2);
  return "0x" + tag + txCounter.toString(16).padStart(62, "0");
}

interface SeedListingArgs {
  listingId: string;
  totalPriceUsdc: string;
  status?: string;
}

function seedListing(args: SeedListingArgs): void {
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
      args.totalPriceUsdc,
      nextTxHash("aa"),
      1,
      args.status ?? "active"
    );
}

interface SeedPurchaseArgs {
  listingId: string;
  totalPaidUsdc: string;
  executedAtMs?: number; // null → falls back to created_at
}

function seedPurchase(args: SeedPurchaseArgs): void {
  // Purchases referencing listings — listing_id has a FK to listings(listing_id).
  // Seed a synthetic listing first so the FK holds.
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
      nextTxHash("bb"),
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
      nextTxHash("cc"),
      1,
      args.executedAtMs ?? null
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
  apiKey = freshKey("stats-default");
});

beforeEach(() => {
  getDb().prepare("DELETE FROM purchases").run();
  getDb().prepare("DELETE FROM listings").run();
  txCounter = 0;
  _resetMarketplaceCaches();
});

describe("GET /api/v1/marketplace/stats", () => {
  test("returns the four-field shape on an empty store", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/stats")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      floor: "0",
      volume24h: "0",
      totalListings: 0,
      totalVolume: "0",
    });
  });

  test("floor is the min totalPriceUsdc across active listings", async () => {
    seedListing({ listingId: "1", totalPriceUsdc: "300000000" });
    seedListing({ listingId: "2", totalPriceUsdc: "100000000" });
    seedListing({ listingId: "3", totalPriceUsdc: "200000000" });
    // Executed listings should NOT influence the floor.
    seedListing({ listingId: "4", totalPriceUsdc: "1", status: "executed" });

    const res = await request(app)
      .get("/api/v1/marketplace/stats")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.floor).toBe("100000000");
    expect(res.body.totalListings).toBe(3);
    // Floor is a positive uint string (or "0" only when book is empty).
    expect(res.body.floor).toMatch(/^\d+$/);
    expect(BigInt(res.body.floor) > 0n).toBe(true);
  });

  test("volume24h sums purchases inside the 24h window only", async () => {
    const now = Date.now();
    seedPurchase({ listingId: "10", totalPaidUsdc: "500000", executedAtMs: now - 1_000 });
    seedPurchase({ listingId: "11", totalPaidUsdc: "1500000", executedAtMs: now - 60_000 });
    // Older than 24h — must be excluded from volume24h, but still counted in totalVolume.
    seedPurchase({
      listingId: "12",
      totalPaidUsdc: "9999999",
      executedAtMs: now - 25 * 60 * 60 * 1000,
    });

    const res = await request(app)
      .get("/api/v1/marketplace/stats")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.volume24h).toBe("2000000");
    expect(res.body.totalVolume).toBe(String(500000 + 1500000 + 9999999));
  });

  test("cache hit returns identical data within 30s TTL", async () => {
    seedListing({ listingId: "1", totalPriceUsdc: "100" });

    const first = await request(app)
      .get("/api/v1/marketplace/stats")
      .set("x-api-key", apiKey);

    expect(first.status).toBe(200);
    expect(first.body.totalListings).toBe(1);

    // Mutate the underlying store. If the cache is honoured, the second call
    // must NOT pick this up.
    seedListing({ listingId: "2", totalPriceUsdc: "5" });

    const second = await request(app)
      .get("/api/v1/marketplace/stats")
      .set("x-api-key", apiKey);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    // Reset the cache and confirm fresh data flows through.
    _resetMarketplaceCaches();
    const third = await request(app)
      .get("/api/v1/marketplace/stats")
      .set("x-api-key", apiKey);

    expect(third.status).toBe(200);
    expect(third.body.totalListings).toBe(2);
    expect(third.body.floor).toBe("5");
  });

  test("is public — responds 200 without x-api-key", async () => {
    // Marketplace GETs are read-only views of on-chain-public data
    // (listings, completed trades, floor) and intentionally require no
    // auth, mirroring /products. The IP limiter (publicIpLimiter) still
    // gates abuse at the IP boundary.
    const res = await request(app).get("/api/v1/marketplace/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        floor: expect.any(String),
        volume24h: expect.any(String),
        totalListings: expect.any(Number),
        totalVolume: expect.any(String),
      })
    );
  });
});
