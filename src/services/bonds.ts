import type { BaseContract, DeferredTopicFilter, EventLog, Log } from "ethers";
import { bondVault, claimBond, provider } from "../utils/ethers";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";
import { makeCache } from "../utils/cache";

export type BondStatusFilter = "active" | "matured" | "redeemed" | "all";

// ────────────────────────────────────────────────────────────────────────
// getLogs paginator (founder-locked policy)
// ────────────────────────────────────────────────────────────────────────
// Public RPCs (Alchemy free tier, base-sepolia.org) cap eth_getLogs to a
// small block range. A wallet-scoped query against a contract deployed
// hundreds of thousands of blocks ago therefore needs to be split into
// fixed-size windows. Window size is 45 000 blocks per the founder spec.
// Retry policy per window: 3 attempts with exponential backoff (1s/2s/4s).
// After 3 failures on a single window we log a warning and CONTINUE with
// the next window — a partial result is still preferable to a 503.
const LOG_SCAN_WINDOW = 45_000;
const LOG_SCAN_FALLBACK_LOOKBACK = 500_000;
const LOG_SCAN_MAX_RETRIES = 3;
// [perf] Windows were scanned strictly sequentially, so a ~500k-block range
// (≈12 windows) × the retry/backoff cost dominated wallet-scoped queries. We now
// run windows with bounded concurrency: same total getLogs calls, but issued in
// parallel batches → ~Nx fewer serial round-trips. Bounded to avoid RPC throttling.
const LOG_SCAN_CONCURRENCY = 6;

/**
 * Resolve the lower bound for log scans. Honours an explicit
 * `DEPLOYMENT_BLOCK_CLAIMBOND` env var (the canonical source) and falls
 * back to `latest - 500_000` when unset, which covers ~10 days on Base
 * (2s blocks) — enough to find recent bond activity without forcing a
 * full chain scan on a misconfigured deploy.
 */
export async function getStartBlock(latestBlockOverride?: number): Promise<number> {
  const fromEnv = process.env.DEPLOYMENT_BLOCK_CLAIMBOND;
  if (fromEnv && fromEnv.trim().length > 0) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const latest = latestBlockOverride ?? (await provider.getBlockNumber());
  return Math.max(0, latest - LOG_SCAN_FALLBACK_LOOKBACK);
}

/**
 * Iterate `[fromBlock, toBlock]` in fixed-size windows, collecting all
 * logs that match `filter`. Each window is retried up to
 * `LOG_SCAN_MAX_RETRIES` times with exponential backoff. A persistently
 * failing window is logged and skipped — the scan as a whole keeps going.
 */
export async function paginatedQueryFilter(
  contract: BaseContract,
  filter: DeferredTopicFilter,
  fromBlock: number,
  toBlock: number,
  label: string
): Promise<Array<EventLog | Log>> {
  const out: Array<EventLog | Log> = [];
  if (toBlock < fromBlock) return out;

  // Build every [from,to] window up front.
  const windows: Array<[number, number]> = [];
  for (let f = fromBlock; f <= toBlock; f += LOG_SCAN_WINDOW) {
    windows.push([f, Math.min(f + LOG_SCAN_WINDOW - 1, toBlock)]);
  }

  // Fetch a single window with the existing retry/backoff policy. A persistently
  // failing window resolves to [] (partial result preferable to a 503).
  const fetchWindow = async ([from, to]: [number, number]): Promise<Array<EventLog | Log>> => {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < LOG_SCAN_MAX_RETRIES) {
      try {
        const t0 = Date.now();
        const logs = await contract.queryFilter(filter, from, to);
        console.log(`[bonds] ${label} window [${from}, ${to}] -> ${logs.length} logs (${Date.now() - t0}ms)`);
        return logs;
      } catch (err) {
        lastErr = err;
        attempt += 1;
        if (attempt >= LOG_SCAN_MAX_RETRIES) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1))); // 1s/2s/4s
      }
    }
    console.warn(
      `[bonds] ${label} window [${from}, ${to}] FAILED after ${LOG_SCAN_MAX_RETRIES} attempts, skipping. lastErr=${(lastErr as Error)?.message ?? String(lastErr)}`
    );
    return [];
  };

  // Run windows in bounded-concurrency batches.
  for (let i = 0; i < windows.length; i += LOG_SCAN_CONCURRENCY) {
    const batch = windows.slice(i, i + LOG_SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchWindow));
    for (const r of results) out.push(...r);
  }
  return out;
}

export interface BondInfo {
  bondId: string;          // alias of epochId — every ClaimBond ERC-1155 token-id is its epochId
  epochId: string;
  balance: string;          // integer USD ($1 = 1 token)
  faceValue: string;        // 18-dec USD-wei (= balance * 1e18)
  createdAt: string;        // ISO-8601
  maturityDate: string;     // ISO-8601
  isMatured: boolean;
  isRedeemed: boolean;
  luminaEquivalent: string; // 18-dec LUMINA wei (current price)
}

export interface ListBondsOptions {
  status: BondStatusFilter;
  limit: number;
  offset: number;
}

export interface BondsListResult {
  wallet: string;
  totalBonds: number;
  bonds: BondInfo[];
  pagination: { limit: number; offset: number; hasMore: boolean };
}

const CACHE_TTL_MS = 60 * 1000;
const cache = makeCache<BondInfo[]>(CACHE_TTL_MS);

function isoFromUnix(seconds: bigint | number): string {
  const sec = typeof seconds === "bigint" ? Number(seconds) : seconds;
  return new Date(sec * 1000).toISOString();
}

/**
 * Enumerate candidate epochs DETERMINISTICALLY (no event-log scan).
 *
 * A ClaimBond token-id IS its epoch = the bond's maturity month encoded as
 * YYYYMM (e.g. a bond minted May-2026 with a 730-day maturity lands at 2028-05
 * → 202805). We previously discovered these via the `EpochCreated` log, but the
 * shared getLogs paginator uses a 45 000-block window that public/free RPCs
 * REJECT (eth_getLogs range cap ≈ 2-3k blocks on base-sepolia) — every window
 * errored, was swallowed, and the wallet saw an empty portfolio.
 *
 * Epochs are months, so the universe is tiny and predictable: enumerate
 * [2026-01 .. now+27 months] (covers the max 730-day maturity plus buffer) and
 * let `buildBondInfo` drop epochs that don't exist or aren't held. `balanceOf`
 * and `getEpochInfo` are plain `eth_call`s with no range limit, so this path is
 * immune to the getLogs cap. `createdAt` is unknown without the mint log, so we
 * report the maturity month's first day (a valid date; not the issuance time).
 */
function enumerateEpochs(): bigint[] {
  const now = new Date();
  const startAbs = 2026 * 12 + 0; // Jan 2026 (protocol genesis), month index 0
  const endAbs = now.getUTCFullYear() * 12 + now.getUTCMonth() + 27; // +27mo > 730d maturity
  const out: bigint[] = [];
  for (let abs = startAbs; abs <= endAbs; abs++) {
    const y = Math.floor(abs / 12);
    const m = (abs % 12) + 1; // 1..12
    out.push(BigInt(y * 100 + m));
  }
  return out;
}

// Fallback when BondVault.bondMaturitySeconds() can't be read (730 days = the
// mainnet default). Used to back out a bond's issuance time from its maturity,
// since we no longer read the mint-event block timestamp.
const DEFAULT_BOND_MATURITY_SECONDS = 730 * 24 * 60 * 60;

async function buildBondInfo(
  wallet: string,
  epochId: bigint,
  maturitySeconds: number
): Promise<BondInfo | undefined> {
  // [perf] balanceOf + getEpochInfo are independent — fetch in parallel.
  const [balance, info] = (await Promise.all([
    claimBond.balanceOf(wallet, epochId),
    claimBond.getEpochInfo(epochId),
  ])) as [bigint, any];
  const exists = Boolean(info[0] ?? info.exists);
  if (!exists) return undefined;
  const maturity: bigint = info[1] ?? info.maturity;
  const matured: boolean = Boolean(info[3] ?? info.matured);
  // createdAt is no longer sourced from the mint log; derive issuance as
  // maturity − maturitySeconds (exact for fixed-maturity bonds).
  const matSec = BigInt(maturitySeconds);
  const createdAt = isoFromUnix(maturity > matSec ? maturity - matSec : 0n);

  const faceValueWei = balance * 10n ** 18n;
  let luminaEquivalent = "0";
  if (faceValueWei > 0n) {
    try {
      const preview: bigint = await bondVault.previewRedemption(faceValueWei);
      luminaEquivalent = preview.toString();
    } catch (e) {
      // Oracle / pause failures should not break the listing — leave at "0".
      logger.warn({ err: e, epochId: epochId.toString() }, "previewRedemption failed");
    }
  }

  return {
    bondId: epochId.toString(),
    epochId: epochId.toString(),
    balance: balance.toString(),
    faceValue: faceValueWei.toString(),
    createdAt,
    maturityDate: isoFromUnix(maturity),
    isMatured: matured,
    isRedeemed: balance === 0n,
    luminaEquivalent,
  };
}

async function loadAllBondsForWallet(wallet: string, _includeRedeemed: boolean): Promise<BondInfo[]> {
  // The deterministic month enumeration already spans every past epoch (where
  // redeemed/zero-balance bonds live) and every future maturity epoch, so the
  // redeemed branch no longer needs the (getLogs-based, range-capped)
  // historical scan — buildBondInfo reports isRedeemed from the live balance.
  let maturitySeconds = DEFAULT_BOND_MATURITY_SECONDS;
  try {
    const m = Number(await bondVault.bondMaturitySeconds());
    if (Number.isFinite(m) && m > 0) maturitySeconds = m;
  } catch {
    /* fall back to the 730-day default */
  }
  const epochs = enumerateEpochs();
  const built = await Promise.all(
    epochs.map((e) => buildBondInfo(wallet, e, maturitySeconds))
  );
  return built.filter((b): b is BondInfo => b !== undefined);
}

export async function getBondsByWallet(wallet: string, opts: ListBondsOptions): Promise<BondsListResult> {
  const w = wallet.toLowerCase();
  const cacheKey = `${w}:${opts.status === "redeemed" ? "with-redeemed" : "live"}`;

  // Cache lookup (TTL handled by makeCache)
  const hit = cache.get(cacheKey);
  let allBonds: BondInfo[];
  if (hit) {
    allBonds = hit;
    console.log(`[bonds] cache hit for ${w} (${allBonds.length} bonds)`);
  } else {
    const tStart = Date.now();
    try {
      allBonds = await loadAllBondsForWallet(w, opts.status === "redeemed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, wallet: w }, "bonds enumeration failed");
      throw new HttpError(503, `RPC failure listing bonds: ${msg}. Retry shortly.`, "rpc_unavailable");
    }
    cache.set(cacheKey, allBonds);
    console.log(`[bonds] total bonds for ${w}: ${allBonds.length} (${Date.now() - tStart}ms total)`);
  }

  // Apply status filter
  const filtered = allBonds.filter((b) => {
    switch (opts.status) {
      case "active":
        return !b.isRedeemed && !b.isMatured;
      case "matured":
        return !b.isRedeemed && b.isMatured;
      case "redeemed":
        return b.isRedeemed;
      case "all":
      default:
        return !b.isRedeemed; // default excludes fully-redeemed (zero balance) bonds
    }
  });

  // Stable order: newest epochId first
  filtered.sort((a, b) => (BigInt(b.epochId) > BigInt(a.epochId) ? 1 : -1));

  const total = filtered.length;
  const slice = filtered.slice(opts.offset, opts.offset + opts.limit);

  return {
    wallet: w,
    totalBonds: total,
    bonds: slice,
    pagination: {
      limit: opts.limit,
      offset: opts.offset,
      hasMore: opts.offset + slice.length < total,
    },
  };
}

// Test seam: clear the in-memory cache between test cases.
export function _resetBondsCache(): void {
  cache.reset();
}
