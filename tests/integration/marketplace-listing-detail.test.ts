// Tests for GET /api/v1/marketplace/listings/:listingId — single-listing
// detail. DB-backed; no on-chain calls.

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

const app = createApp();

let txCounter = 0;
function nextTxHash(): string {
  txCounter += 1;
  return "0x" + "f0".padStart(2, "0") + txCounter.toString(16).padStart(62, "0");
}

interface SeedListingArgs {
  listingId: string;
  seller?: string;
  bondId?: string;
  amount?: string;
  totalPriceUsdc?: string;
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
      (args.seller ?? "0x2222222222222222222222222222222222222222").toLowerCase(),
      args.bondId ?? "202804",
      args.amount ?? "100",
      args.totalPriceUsdc ?? "150000000",
      nextTxHash(),
      1,
      args.status ?? "active"
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
  apiKey = freshKey("listing-detail-default");
});

beforeEach(() => {
  getDb().prepare("DELETE FROM purchases").run();
  getDb().prepare("DELETE FROM listings").run();
  txCounter = 0;
});

describe("GET /api/v1/marketplace/listings/:listingId", () => {
  test("returns 404 for a nonexistent listingId", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/listings/999999")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(res.body.message).toMatch(/Listing 999999/);
  });

  test("returns 400 for non-numeric listingId 'abc'", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/listings/abc")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_listing_id");
  });

  test("returns 400 for negative listingId '-1'", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/listings/-1")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_listing_id");
  });

  test("returns 400 for fractional listingId '1.5'", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/listings/1.5")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_listing_id");
  });

  test("returns 400 for zero listingId (1-based)", async () => {
    const res = await request(app)
      .get("/api/v1/marketplace/listings/0")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_listing_id");
  });

  test("returns 200 with full listing shape for a valid id", async () => {
    seedListing({
      listingId: "42",
      seller: "0x2222222222222222222222222222222222222222",
      bondId: "202812",
      amount: "150",
      totalPriceUsdc: "300000000",
      status: "active",
    });

    const res = await request(app)
      .get("/api/v1/marketplace/listings/42")
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        listingId: "42",
        seller: "0x2222222222222222222222222222222222222222",
        bondId: "202812",
        amount: "150",
        totalPriceUsdc: "300000000",
        status: "active",
        blockNumber: 1,
      })
    );
    expect(typeof res.body.txHash).toBe("string");
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("is public — responds 200 without x-api-key", async () => {
    // Single-listing detail mirrors what's already emitted as a Listed
    // event on-chain, so we don't hide it behind auth. The publicIpLimiter
    // mounted in app.ts caps abuse at the IP boundary.
    seedListing({ listingId: "42" });
    const res = await request(app).get("/api/v1/marketplace/listings/42");
    expect(res.status).toBe(200);
    expect(res.body.listingId).toBe("42");
  });
});
