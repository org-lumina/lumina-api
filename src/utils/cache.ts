// ────────────────────────────────────────────────────────────────────────────
// makeCache — generic in-memory TTL cache (extracted from services/bonds.ts)
// ────────────────────────────────────────────────────────────────────────────
//
// Several services need a small, per-process LRU-less cache with a fixed TTL
// (bonds enumeration, marketplace stats, marketplace history). Rather than
// re-implementing the same Map<string, {data, expiresAt}> in each module, we
// centralise the pattern here so there's a single test seam (`reset()`) and
// a single place to evolve eviction policy if we ever outgrow the simple
// "expire-on-read" approach.
//
// Intentionally NOT exported as a singleton: each consumer creates its own
// `makeCache<T>(ttlMs)` instance so the data type and TTL stay co-located
// with the caller, and so resetting one cache (e.g. between tests) doesn't
// blow away unrelated caches.

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface Cache<T> {
  /** Returns the cached value if present AND not expired; otherwise undefined.
   *  Side-effect: expired entries are pruned on read so the Map doesn't grow
   *  unboundedly when callers stop revisiting the same keys. */
  get(key: string): T | undefined;
  /** Insert (or overwrite) a value with a fresh expiry stamp. */
  set(key: string, data: T): void;
  /** Test seam: drop everything. Used by `_resetXCache` exports per service. */
  reset(): void;
}

export function makeCache<T>(ttlMs: number): Cache<T> {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const hit = map.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.data;
      if (hit) map.delete(key);
      return undefined;
    },
    set(key: string, data: T): void {
      map.set(key, { data, expiresAt: Date.now() + ttlMs });
    },
    reset(): void {
      map.clear();
    },
  };
}
