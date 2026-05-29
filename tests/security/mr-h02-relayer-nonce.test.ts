// [MR-H02] (HIGH) Relayer purchase path nonce serialisation.
//
// The relayer wallet signs from a single pending-nonce sequence shared by the
// faucet path and the policy-purchase path (`purchaseViaRelayer`). Before this
// fix only the faucet wrapped its sends in `withLock`; concurrent purchases
// (or a purchase racing a faucet claim) read the SAME pending nonce → one tx
// dropped/replaced → DoS.
//
// This test asserts that two concurrent `purchaseViaRelayer` calls SERIALISE:
// the second call's send does not begin until the first call's send+confirm
// window has completed, so they never observe the same pending nonce.
//
// Mirrors the mocking style of tests/security/idempotency.test.ts.

// Shared nonce model: `pendingNonce` is the next nonce the relayer would use.
// A send reads the current `pendingNonce`; the nonce only advances AFTER the
// tx "confirms" (wait resolves) — exactly the window the lock must protect.
let pendingNonce = 0;
const noncesObservedAtSend: number[] = [];
let concurrentSendsDetected = 0;
let inFlight = 0;

// Resolver to hold the FIRST send's confirmation open until we've launched the
// second call — this is what would let an un-serialised send reuse the nonce.
let releaseFirstConfirm: (() => void) | null = null;

jest.mock("../../src/utils/ethers", () => {
  const fakeProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    getBalance: jest.fn().mockResolvedValue(0n),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
  };
  const fakeRelayer = { address: "0x0000000000000000000000000000000000000001" };
  const fakeRouter = {
    target: "0x000000000000000000000000000000000000ABCD",
    authorizedRelayers: jest.fn().mockResolvedValue(true),
    paused: jest.fn().mockResolvedValue(false),
    globalPauseRegistry: jest
      .fn()
      .mockResolvedValue("0x0000000000000000000000000000000000000000"),
    products: jest.fn().mockResolvedValue({
      durationSeconds: 3600n,
      0: "0x" + "0".repeat(64), 1: 8000n, 2: 1000n, 3: 12000n, 4: 3600n, 5: true,
    }),
    quotePremium: jest.fn().mockResolvedValue({
      premium: 1_000_000n, payout: 800_000_000n, 0: 1_000_000n, 1: 800_000_000n,
    }),
    purchasePolicyFor: jest.fn(async () => {
      // ── enter the nonce-consuming critical section ──
      inFlight += 1;
      if (inFlight > 1) concurrentSendsDetected += 1;

      // Read the pending nonce at send time (what an un-locked send races on).
      const myNonce = pendingNonce;
      noncesObservedAtSend.push(myNonce);

      const hash = "0x" + myNonce.toString(16).padStart(64, "0");
      return {
        hash,
        wait: async () => {
          // First tx holds its confirmation open until the test releases it,
          // simulating real RPC latency during which a racing send could fire.
          if (myNonce === 0 && releaseFirstConfirm === null) {
            await new Promise<void>((resolve) => {
              releaseFirstConfirm = resolve;
            });
          }
          // Nonce advances only AFTER confirmation — the protected window.
          pendingNonce += 1;
          inFlight -= 1;
          return { status: 1, blockNumber: 12345 + myNonce, logs: [] };
        },
      };
    }),
  };
  const fakePolicyManager = { productActive: jest.fn().mockResolvedValue(true) };
  const fakeUsdc = {
    balanceOf: jest.fn().mockResolvedValue(10_000_000_000n),
    allowance: jest
      .fn()
      .mockResolvedValue(
        115792089237316195423570985008687907853269984665640564039457584007913129639935n
      ),
  };
  return {
    provider: fakeProvider,
    relayer: fakeRelayer,
    relayerNonceManaged: fakeRelayer,
    coverRouter: fakeRouter,
    coverRouterRelayer: fakeRouter,
    policyManager: fakePolicyManager,
    claimBond: {},
    bondVault: {},
    luminaToken: {},
    usdc: fakeUsdc,
    getGlobalPauseRegistry: jest.fn().mockResolvedValue(undefined),
  };
});

import { purchaseViaRelayer, PurchaseInput } from "../../src/services/policies";
import { withLock, RELAYER_TX_LOCK_KEY } from "../../src/utils/lock";

const VALID_BYTES32 = "0x" + "0".repeat(64);
const VALID_BUYER = "0x000000000000000000000000000000000000abcd";

function makeInput(): PurchaseInput {
  return {
    productId: VALID_BYTES32,
    coverageAmount: 1_000_000_000n,
    asset: VALID_BYTES32,
    buyer: VALID_BUYER,
  };
}

describe("[MR-H02] relayer purchase path serialises on the shared relayer lock", () => {
  beforeEach(() => {
    pendingNonce = 0;
    noncesObservedAtSend.length = 0;
    concurrentSendsDetected = 0;
    inFlight = 0;
    releaseFirstConfirm = null;
  });

  test("two concurrent purchases do NOT read the same pending nonce", async () => {
    // Fire two purchases concurrently. The first will block in `wait()` until
    // we release it; if the purchase path did NOT hold the lock across the
    // send+confirm window, the second purchase would enter `purchasePolicyFor`
    // and read nonce 0 too (collision). With the lock, the second send cannot
    // start until the first fully confirms (and advances the nonce to 1).
    const p1 = purchaseViaRelayer(makeInput());

    // Give p1 time to pass its read-only pre-flights and reach the send,
    // then block inside wait(). Poll until the first send is observed.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (noncesObservedAtSend.length >= 1 && releaseFirstConfirm) resolve();
        else setImmediate(check);
      };
      check();
    });

    const p2 = purchaseViaRelayer(makeInput());

    // Let the event loop run a few ticks so that, IF unserialised, p2's send
    // would already have fired and recorded a duplicate nonce 0.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // At this point only the FIRST send must have happened — p2 is parked
    // waiting on the lock.
    expect(noncesObservedAtSend).toEqual([0]);

    // Release the first confirmation; the nonce advances to 1, the lock frees,
    // and p2 proceeds — reading nonce 1, not 0.
    releaseFirstConfirm!();

    await Promise.all([p1, p2]);

    // Both sends happened, with DISTINCT nonces (0 then 1) — no collision.
    expect(noncesObservedAtSend).toEqual([0, 1]);
    // The sends were never simultaneously in the critical section.
    expect(concurrentSendsDetected).toBe(0);
  });

  test("faucet and purchase share ONE lock key (same relayer nonce space)", async () => {
    // Sanity: the purchase path uses the SAME exported key the faucet uses, so
    // a faucet claim and a purchase serialise against each other. We prove the
    // key is shared by acquiring it externally and showing a purchase blocks.
    let purchaseStarted = false;
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });

    // Hold the shared relayer lock (as the faucet would during its mint+eth).
    const holder = withLock(RELAYER_TX_LOCK_KEY, async () => {
      await held;
    });

    const purchase = purchaseViaRelayer(makeInput()).then(() => {
      purchaseStarted = true;
    });

    // While the lock is held by the faucet-equivalent, the purchase send must
    // NOT have fired yet.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(noncesObservedAtSend.length).toBe(0);
    expect(purchaseStarted).toBe(false);

    // Release the held lock; the purchase now proceeds. (No first-confirm
    // block here because pendingNonce starts at 0 and we release immediately.)
    releaseHeld();
    if (releaseFirstConfirm) (releaseFirstConfirm as () => void)();
    // wait() for nonce 0 may park on releaseFirstConfirm; release it once set.
    await new Promise((r) => setImmediate(r));
    if (releaseFirstConfirm) (releaseFirstConfirm as () => void)();

    await holder;
    await purchase;

    expect(noncesObservedAtSend).toEqual([0]);
  });
});
