// Tests for POST /api/v1/marketplace/buy (verifier pattern, last endpoint of
// block A.1).

const MARKETPLACE_ADDR = "0x863A7fB4A676106db4b03449b01AC5615c6C9D51";
const SELLER = "0x2222222222222222222222222222222222222222";
const BUYER  = "0x3333333333333333333333333333333333333333";
const ANOTHER = "0x4444444444444444444444444444444444444444";

jest.mock("../../src/utils/ethers", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ethers: realEthers } = require("ethers");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const artifact = require("../../abis/LuminaBondMarketplace.json");
  const iface = new realEthers.Interface(artifact.abi);

  const fakeProvider = {
    getTransactionReceipt: jest.fn(),
    getBlock: jest.fn().mockResolvedValue({ timestamp: 1_777_000_000 }),
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
  };
  const fakeMarketplace = {
    target: MARKETPLACE_ADDR,
    interface: iface,
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
    marketplace: fakeMarketplace,
  };
});

import request from "supertest";
import { ethers } from "ethers";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";
import { getDb } from "../../src/db/database";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ethersMock = require("../../src/utils/ethers");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const marketplaceArtifact = require("../../abis/LuminaBondMarketplace.json");

const app = createApp();
const iface = new ethers.Interface(marketplaceArtifact.abi);

interface BoughtLogParams {
  listingId: string;
  buyer: string;
  seller: string;
  priceUSDC: string;
  sellerFee: string;
  buyerFee: string;
}

function buildBoughtLog(p: BoughtLogParams): { address: string; topics: string[]; data: string } {
  const fragment = iface.getEvent("Bought");
  if (!fragment) throw new Error("Bought event missing from ABI");
  const topics = [
    fragment.topicHash,
    ethers.zeroPadValue(ethers.toBeHex(BigInt(p.listingId)), 32),
    ethers.zeroPadValue(p.buyer, 32),
    ethers.zeroPadValue(p.seller, 32),
  ];
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "uint256"],
    [BigInt(p.priceUSDC), BigInt(p.sellerFee), BigInt(p.buyerFee)]
  );
  return { address: MARKETPLACE_ADDR, topics, data };
}

let apiKey: string;
let agentCounter = 0;
function freshWallet(): string {
  // 12 tests in this file with shared per-agent rate limit (10/min).
  // Use a fresh wallet per test so the limiter resets between cases.
  agentCounter += 1;
  return "0x" + agentCounter.toString(16).padStart(40, "0");
}

interface SeedListingArgs {
  listingId: string;
  amount: string;
  bondId: string;
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
      SELLER.toLowerCase(),
      args.bondId,
      args.amount,
      args.totalPriceUsdc,
      "0x" + "0".repeat(63) + args.listingId.slice(-1), // unique-ish per listing
      100,
      args.status ?? "active"
    );
}

beforeEach(() => {
  ethersMock.provider.getTransactionReceipt.mockReset();
  getDb().prepare("DELETE FROM purchases").run();
  getDb().prepare("DELETE FROM listings").run();
  apiKey = issueKey(freshWallet(), "marketplace-buy-test").plaintext;
});

const HAPPY_LISTING_ID = "5678";
const HAPPY_BOND_ID = "202804";
const HAPPY_AMOUNT = "100";
const HAPPY_PRICE_USDC = "100000000";       // 100 USDC listed
const HAPPY_BUYER_FEE = "1000000";          // 1 USDC buyer fee (1%)
const HAPPY_SELLER_FEE = "500000";          // 0.5 USDC seller fee
const HAPPY_TOTAL_PAID = "101000000";       // 100 + 1 = 101 USDC

describe("POST /api/v1/marketplace/buy (verifier)", () => {
  test("test_HappyPath_ValidPurchaseRecorded", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID,
      amount: HAPPY_AMOUNT,
      bondId: HAPPY_BOND_ID,
      totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    const txHash = "0x" + "a".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: BUYER,
      to: MARKETPLACE_ADDR,
      blockNumber: 12345,
      logs: [
        buildBoughtLog({
          listingId: HAPPY_LISTING_ID,
          buyer: BUYER,
          seller: SELLER,
          priceUSDC: HAPPY_PRICE_USDC,
          sellerFee: HAPPY_SELLER_FEE,
          buyerFee: HAPPY_BUYER_FEE,
        }),
      ],
    });

    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER.toLowerCase(),
        sellerAddress: SELLER.toLowerCase(),
        bondId: HAPPY_BOND_ID,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
        blockNumber: 12345,
      })
    );
    expect(res.body.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("test_ListingNotFound (en DB)", async () => {
    const txHash = "0x" + "b".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1, from: BUYER, to: MARKETPLACE_ADDR, blockNumber: 1, logs: [],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        listingId: "9999",
        buyerAddress: BUYER,
        amount: "100",
        totalPaidUsdc: "1000000",
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("listing_not_found");
  });

  test("test_ListingNotActive (status='executed')", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID,
      amount: HAPPY_AMOUNT,
      bondId: HAPPY_BOND_ID,
      totalPriceUsdc: HAPPY_PRICE_USDC,
      status: "executed",
    });
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "c".repeat(64),
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("listing_not_active");
  });

  test("test_TxNotFound", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: HAPPY_AMOUNT, bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "d".repeat(64),
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_not_found");
  });

  test("test_TxReverted", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: HAPPY_AMOUNT, bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 0, from: BUYER, to: MARKETPLACE_ADDR, blockNumber: 1, logs: [],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "e".repeat(64),
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_reverted");
  });

  test("test_BuyerMismatch", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: HAPPY_AMOUNT, bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: ANOTHER, // ≠ buyerAddress
      to: MARKETPLACE_ADDR,
      blockNumber: 1,
      logs: [],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "f".repeat(64),
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("buyer_mismatch");
  });

  test("test_AmountMismatch", async () => {
    // Listing's amount is 100; body says 50.
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: "100", bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    const txHash = "0x" + "1".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1, from: BUYER, to: MARKETPLACE_ADDR, blockNumber: 1,
      logs: [
        buildBoughtLog({
          listingId: HAPPY_LISTING_ID, buyer: BUYER, seller: SELLER,
          priceUSDC: HAPPY_PRICE_USDC, sellerFee: HAPPY_SELLER_FEE, buyerFee: HAPPY_BUYER_FEE,
        }),
      ],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: "50", // mismatch
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("amount_mismatch");
  });

  test("test_PriceMismatch", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: HAPPY_AMOUNT, bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    const txHash = "0x" + "2".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1, from: BUYER, to: MARKETPLACE_ADDR, blockNumber: 1,
      logs: [
        buildBoughtLog({
          listingId: HAPPY_LISTING_ID, buyer: BUYER, seller: SELLER,
          priceUSDC: HAPPY_PRICE_USDC, sellerFee: HAPPY_SELLER_FEE, buyerFee: HAPPY_BUYER_FEE,
        }),
      ],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: "999999999", // wrong total
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("price_mismatch");
  });

  test("test_DuplicateRegistration", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: HAPPY_AMOUNT, bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    const txHash = "0x" + "3".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1, from: BUYER, to: MARKETPLACE_ADDR, blockNumber: 1,
      logs: [
        buildBoughtLog({
          listingId: HAPPY_LISTING_ID, buyer: BUYER, seller: SELLER,
          priceUSDC: HAPPY_PRICE_USDC, sellerFee: HAPPY_SELLER_FEE, buyerFee: HAPPY_BUYER_FEE,
        }),
      ],
    });

    const first = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash, listingId: HAPPY_LISTING_ID, buyerAddress: BUYER,
        amount: HAPPY_AMOUNT, totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash, listingId: HAPPY_LISTING_ID, buyerAddress: BUYER,
        amount: HAPPY_AMOUNT, totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("duplicate_purchase");
  });

  test("test_PurchaseEventMissing", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: HAPPY_AMOUNT, bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1, from: BUYER, to: MARKETPLACE_ADDR, blockNumber: 1,
      logs: [
        {
          address: MARKETPLACE_ADDR,
          topics: [
            ethers.id("SomeOtherEvent(address,uint256)"),
            ethers.zeroPadValue(BUYER, 32),
            ethers.zeroPadValue(ethers.toBeHex(42n), 32),
          ],
          data: "0x",
        },
      ],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "4".repeat(64),
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("event_missing");
  });

  test("test_AuthRequired", async () => {
    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .send({
        txHash: "0x" + "5".repeat(64),
        listingId: HAPPY_LISTING_ID,
        buyerAddress: BUYER,
        amount: HAPPY_AMOUNT,
        totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });

  test("test_ListingStatusUpdatedToExecuted", async () => {
    seedListing({
      listingId: HAPPY_LISTING_ID, amount: HAPPY_AMOUNT, bondId: HAPPY_BOND_ID, totalPriceUsdc: HAPPY_PRICE_USDC,
    });
    const txHash = "0x" + "6".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1, from: BUYER, to: MARKETPLACE_ADDR, blockNumber: 1,
      logs: [
        buildBoughtLog({
          listingId: HAPPY_LISTING_ID, buyer: BUYER, seller: SELLER,
          priceUSDC: HAPPY_PRICE_USDC, sellerFee: HAPPY_SELLER_FEE, buyerFee: HAPPY_BUYER_FEE,
        }),
      ],
    });

    const res = await request(app)
      .post("/api/v1/marketplace/buy")
      .set("x-api-key", apiKey)
      .send({
        txHash, listingId: HAPPY_LISTING_ID, buyerAddress: BUYER,
        amount: HAPPY_AMOUNT, totalPaidUsdc: HAPPY_TOTAL_PAID,
      });
    expect(res.status).toBe(200);

    const listingRow = getDb()
      .prepare("SELECT status FROM listings WHERE listing_id = ?")
      .get(HAPPY_LISTING_ID) as { status: string };
    expect(listingRow.status).toBe("executed");
  });
});
