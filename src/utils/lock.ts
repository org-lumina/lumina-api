/**
 * Tiny in-process async mutex keyed by string.
 *
 * Originally introduced inline in `routes/faucet.ts` to close audit HIGH-1
 * (concurrent faucet claims draining the relayer). Extracted here so the
 * relayer purchase path (`services/policies.ts`) can serialise against the
 * SAME key — see `RELAYER_TX_LOCK_KEY` below.
 *
 * Scope: single-instance. The lock lives in process memory; a multi-instance
 * deploy must replace it with an external locker (Redis SETNX) or a
 * DB-level serialisation. Documented in tracking/sprint-l-faucet.md and the
 * MR-H02 note in tracking/sprint-7.3-manual-review.md.
 */

const inflightLocks = new Map<string, Promise<void>>();

/**
 * Serialise all `fn` invocations sharing the same `key`. Each holder runs to
 * completion (resolve OR reject) before the next acquires the lock.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (inflightLocks.has(key)) {
    // Wait the prior caller's promise out, then re-loop in case yet another
    // request grabbed the lock in the meantime.
    try {
      await inflightLocks.get(key);
    } catch {
      // Prior holder may have rejected — that's their problem; we still
      // want our turn at the lock.
    }
  }
  let release!: () => void;
  const p = new Promise<void>((resolve) => {
    release = resolve;
  });
  inflightLocks.set(key, p);
  try {
    return await fn();
  } finally {
    inflightLocks.delete(key);
    release();
  }
}

/**
 * [Audit HIGH-1 / MR-H02] Shared lock key for EVERY operation that signs &
 * broadcasts a tx from the single relayer wallet (`utils/ethers.ts` →
 * `relayer`). The faucet (mint + ETH send) and the policy-purchase path
 * (`purchasePolicyFor`) both draw from the SAME pending-nonce sequence, so
 * they MUST serialise on ONE key — otherwise two concurrent sends read the
 * same pending nonce and one tx is dropped/replaced (DoS).
 */
export const RELAYER_TX_LOCK_KEY = "relayer-tx-global";
