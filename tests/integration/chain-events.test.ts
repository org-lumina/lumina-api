// chainEvents emitter: turns indexer rows into webhook_events, exactly once,
// with a persisted per-stream cursor and no history replay on first run.
//
// We mock the indexer Postgres (`query`) so no real DB is needed, and assert
// against the real SQLite webhook_events queue + kv cursor.

const queryMock = jest.fn();
jest.mock("../../src/utils/indexerDb", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { listPendingWebhookEvents, kvGet, kvSet } from "../../src/db/database";
import { chainEventsTick } from "../../src/services/chainEvents";

// Route every SQL: a MAX(...) query returns the head; a SELECT … returns rows.
// `headByCall` / `rowsByEvent` are set per-test.
function setIndexer(opts: {
  heads: Record<string, number>; // keyed by a substring of the table/query
  rows?: Array<Record<string, string>>; // rows returned for the next non-head fetch
}) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("MAX(")) {
      // Pick the head whose key appears in the SQL; default 0.
      for (const [k, v] of Object.entries(opts.heads)) {
        if (sql.includes(k)) return [{ h: v }];
      }
      return [{ h: 0 }];
    }
    return opts.rows ?? [];
  });
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("chainEvents emitter", () => {
  it("first run sets cursors to head and emits NOTHING (no history flood)", async () => {
    setIndexer({ heads: { "FROM policy": 100, "FROM trigger": 100, "FROM bond": 100, marketplace_listing: 100 } });
    const before = listPendingWebhookEvents(1000).length;
    await chainEventsTick();
    const after = listPendingWebhookEvents(1000).length;
    expect(after).toBe(before); // nothing emitted
    expect(kvGet("chainevents:cursor:policy_purchased")).toBe("100");
    expect(kvGet("chainevents:cursor:bond_minted")).toBe("100");
  });

  it("emits a webhook_event for a new policy beyond the cursor, then advances", async () => {
    // First tick initialises cursor at 100 (above).
    setIndexer({ heads: { "FROM policy": 100, "FROM trigger": 100, "FROM bond": 100, marketplace_listing: 100 } });
    await chainEventsTick();

    const buyer = "0x" + "ab".repeat(20);
    // Second tick: policy head moves to 105, one new policy row at block 105.
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("MAX(") && sql.includes("FROM policy")) return [{ h: 105 }];
      if (sql.includes("MAX(")) return [{ h: 100 }]; // other streams unchanged
      if (sql.includes("FROM policy")) {
        return [
          {
            buyer,
            product_id: "0xprod",
            policy_id: "7",
            coverage: "100000000",
            premium: "288000",
            payout: "80000000",
            tx_hash: "0xtx",
            block_number: "105",
          },
        ];
      }
      return [];
    });

    await chainEventsTick();

    const pending = listPendingWebhookEvents(1000);
    const mine = pending.filter((e) => e.wallet === buyer.toLowerCase() && e.event === "policy_purchased");
    expect(mine.length).toBe(1);
    expect(kvGet("chainevents:cursor:policy_purchased")).toBe("105");

    // Third tick with no new head → no further emit (exactly once).
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes("MAX(") ? [{ h: sql.includes("FROM policy") ? 105 : 100 }] : []
    );
    await chainEventsTick();
    const after = listPendingWebhookEvents(1000).filter(
      (e) => e.wallet === buyer.toLowerCase() && e.event === "policy_purchased"
    );
    expect(after.length).toBe(1); // unchanged
  });

  it("a failing stream does not abort the others", async () => {
    // Force the policy stream to have work to do (cursor 0, head 50).
    kvSet("chainevents:cursor:policy_purchased", "0");
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM trigger")) throw new Error("indexer blip");
      if (sql.includes("MAX(")) return [{ h: 50 }];
      return []; // policy fetch returns no rows, but the cursor still advances
    });
    await expect(chainEventsTick()).resolves.toBeUndefined();
    // policy stream still advanced despite the trigger stream throwing.
    expect(kvGet("chainevents:cursor:policy_purchased")).toBe("50");
  });
});
