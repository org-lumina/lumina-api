import { bondVault, claimBond, provider } from "../utils/ethers";
import { logger } from "../utils/logger";
import { HttpError } from "../middlewares/error";

export type BondStatusFilter = "active" | "matured" | "redeemed" | "all";

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

interface CacheEntry {
  data: BondInfo[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, CacheEntry>();

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
  const events = await claimBond.queryFilter(filter);

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
  const events = await claimBond.queryFilter(filter);
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
  const balance: bigint = await claimBond.balanceOf(wallet, epochId);

  const info = await claimBond.getEpochInfo(epochId);
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

  // Cache lookup
  const now = Date.now();
  const hit = cache.get(cacheKey);
  let allBonds: BondInfo[];
  if (hit && hit.expiresAt > now) {
    allBonds = hit.data;
  } else {
    try {
      allBonds = await loadAllBondsForWallet(w, opts.status === "redeemed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, wallet: w }, "bonds enumeration failed");
      throw new HttpError(503, `RPC failure listing bonds: ${msg}. Retry shortly.`, "rpc_unavailable");
    }
    cache.set(cacheKey, { data: allBonds, expiresAt: now + CACHE_TTL_MS });
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
  cache.clear();
}
