// Integration tests for POST /api/v1/redeem (Option C verifier pattern).
//
// The provider and bondVault contract are mocked via jest.mock("../../src/utils/ethers"),
// so no real RPC is hit. The BondVault ABI is loaded from disk to drive realistic
// log encoding (`Interface.parseLog` round-trip).

const BOND_VAULT_ADDRESS = "0x1747CDA7F84BEc4f2002ff0dcdb3c51c1C02cf6A";

jest.mock("../../src/utils/ethers", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ethers: realEthers } = require("ethers");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const artifact = require("../../abis/BondVault.json");
  const iface = new realEthers.Interface(artifact.abi);

  const fakeProvider = {
    getTransactionReceipt: jest.fn(),
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
  };
  const fakeBondVault = { target: BOND_VAULT_ADDRESS, interface: iface };

  return {
    provider: fakeProvider,
    relayer: { address: "0x0000000000000000000000000000000000000001" },
    coverRouter: {},
    coverRouterRelayer: {},
    policyManager: {},
    claimBond: {},
    bondVault: fakeBondVault,
    luminaToken: {},
    usdc: {},
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
const bondVaultArtifact = require("../../abis/BondVault.json");

const app = createApp();
const iface = new ethers.Interface(bondVaultArtifact.abi);

const OWNER = "0x2222222222222222222222222222222222222222";
const ANOTHER = "0x3333333333333333333333333333333333333333";

interface RedeemedLogParams {
  holder: string;
  epochId: string;
  usdAmount: string;
  luminaAmount: string;
  priceUsed: string;
}

function buildBondRedeemedLog(p: RedeemedLogParams): { address: string; topics: string[]; data: string } {
  const fragment = iface.getEvent("BondRedeemed");
  if (!fragment) throw new Error("BondRedeemed event missing from ABI fixture");
  const topics = [
    fragment.topicHash,
    ethers.zeroPadValue(p.holder, 32),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(p.epochId)), 32),
  ];
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "uint256"],
    [BigInt(p.usdAmount), BigInt(p.luminaAmount), BigInt(p.priceUsed)]
  );
  return { address: BOND_VAULT_ADDRESS, topics, data };
}

let apiKey: string;

beforeAll(() => {
  const issued = issueKey("0x000000000000000000000000000000000000FACE", "redeem-test");
  apiKey = issued.plaintext;
});

beforeEach(() => {
  ethersMock.provider.getTransactionReceipt.mockReset();
  // Reset shared in-memory DB rows so each test starts clean.
  getDb().prepare("DELETE FROM redemptions").run();
});

describe("POST /api/v1/redeem (verifier)", () => {
  test("test_HappyPath_ValidRedeemRecorded", async () => {
    const txHash = "0x" + "a".repeat(64);
    const log = buildBondRedeemedLog({
      holder: OWNER,
      epochId: "202804",
      usdAmount: "100000000000000000000",
      luminaAmount: "2777777777777777777777",
      priceUsed: "36000000000000000",
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: OWNER,
      to: BOND_VAULT_ADDRESS,
      blockNumber: 999,
      logs: [log],
    });

    const res = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "100000000000000000000",
        txHash,
        ownerAddress: OWNER,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.luminaReceived).toBe("2777777777777777777777");
    expect(res.body.epochId).toBe("202804");
    expect(res.body.blockNumber).toBe(999);

    const row = getDb()
      .prepare("SELECT * FROM redemptions WHERE tx_hash = ?")
      .get(txHash.toLowerCase()) as { owner_address: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.owner_address).toBe(OWNER.toLowerCase());
  });

  test("test_BondIdAliasAccepted", async () => {
    const txHash = "0x" + "b".repeat(64);
    const log = buildBondRedeemedLog({
      holder: OWNER,
      epochId: "202812",
      usdAmount: "50000000000000000000",
      luminaAmount: "1388888888888888888888",
      priceUsed: "36000000000000000",
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: OWNER,
      to: BOND_VAULT_ADDRESS,
      blockNumber: 1000,
      logs: [log],
    });

    const res = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        bondId: "202812", // alias for epochId
        usdAmount: "50000000000000000000",
        txHash,
        ownerAddress: OWNER,
      });

    expect(res.status).toBe(200);
    expect(res.body.epochId).toBe("202812");
  });

  test("test_TxNotFound", async () => {
    const txHash = "0x" + "c".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "1000",
        txHash,
        ownerAddress: OWNER,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_not_found");
    expect(res.body.message).toMatch(/Tx not found/);
  });

  test("test_TxReverted", async () => {
    const txHash = "0x" + "d".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 0,
      from: OWNER,
      to: BOND_VAULT_ADDRESS,
      blockNumber: 1001,
      logs: [],
    });

    const res = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "1000",
        txHash,
        ownerAddress: OWNER,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_reverted");
    expect(res.body.message).toMatch(/reverted/);
  });

  test("test_TxNotBondVault", async () => {
    const txHash = "0x" + "e".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: OWNER,
      to: "0x9999999999999999999999999999999999999999",
      blockNumber: 1002,
      logs: [],
    });

    const res = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "1000",
        txHash,
        ownerAddress: OWNER,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tx_not_bond_vault");
    expect(res.body.message).toMatch(/not a BondVault call/);
  });

  test("test_OwnerMismatch", async () => {
    const txHash = "0x" + "f".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: ANOTHER,
      to: BOND_VAULT_ADDRESS,
      blockNumber: 1003,
      logs: [],
    });

    const res = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "1000",
        txHash,
        ownerAddress: OWNER,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_mismatch");
    expect(res.body.message).toMatch(/Owner mismatch/);
  });

  test("test_DuplicateRegistration", async () => {
    const txHash = "0x" + "1".repeat(64);
    const log = buildBondRedeemedLog({
      holder: OWNER,
      epochId: "202804",
      usdAmount: "100000000000000000000",
      luminaAmount: "2777777777777777777777",
      priceUsed: "36000000000000000",
    });
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: OWNER,
      to: BOND_VAULT_ADDRESS,
      blockNumber: 1004,
      logs: [log],
    });

    const first = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "100000000000000000000",
        txHash,
        ownerAddress: OWNER,
      });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "100000000000000000000",
        txHash,
        ownerAddress: OWNER,
      });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("duplicate_redemption");
    expect(second.body.message).toMatch(/already registered/i);
  });

  test("test_BondRedeemedEventMissing", async () => {
    const txHash = "0x" + "2".repeat(64);
    ethersMock.provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      from: OWNER,
      to: BOND_VAULT_ADDRESS,
      blockNumber: 1005,
      logs: [
        {
          address: BOND_VAULT_ADDRESS,
          topics: [
            ethers.id("SomeOtherEvent(address,uint256)"),
            ethers.zeroPadValue(OWNER, 32),
            ethers.zeroPadValue(ethers.toBeHex(42n), 32),
          ],
          data: "0x",
        },
      ],
    });

    const res = await request(app)
      .post("/api/v1/redeem")
      .set("x-api-key", apiKey)
      .send({
        epochId: "202804",
        usdAmount: "1000",
        txHash,
        ownerAddress: OWNER,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("event_missing");
    expect(res.body.message).toMatch(/BondRedeemed event not found/);
  });
});
