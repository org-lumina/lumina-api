// V5.1 surface tests for GET /policies/:productId/:policyId
//
// Covers:
//   - All V5.1 fields exposed (policyId, productId, productName, holder,
//     coverageAmount, premiumPaid, purchasedAt, waitingEndsAt, expiresAt,
//     status, priceSnapshot, productActive, triggeredAt, bondId)
//   - 404 when buyer is address(0)
//   - Triggered policy returns bondId from BondIssued event in same tx
//   - Deactivated product returns productActive=false (policy still readable)
//   - priceSnapshot surfaced (H-6)

import { ethers } from "ethers";

const BTC_24H_PRODUCT_ID = ethers.keccak256(ethers.toUtf8Bytes("FLASHBTC24-001"));
const SHIELD_ADDR = "0x000000000000000000000000000000000000FEED";
const BOND_VAULT_ADDR = "0x000000000000000000000000000000000000B00D";
const HOLDER = "0x000000000000000000000000000000000000abcd";
const TRIGGER_TX_HASH = "0x" + "1".repeat(64);

const fakePolicyManager: {
  policies: jest.Mock;
  productActive: jest.Mock;
  policyPriceSnapshot: jest.Mock;
  productShield: jest.Mock;
  filters: { PolicyTriggered: jest.Mock };
  queryFilter: jest.Mock;
} = {
  policies: jest.fn(),
  productActive: jest.fn(),
  policyPriceSnapshot: jest.fn(),
  productShield: jest.fn().mockResolvedValue(SHIELD_ADDR),
  filters: { PolicyTriggered: jest.fn(() => ({})) },
  queryFilter: jest.fn(),
};

const fakeShield: { getPolicyInfo: jest.Mock; target: string } = {
  getPolicyInfo: jest.fn(),
  target: SHIELD_ADDR,
};

const fakeProvider: { getBlock: jest.Mock; getTransactionReceipt: jest.Mock } = {
  getBlock: jest.fn(),
  getTransactionReceipt: jest.fn(),
};

jest.mock("../../src/utils/ethers", () => ({
  provider: fakeProvider,
  relayer: { address: "0x000000000000000000000000000000000000BEEF" },
  coverRouter: {},
  coverRouterRelayer: {},
  policyManager: fakePolicyManager,
  claimBond: {},
  bondVault: { target: BOND_VAULT_ADDR },
  luminaToken: {},
  usdc: {},
  getShield: jest.fn(() => fakeShield),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

const ACTIVE_POLICY_RECORD = [
  BTC_24H_PRODUCT_ID,
  SHIELD_ADDR,
  HOLDER,
  1_000_000_000n,
  800_000_000n,
  1_000_000n,
  1_700_000_000n, // createdAt = purchasedAt
  1_700_003_600n, // expiresAt
  false,          // triggered
  false,          // expired
];

const ACTIVE_SHIELD_INFO = [
  1n,                          // policyId
  HOLDER,                      // insuredAgent
  1_000_000_000n,              // coverageAmount
  1_000_000n,                  // premiumPaid
  800_000_000n,                // maxPayout
  1_700_000_000n,              // startTimestamp
  1_700_001_800n,              // waitingEndsAt
  1_700_003_600n,              // expiresAt
  1_700_007_200n,              // cleanupAt
  2,                           // status enum: ACTIVE
];

beforeEach(() => {
  jest.clearAllMocks();
  // Re-bind constant return values cleared by clearAllMocks.
  fakePolicyManager.productShield.mockResolvedValue(SHIELD_ADDR);
  fakePolicyManager.policies.mockResolvedValue(ACTIVE_POLICY_RECORD);
  fakePolicyManager.productActive.mockResolvedValue(true);
  fakePolicyManager.policyPriceSnapshot.mockResolvedValue(36_000_000_000_000_000n);
  fakePolicyManager.queryFilter.mockResolvedValue([]);
  fakeShield.getPolicyInfo.mockResolvedValue(ACTIVE_SHIELD_INFO);
});

describe("GET /policies/:productId/:policyId — V5.1 full surface", () => {
  test("test_PolicyDetailReturnsAllV5_1Fields", async () => {
    const res = await request(app).get(`/policies/${BTC_24H_PRODUCT_ID}/1`);
    expect(res.status).toBe(200);
    // Required V5.1 fields per spec checklist:
    expect(res.body).toEqual(
      expect.objectContaining({
        policyId: "1",
        productId: BTC_24H_PRODUCT_ID,
        productName: "Flash BTC 24h",
        holder: HOLDER,
        buyer: HOLDER,                           // backwards-compat alias
        coverageAmount: "1000000000",
        premiumPaid: "1000000",
        purchasedAt: "1700000000",
        waitingEndsAt: "1700001800",
        expiresAt: "1700003600",
        status: "Active",                        // not yet triggered/expired, past waiting
        priceSnapshot: "36000000000000000",      // [H-6]
        productActive: true,                     // [H-5]
        triggered: false,
        expired: false,
        triggeredAt: null,
        bondId: null,
      })
    );
  });

  test("test_PolicyNotFoundReturns404", async () => {
    fakePolicyManager.policies.mockResolvedValueOnce([
      "0x" + "0".repeat(64),
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      0n, 0n, 0n, 0n, 0n, false, false,
    ]);
    const res = await request(app).get(`/policies/${BTC_24H_PRODUCT_ID}/9999`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("policy_not_found");
    expect(res.body.message).toMatch(/Policy not found/);
  });

  test("test_TriggeredPolicyReturnsBondId", async () => {
    // Policy was triggered: bondId = epochId from BondIssued in same tx.
    fakePolicyManager.policies.mockResolvedValueOnce([
      ...ACTIVE_POLICY_RECORD.slice(0, 8),
      true,   // triggered
      false,  // expired
    ]);
    fakePolicyManager.queryFilter.mockResolvedValueOnce([
      { blockNumber: 12345, transactionHash: TRIGGER_TX_HASH },
    ]);
    fakeProvider.getBlock.mockResolvedValueOnce({ timestamp: 1_700_002_000 });
    fakeProvider.getTransactionReceipt.mockResolvedValueOnce({
      logs: [
        {
          address: BOND_VAULT_ADDR,
          // BondIssued(address indexed to, uint256 indexed epochId, uint256 usdAmount)
          topics: [
            ethers.id("BondIssued(address,uint256,uint256)"),
            ethers.zeroPadValue(HOLDER, 32),
            ethers.zeroPadValue(ethers.toBeHex(202812n), 32),
          ],
          data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [800n]),
        },
      ],
    });

    const res = await request(app).get(`/policies/${BTC_24H_PRODUCT_ID}/1`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("Triggered");
    expect(res.body.triggered).toBe(true);
    expect(res.body.triggeredAt).toBe("1700002000");
    expect(res.body.bondId).toBe("202812");
  });

  test("test_DeactivatedProductPolicyShowsFlag", async () => {
    // Policy still readable; product just deactivated.
    fakePolicyManager.productActive.mockResolvedValueOnce(false);
    const res = await request(app).get(`/policies/${BTC_24H_PRODUCT_ID}/1`);
    expect(res.status).toBe(200);
    expect(res.body.productActive).toBe(false);
    expect(res.body.policyId).toBe("1");
    expect(res.body.holder).toBe(HOLDER);
  });

  test("test_PriceSnapshotIncluded", async () => {
    fakePolicyManager.policyPriceSnapshot.mockResolvedValueOnce(42_000_000_000_000_000n);
    const res = await request(app).get(`/policies/${BTC_24H_PRODUCT_ID}/1`);
    expect(res.status).toBe(200);
    expect(res.body.priceSnapshot).toBe("42000000000000000");
    expect(fakePolicyManager.policyPriceSnapshot).toHaveBeenCalledWith(BTC_24H_PRODUCT_ID, 1n);
  });
});
