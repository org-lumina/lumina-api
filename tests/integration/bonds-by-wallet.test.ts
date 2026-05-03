// Tests for GET /api/v1/bonds/:wallet
//
// Strategy: mock claimBond + bondVault + provider so the service can enumerate
// epochs (EpochCreated), batch balances, fetch epoch info, and compute LUMINA
// equivalents without touching a real RPC.

const WALLET = "0x000000000000000000000000000000000000FACE";
const OTHER = "0x000000000000000000000000000000000000B0BA";

// Bonds the helper mock will produce. Indexed by epochId.
type EpochFixture = {
  epochId: bigint;
  createdBlock: number;
  createdAtUnix: number;
  maturityUnix: number;
  matured: boolean;
  totalSupply: bigint;
  // Per-wallet balance map.
  balances: Record<string, bigint>;
};

const fixtures: EpochFixture[] = [];

const fakeClaimBond = {
  filters: {
    EpochCreated: jest.fn(() => ({ kind: "EpochCreated" })),
    TransferSingle: jest.fn(() => ({ kind: "TransferSingle" })),
  },
  queryFilter: jest.fn(async (filter: { kind: string }) => {
    if (filter.kind === "EpochCreated") {
      return fixtures.map((f) => ({
        blockNumber: f.createdBlock,
        args: { epochId: f.epochId, maturityDate: BigInt(f.maturityUnix) },
      }));
    }
    return []; // TransferSingle scan not exercised in default tests
  }),
  balanceOf: jest.fn(async (account: string, id: bigint) => {
    const f = fixtures.find((x) => x.epochId === id);
    if (!f) return 0n;
    return f.balances[account.toLowerCase()] ?? 0n;
  }),
  getEpochInfo: jest.fn(async (id: bigint) => {
    const f = fixtures.find((x) => x.epochId === id);
    if (!f) return [false, 0n, 0n, false];
    return [true, BigInt(f.maturityUnix), f.totalSupply, f.matured];
  }),
};

const fakeBondVault = {
  // 1 USD-wei -> 1/0.036 LUMINA, but we just return faceValue * 27 (mock-friendly)
  previewRedemption: jest.fn(async (faceValue: bigint) => (faceValue * 27n) / 10n),
};

const fakeProvider = {
  getBlock: jest.fn(async (bn: number) => {
    const f = fixtures.find((x) => x.createdBlock === bn);
    return f ? { timestamp: f.createdAtUnix } : null;
  }),
  getBlockNumber: jest.fn().mockResolvedValue(99999),
  getBalance: jest.fn().mockResolvedValue(0n),
  getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
};

jest.mock("../../src/utils/ethers", () => ({
  provider: fakeProvider,
  relayer: { address: "0x0000000000000000000000000000000000000001" },
  coverRouter: {},
  coverRouterRelayer: {},
  policyManager: {},
  claimBond: fakeClaimBond,
  bondVault: fakeBondVault,
  luminaToken: {},
  usdc: {},
}));

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";
import { _resetBondsCache } from "../../src/services/bonds";

const app = createApp();
let apiKey: string;

beforeAll(() => {
  const issued = issueKey("0x000000000000000000000000000000000000ACE0", "bonds-test");
  apiKey = issued.plaintext;
});

beforeEach(() => {
  fixtures.length = 0;
  _resetBondsCache();
  fakeClaimBond.queryFilter.mockClear();
  fakeClaimBond.balanceOf.mockClear();
  fakeClaimBond.getEpochInfo.mockClear();
  fakeBondVault.previewRedemption.mockClear();
});

const TWO_YEARS_SECS = 730 * 24 * 60 * 60;

function pushBond(opts: {
  epochId: bigint;
  createdAtUnix: number;
  matured?: boolean;
  balanceFor?: { wallet: string; amount: bigint };
  totalSupply?: bigint;
}): void {
  const balances: Record<string, bigint> = {};
  if (opts.balanceFor) balances[opts.balanceFor.wallet.toLowerCase()] = opts.balanceFor.amount;
  fixtures.push({
    epochId: opts.epochId,
    createdBlock: 1000 + Number(opts.epochId),
    createdAtUnix: opts.createdAtUnix,
    maturityUnix: opts.createdAtUnix + TWO_YEARS_SECS,
    matured: opts.matured ?? false,
    totalSupply: opts.totalSupply ?? 1000n,
    balances,
  });
}

describe("GET /api/v1/bonds/:wallet", () => {
  test("test_HappyPath_WalletWithBonds", async () => {
    pushBond({ epochId: 202804n, createdAtUnix: 1_777_000_000, balanceFor: { wallet: WALLET, amount: 800n } });
    pushBond({ epochId: 202805n, createdAtUnix: 1_780_000_000, balanceFor: { wallet: WALLET, amount: 200n } });

    const res = await request(app).get(`/api/v1/bonds/${WALLET}`).set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(WALLET.toLowerCase());
    expect(res.body.totalBonds).toBe(2);
    expect(res.body.bonds).toHaveLength(2);

    const bond = res.body.bonds[0]; // newest epoch first
    expect(bond.bondId).toBe("202805");
    expect(bond.epochId).toBe("202805");
    expect(bond.balance).toBe("200");
    expect(bond.faceValue).toBe((200n * 10n ** 18n).toString());
    expect(bond.isMatured).toBe(false);
    expect(bond.isRedeemed).toBe(false);
    // mock: previewRedemption(faceValue) = faceValue * 27/10
    expect(bond.luminaEquivalent).toBe(((200n * 10n ** 18n * 27n) / 10n).toString());
    expect(bond.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bond.maturityDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("test_EmptyWallet", async () => {
    pushBond({ epochId: 202804n, createdAtUnix: 1_777_000_000, balanceFor: { wallet: OTHER, amount: 100n } });
    const res = await request(app).get(`/api/v1/bonds/${WALLET}`).set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.totalBonds).toBe(0);
    expect(res.body.bonds).toEqual([]);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  test("test_StatusFilter_Matured", async () => {
    pushBond({ epochId: 202700n, createdAtUnix: 1_700_000_000, matured: true,  balanceFor: { wallet: WALLET, amount: 500n } });
    pushBond({ epochId: 202804n, createdAtUnix: 1_777_000_000, matured: false, balanceFor: { wallet: WALLET, amount: 800n } });

    const res = await request(app).get(`/api/v1/bonds/${WALLET}?status=matured`).set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.totalBonds).toBe(1);
    expect(res.body.bonds[0].epochId).toBe("202700");
    expect(res.body.bonds[0].isMatured).toBe(true);
  });

  test("test_StatusFilter_Active", async () => {
    pushBond({ epochId: 202700n, createdAtUnix: 1_700_000_000, matured: true,  balanceFor: { wallet: WALLET, amount: 500n } });
    pushBond({ epochId: 202804n, createdAtUnix: 1_777_000_000, matured: false, balanceFor: { wallet: WALLET, amount: 800n } });

    const res = await request(app).get(`/api/v1/bonds/${WALLET}?status=active`).set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.totalBonds).toBe(1);
    expect(res.body.bonds[0].epochId).toBe("202804");
    expect(res.body.bonds[0].isMatured).toBe(false);
  });

  test("test_Pagination", async () => {
    for (let i = 0; i < 5; i++) {
      pushBond({
        epochId: BigInt(202800 + i),
        createdAtUnix: 1_770_000_000 + i * 86_400,
        balanceFor: { wallet: WALLET, amount: BigInt(100 + i) },
      });
    }

    const r1 = await request(app)
      .get(`/api/v1/bonds/${WALLET}?limit=2&offset=0`)
      .set("x-api-key", apiKey);
    expect(r1.status).toBe(200);
    expect(r1.body.totalBonds).toBe(5);
    expect(r1.body.bonds).toHaveLength(2);
    expect(r1.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });

    const r2 = await request(app)
      .get(`/api/v1/bonds/${WALLET}?limit=2&offset=4`)
      .set("x-api-key", apiKey);
    expect(r2.status).toBe(200);
    expect(r2.body.bonds).toHaveLength(1);
    expect(r2.body.pagination).toEqual({ limit: 2, offset: 4, hasMore: false });
  });

  test("test_InvalidAddress", async () => {
    const res = await request(app).get(`/api/v1/bonds/not-an-address`).set("x-api-key", apiKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_address");
  });

  test("test_RedeemedBondsExcluded (when status='active')", async () => {
    pushBond({ epochId: 202700n, createdAtUnix: 1_700_000_000, balanceFor: { wallet: WALLET, amount: 0n } }); // redeemed
    pushBond({ epochId: 202804n, createdAtUnix: 1_777_000_000, balanceFor: { wallet: WALLET, amount: 800n } }); // active

    const res = await request(app).get(`/api/v1/bonds/${WALLET}?status=active`).set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.totalBonds).toBe(1);
    expect(res.body.bonds[0].epochId).toBe("202804");
    expect(res.body.bonds[0].isRedeemed).toBe(false);
  });

  test("test_MaturityCalculation (createdAt + 730 days)", async () => {
    const t0 = 1_770_000_000;
    pushBond({ epochId: 202804n, createdAtUnix: t0, balanceFor: { wallet: WALLET, amount: 100n } });

    const res = await request(app).get(`/api/v1/bonds/${WALLET}`).set("x-api-key", apiKey);
    expect(res.status).toBe(200);
    const b = res.body.bonds[0];
    const created = Math.floor(new Date(b.createdAt).getTime() / 1000);
    const maturity = Math.floor(new Date(b.maturityDate).getTime() / 1000);
    expect(maturity - created).toBe(730 * 24 * 60 * 60);
  });

  test("requires API key", async () => {
    const res = await request(app).get(`/api/v1/bonds/${WALLET}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });
});
