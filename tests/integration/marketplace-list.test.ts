// Tests for POST /api/v1/marketplace/list (verifier pattern, mirrors redeem).
//
// The provider + marketplace contract are mocked so realistic Listed events
// can be encoded with the actual ABI's Interface (no real RPC).

const MARKETPLACE_ADDR = "0x863A7fB4A676106db4b03449b01AC5615c6C9D51";
const SELLER = "0x2222222222222222222222222222222222222222";
const ANOTHER = "0x3333333333333333333333333333333333333333";

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
    getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
  };
  const fakeMarketplace = {
    target: MARKETPLACE_ADDR,
    interface: iface,
    minPricePerUnit: jest.fn().mockResolvedValue(1_000_000n), // 1 USDC
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

interface ListedLogParams {
  listingId: string;
  seller: string;
  epochId: string;
  amount: string;
  priceUSDC: string;
}

function buildListedLog(p: ListedLogParams): { address: string; topics: string[]; data: string } {
  const fragment = iface.getEvent("Listed");
  if (!fragment) throw new Error("Listed event missing from ABI fixture");
  const topics = [
    fragment.topicHash,
    ethers.zeroPadValue(ethers.toBeHex(BigInt(p.listingId)), 32),
    ethers.zeroPadValue(p.seller, 32),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(p.epochId)), 32),
  ];
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256"],
    [BigInt(p.amount), BigInt(p.priceUSDC)]
  );
  return { address: MARKETPLACE_ADDR, topics, data };
}

let apiKey: string;

beforeAll(() => {
  const issued = issueKey("0x000000000000000000000000000000000000FACE", "marketplace-test");
  apiKey = issued.plaintext;
});

beforeEach(() => {
  ethersMock.provider.getTransactionReceipt.mockReset();
  ethersMock.marketplace.minPricePerUnit.mockResolvedValue(1_000_000n);
  getDb().prepare("DELETE FROM listings").run();
});

describe("POST /api/v1/marketplace/list (verifier)", () => {
  test("test_HappyPath_ValidListingRecorded", async () => {
    const txHash = "0x" + "a".repeat(64);
    const log = buildListedLog({
      listingId: "5678",
      seller: SELLER,
      epochId: "202804",
      amount: "100",
      priceUSDC: "100000000", // 100 USDC
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: SELLER,
      to: MARKETPLACE_ADDR,
      blockNumber: 12345,
      logs: [log],
    });

    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        sellerAddress: SELLER,
        bondId: "202804",
        amount: "100",
        totalPriceUsdc: "100000000",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.listingId).toBe("5678");
    expect(res.body.blockNumber).toBe(12345);
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = getDb()
      .prepare("SELECT * FROM listings WHERE tx_hash = ?")
      .get(txHash.toLowerCase()) as { listing_id: string; seller_address: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.listing_id).toBe("5678");
    expect(row!.seller_address).toBe(SELLER.toLowerCase());
  });

  test("test_TxNotFound", async () => {
    ethersMock.provider.getTransactionReceipt.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "b".repeat(64),
        sellerAddress: SELLER,
        bondId: "1",
        amount: "1",
        totalPriceUsdc: "1000000",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_not_found");
  });

  test("test_TxReverted", async () => {
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 0,
      from: SELLER,
      to: MARKETPLACE_ADDR,
      blockNumber: 1,
      logs: [],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "c".repeat(64),
        sellerAddress: SELLER,
        bondId: "1",
        amount: "1",
        totalPriceUsdc: "1000000",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_reverted");
  });

  test("test_TxNotMarketplace", async () => {
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: SELLER,
      to: "0x9999999999999999999999999999999999999999",
      blockNumber: 1,
      logs: [],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "d".repeat(64),
        sellerAddress: SELLER,
        bondId: "1",
        amount: "1",
        totalPriceUsdc: "1000000",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_not_marketplace");
  });

  test("test_SellerMismatch", async () => {
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: ANOTHER,
      to: MARKETPLACE_ADDR,
      blockNumber: 1,
      logs: [],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "e".repeat(64),
        sellerAddress: SELLER,
        bondId: "1",
        amount: "1",
        totalPriceUsdc: "1000000",
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("seller_mismatch");
  });

  test("test_PriceBelowMinimum (< 1 USDC, FIX M-3)", async () => {
    // Amount = 100, totalPrice = 99_000_000 (0.99 USDC/unit) — below 1 USDC floor.
    const txHash = "0x" + "f".repeat(64);
    const log = buildListedLog({
      listingId: "111",
      seller: SELLER,
      epochId: "202804",
      amount: "100",
      priceUSDC: "99000000",
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: SELLER,
      to: MARKETPLACE_ADDR,
      blockNumber: 1,
      logs: [log],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        sellerAddress: SELLER,
        bondId: "202804",
        amount: "100",
        totalPriceUsdc: "99000000",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("price_below_min");
    expect(res.body.message).toMatch(/M-3/);
  });

  test("test_DuplicateRegistration (UNIQUE on txHash)", async () => {
    const txHash = "0x" + "1".repeat(64);
    const log = buildListedLog({
      listingId: "222",
      seller: SELLER,
      epochId: "202804",
      amount: "100",
      priceUSDC: "100000000",
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: SELLER,
      to: MARKETPLACE_ADDR,
      blockNumber: 1,
      logs: [log],
    });

    const first = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        sellerAddress: SELLER,
        bondId: "202804",
        amount: "100",
        totalPriceUsdc: "100000000",
      });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash,
        sellerAddress: SELLER,
        bondId: "202804",
        amount: "100",
        totalPriceUsdc: "100000000",
      });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("duplicate_listing");
  });

  test("test_ListingCreatedEventMissing (no Listed in logs)", async () => {
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: SELLER,
      to: MARKETPLACE_ADDR,
      blockNumber: 1,
      logs: [
        {
          address: MARKETPLACE_ADDR,
          topics: [
            ethers.id("SomeOtherEvent(address,uint256)"),
            ethers.zeroPadValue(SELLER, 32),
            ethers.zeroPadValue(ethers.toBeHex(42n), 32),
          ],
          data: "0x",
        },
      ],
    });
    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .set("x-api-key", apiKey)
      .send({
        txHash: "0x" + "2".repeat(64),
        sellerAddress: SELLER,
        bondId: "202804",
        amount: "100",
        totalPriceUsdc: "100000000",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("event_missing");
  });

  test("test_AuthRequired", async () => {
    const res = await request(app)
      .post("/api/v1/marketplace/list")
      .send({
        txHash: "0x" + "3".repeat(64),
        sellerAddress: SELLER,
        bondId: "202804",
        amount: "100",
        totalPriceUsdc: "100000000",
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });
});
