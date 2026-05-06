// Tests for GET /api/v1/marketplace/listings — discovery endpoint that lets
// off-chain agents scan available listings without resorting to eth_getLogs.
//
// The endpoint is read-only (no on-chain calls), so the ethers mock here is
// minimal — just enough for `src/utils/ethers.ts` and `createApp()` to load
// without contacting the RPC.

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

const app = createApp();

interface SeedListingArgs {
  listingId: string;
  seller?: string;
  bondId?: string;
  amount?: string;
  totalPriceUsdc: string;
  txHash?: string;
  blockNumber?: number;
  status?: string;
  createdAt?: number; // ms since epoch
}

let seedTxCounter = 0;
function nextTxHash(): string {
  seedTxCounter += 1;
  return "0x" + seedTxCounter.toString(16).padStart(64, "0");
}

function seedListing(args: SeedListingArgs): void {
  const txHash = (args.txHash ?? nextTxHash()).toLowerCase();
  if (args.createdAt !== undefined) {
    getDb()
      .prepare(
        `INSERT INTO listings (listing_id, seller_address, bond_id, amount, total_price_usdc, tx_hash, block_number, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        args.listingId,
        (args.seller ?? "0x2222222222222222222222222222222222222222").toLowerCase(),
        args.bondId ?? "202804",
        args.amount ?? "100",
        args.totalPriceUsdc,
        txHash,
        args.blockNumber ?? 1,
        args.status ?? "active",
        args.createdAt
      );
  } else {
    getDb()
      .prepare(
        `INSERT INTO listings (listing_id, seller_address, bond_id, amount, total_price_usdc, tx_hash, block_number, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        args.listingId,
        (args.seller ?? "0x2222222222222222222222222222222222222222").toLowerCase(),
        args.bondId ?? "202804",
        args.amount ?? "100",
        args.totalPriceUsdc,
        txHash,
        args.blockNumber ?? 1,
        args.status ?? "active"
      );
  }
}

let apiKey: string;
let walletCounter = 0;
function freshKey(label: string): string {
  walletCounter += 1;
  const wallet = "0x" + walletCounter.toString(16).padStart(40, "0");
  return issueKey(wallet, label).plaintext;
}

beforeAll(() => {
  apiKey = freshKey("listings-default");
});

beforeEach(() => {
  getDb().prepare("DELETE FROM purchases").run();
  getDb().prepare("DELETE FROM listings").run();
  seedTxCounter = 0;
});

describe("GET /api/v1/marketplace/listings", () => {
  test("test_EmptyStore_ReturnsEmpty", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/listings")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.total).toBe(0);
    expect(res.body.listings).toEqual([]);
  });

  test("test_DefaultSort_PriceAsc", async () => {
    seedListing({ listingId: "1", totalPriceUsdc: "300000000" });
    seedListing({ listingId: "2", totalPriceUsdc: "100000000" });
    seedListing({ listingId: "3", totalPriceUsdc: "200000000" });

    const res = await request(app)
      .get("/api/v1/marketplace/listings")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.total).toBe(3);
    expect(res.body.listings.map((l: { listingId: string }) => l.listingId)).toEqual([
      "2",
      "3",
      "1",
    ]);
    // Shape sanity-check on a single row.
    const first = res.body.listings[0];
    expect(first).toEqual(
      expect.objectContaining({
        listingId: "2",
        seller: "0x2222222222222222222222222222222222222222",
        bondId: "202804",
        amount: "100",
        totalPriceUsdc: "100000000",
        status: "active",
      })
    );
    expect(typeof first.txHash).toBe("string");
    expect(typeof first.blockNumber).toBe("number");
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("test_FilterMaxPriceUsdc", async () => {
    seedListing({ listingId: "10", totalPriceUsdc: "50000000" });
    seedListing({ listingId: "11", totalPriceUsdc: "150000000" });
    seedListing({ listingId: "12", totalPriceUsdc: "250000000" });

    const res = await request(app)
      .get("/api/v1/marketplace/listings?maxPriceUsdc=150000000")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.total).toBe(2);
    expect(res.body.listings.map((l: { listingId: string }) => l.listingId)).toEqual([
      "10",
      "11",
    ]);
  });

  test("test_PaginationLimitOffset", async () => {
    // Five listings priced 1, 2, 3, 4, 5 USDC.
    seedListing({ listingId: "a", totalPriceUsdc: "1000000" });
    seedListing({ listingId: "b", totalPriceUsdc: "2000000" });
    seedListing({ listingId: "c", totalPriceUsdc: "3000000" });
    seedListing({ listingId: "d", totalPriceUsdc: "4000000" });
    seedListing({ listingId: "e", totalPriceUsdc: "5000000" });

    const res = await request(app)
      .get("/api/v1/marketplace/listings?limit=2&offset=1")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    // total ignores limit/offset — full count of matching rows.
    expect(res.body.total).toBe(5);
    expect(res.body.listings.map((l: { listingId: string }) => l.listingId)).toEqual([
      "b",
      "c",
    ]);
  });

  test("test_SortByPriceDesc", async () => {
    seedListing({ listingId: "1", totalPriceUsdc: "300000000" });
    seedListing({ listingId: "2", totalPriceUsdc: "100000000" });
    seedListing({ listingId: "3", totalPriceUsdc: "200000000" });

    const res = await request(app)
      .get("/api/v1/marketplace/listings?sortBy=price-desc")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.listings.map((l: { listingId: string }) => l.listingId)).toEqual([
      "1",
      "3",
      "2",
    ]);
  });

  test("test_OnlyActiveListings_ExecutedExcluded", async () => {
    seedListing({ listingId: "active1", totalPriceUsdc: "100000000" });
    seedListing({
      listingId: "executed1",
      totalPriceUsdc: "50000000",
      status: "executed",
    });

    const res = await request(app)
      .get("/api/v1/marketplace/listings")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.listings[0].listingId).toBe("active1");
  });

  test("test_PublicAccess_NoApiKeyOk", async () => {
    // Marketplace browse is a read-only view of public on-chain state, so
    // the GET is mounted on `marketplacePublicRouter` and bypasses
    // x-api-key. publicIpLimiter still gates per-IP abuse.
    seedListing({ listingId: "1", totalPriceUsdc: "100000000" });

    const res = await request(app).get("/api/v1/marketplace/listings");

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.listings[0].listingId).toBe("1");
  });

  test("test_InvalidSortBy_ReturnsValidationError", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/listings?sortBy=bogus")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.some((d: { path: string }) => d.path === "sortBy")).toBe(true);
  });
});
