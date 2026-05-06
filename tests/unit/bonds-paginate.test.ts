// Unit tests for the getLogs paginator helpers in src/services/bonds.ts.
//
// We mock `../../src/utils/ethers` so the module's `provider`/`claimBond`
// imports resolve without touching a real RPC. Tests then exercise the
// pure window math + retry/skip semantics of `paginatedQueryFilter` and
// the env-var/fallback resolution in `getStartBlock`.

const fakeProvider = {
  getBlockNumber: jest.fn().mockResolvedValue(1_000_000),
};

jest.mock("../../src/utils/ethers", () => ({
  provider: fakeProvider,
  relayer: { address: "0x0000000000000000000000000000000000000001" },
  coverRouter: {},
  coverRouterRelayer: {},
  policyManager: {},
  claimBond: { filters: { EpochCreated: () => ({}), TransferSingle: () => ({}) }, queryFilter: jest.fn() },
  bondVault: {},
  luminaToken: {},
  usdc: {},
}));

import { paginatedQueryFilter, getStartBlock } from "../../src/services/bonds";

describe("getStartBlock", () => {
  const ORIG = process.env.DEPLOYMENT_BLOCK_CLAIMBOND;
  afterEach(() => {
    process.env.DEPLOYMENT_BLOCK_CLAIMBOND = ORIG;
    fakeProvider.getBlockNumber.mockResolvedValue(1_000_000);
  });

  test("honours DEPLOYMENT_BLOCK_CLAIMBOND when set", async () => {
    process.env.DEPLOYMENT_BLOCK_CLAIMBOND = "40700000";
    const start = await getStartBlock();
    expect(start).toBe(40700000);
  });

  test("falls back to latest - 500_000 when env var is unset", async () => {
    delete process.env.DEPLOYMENT_BLOCK_CLAIMBOND;
    fakeProvider.getBlockNumber.mockResolvedValue(800_000);
    const start = await getStartBlock();
    expect(start).toBe(300_000);
  });

  test("clamps to 0 when latest - 500_000 would be negative", async () => {
    delete process.env.DEPLOYMENT_BLOCK_CLAIMBOND;
    fakeProvider.getBlockNumber.mockResolvedValue(1_000);
    const start = await getStartBlock();
    expect(start).toBe(0);
  });

  test("ignores a non-numeric env var and falls back", async () => {
    process.env.DEPLOYMENT_BLOCK_CLAIMBOND = "not-a-number";
    fakeProvider.getBlockNumber.mockResolvedValue(800_000);
    const start = await getStartBlock();
    expect(start).toBe(300_000);
  });
});

describe("paginatedQueryFilter", () => {
  test("splits a 100k-block range into windows of 45000", async () => {
    const calls: Array<[number, number]> = [];
    const contract = {
      queryFilter: jest.fn(async (_filter: unknown, from: number, to: number) => {
        calls.push([from, to]);
        return [{ blockNumber: from } as unknown];
      }),
    };
    const out = await paginatedQueryFilter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contract as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      0,
      100_000,
      "test"
    );
    // 100_001 blocks / 45_000 = ceil(2.22) = 3 windows
    expect(calls).toEqual([
      [0, 44_999],
      [45_000, 89_999],
      [90_000, 100_000],
    ]);
    expect(out.length).toBe(3);
  });

  test("returns empty array when toBlock < fromBlock", async () => {
    const contract = { queryFilter: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await paginatedQueryFilter(contract as any, {} as any, 100, 50, "test");
    expect(out).toEqual([]);
    expect(contract.queryFilter).not.toHaveBeenCalled();
  });

  test("retries up to 3 times on a window then skips and continues", async () => {
    let calls = 0;
    const contract = {
      queryFilter: jest.fn(async (_f: unknown, from: number, _to: number) => {
        calls += 1;
        // Window starting at 0 always fails; second window succeeds.
        if (from === 0) throw new Error("simulated rpc fail");
        return [{ blockNumber: from } as unknown];
      }),
    };
    const out = await paginatedQueryFilter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contract as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      0,
      45_000,
      "test"
    );
    // first window: 3 attempts, all fail. second window: 1 attempt, success.
    expect(calls).toBe(3 + 1);
    expect(out.length).toBe(1);
  }, 20_000);
});
