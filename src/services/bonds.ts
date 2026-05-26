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
 * Enumerate every epoch that has ever existed via the (cheap, low-cardinality)
 * `EpochCreated` event log. Returns `{epochId, createdAt}` per epoch.
 */
async function enumerateEpochs(): Promise<Array<{ epochId: bigint; createdAt: string }>> {
  const filter = claimBond.filters.EpochCreated();
  const latest = await provider.getBlockNumber();
  const fromBlock = await getStartBlock(latest);
  const events = await paginatedQueryFilter(
    claimBond,
    filter as unknown as DeferredTopicFilter,
    fromBlock,
    latest,
    "EpochCreated"
  );

  const blockTimestamps = new Map<number, bigint>();
  // Dedupe by blockNumber so the same block is only fetched once.
  const uniqueBlocks = Array.from(new Set(events.map((e) => e.blockNumber)));
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const block = await provider.getBlock(bn);
      if (block) blockTimestamps.set(bn, BigInt(block.timestamp));
    })
  );

  return events.map((ev) => {
    const args = ("args" in ev ? ev.args : undefined) as { epochId?: bigint } | undefined;
    const epochId = args?.epochId ?? 0n;
    const ts = blockTimestamps.get(ev.blockNumber) ?? 0n;
    return { epochId, createdAt: isoFromUnix(ts) };
  });
}

/**
 * Augment redeemed-status results: enumerate epochs the wallet ever HELD via
 * `TransferSingle` events with `to == wallet`. Used only when status=='redeemed'
 * (default flow uses the cheaper EpochCreated enumeration).
 */
async function enumerateHistoricalEpochs(wallet: string): Promise<bigint[]> {
  const filter = claimBond.filters.TransferSingle(null, null, wallet);
  const latest = await provider.getBlockNumber();
  const fromBlock = await getStartBlock(latest);
  const events = await paginatedQueryFilter(
    claimBond,
    filter as unknown as DeferredTopicFilter,
    fromBlock,
    latest,
    `TransferSingle->${wallet.slice(0, 8)}`
  );
  const ids = new Set<string>();
  for (const ev of events) {
    const args = ("args" in ev ? ev.args : undefined) as { id?: bigint } | undefined;
    if (args?.id !== undefined) ids.add(args.id.toString());
  }
  return Array.from(ids).map((s) => BigInt(s));
}

async function buildBondInfo(
  wallet: string,
  epochId: bigint,
  createdAt: string
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

async function loadAllBondsForWallet(wallet: string, includeRedeemed: boolean): Promise<BondInfo[]> {
  const epochs = await enumerateEpochs();
  const epochsByCreated = new Map<string, string>();
  for (const e of epochs) epochsByCreated.set(e.epochId.toString(), e.createdAt);

  let candidateIds = epochs.map((e) => e.epochId);
  if (includeRedeemed) {
    // Add wallet-historical ids the global enumeration may have missed
    // (defensive — `EpochCreated` already covers everything in V5.1, but a
    // future cleanup that prunes events would otherwise hide redeemed bonds).
    const historical = await enumerateHistoricalEpochs(wallet);
    const set = new Set(candidateIds.map((id) => id.toString()));
    for (const id of historical) {
      if (!set.has(id.toString())) {
        candidateIds.push(id);
        if (!epochsByCreated.has(id.toString())) {
          epochsByCreated.set(id.toString(), isoFromUnix(0));
        }
      }
    }
  }

  const built = await Promise.all(
    candidateIds.map((id) => buildBondInfo(wallet, id, epochsByCreated.get(id.toString()) ?? isoFromUnix(0)))
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
