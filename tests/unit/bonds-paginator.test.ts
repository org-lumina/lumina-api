// Unit test for the parallelized paginatedQueryFilter: it must still collect
// logs from EVERY window, and a persistently-failing window must be skipped
// (partial result), not abort the whole scan.

jest.mock("../../src/utils/ethers", () => ({
  provider: { getBlockNumber: jest.fn().mockResolvedValue(0) },
  claimBond: {},
  bondVault: {},
}));

import { paginatedQueryFilter } from "../../src/services/bonds";

const WINDOW = 45_000;

function fakeContract(opts: { failFrom?: number } = {}) {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    contract: {
      queryFilter: async (_filter: unknown, from: number, to: number) => {
        calls.push([from, to]);
        if (opts.failFrom !== undefined && from === opts.failFrom) {
          throw new Error("simulated RPC failure");
        }
        // one synthetic log per window, tagged by its start block
        return [{ blockNumber: from }];
      },
    },
  };
}

describe("paginatedQueryFilter (parallel)", () => {
  it("collects logs from every window", async () => {
    const { contract, calls } = fakeContract();
    const to = WINDOW * 10 - 1; // exactly 10 windows
    const logs = await paginatedQueryFilter(contract as any, {} as any, 0, to, "test");
    expect(calls.length).toBe(10);
    expect(logs.length).toBe(10);
  });

  it("skips a persistently-failing window but keeps the rest", async () => {
    const { contract } = fakeContract({ failFrom: WINDOW * 3 }); // window #4 fails
    const to = WINDOW * 6 - 1; // 6 windows
    const logs = await paginatedQueryFilter(contract as any, {} as any, 0, to, "test");
    expect(logs.length).toBe(5); // 6 windows, 1 fails -> 5 logs
  }, 20000);
});
