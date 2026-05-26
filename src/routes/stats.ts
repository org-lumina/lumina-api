import { Router } from "express";
import { ethers } from "ethers";
import { provider } from "../utils/ethers";
import { loadConfig } from "../utils/config";

/**
 * GET /api/v1/live-stats — aggregated INSTANT on-chain stats for public surfaces.
 *
 * Every value is verifiable on-chain (the `source` field names the exact call).
 * Historical/cumulative aggregates (total burned, bonds outstanding, volume) are
 * intentionally NOT here — they require the (currently parked) Ponder indexer; we
 * do not fabricate them.
 *
 * Caching: one set of RPC reads is cached in-process for `CACHE_TTL_MS`. On RPC
 * failure the last successful snapshot is served with `stale: true` so the page
 * never breaks; if there is no prior snapshot a 503 is returned.
 */
export const statsRouter = Router();

const cfg = loadConfig();
const CACHE_TTL_MS = 30_000;

const LUMINA_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const BONDVAULT_ABI = [
  "function priceOracle() view returns (address)",
  "function availableCapacityUSD() view returns (uint256)",
  "function totalCommittedUSD() view returns (uint256)",
];
const ORACLE_ABI = ["function getLuminaPrice() view returns (uint256)"];

const lumina = new ethers.Contract(cfg.LUMINA_TOKEN, LUMINA_ABI, provider);
const bondVault = new ethers.Contract(cfg.BOND_VAULT, BONDVAULT_ABI, provider);

interface LiveStats {
  luminaPrice: { usd: number; source: string };
  bondReserve: { lumina: string; usd: string; source: string };
  capacity: {
    usedPercent: string;
    committedUSD: string;
    availableUSD: string;
    source: string;
  };
  totalSupply: { lumina: string; source: string };
  chainStatus: { chainId: number; name: string; blockNumber: number };
  lastUpdated: string;
  stale?: boolean;
}

let cache: { data: LiveStats; ts: number } | null = null;

async function readChain(): Promise<LiveStats> {
  const oracleAddr: string = await bondVault.priceOracle();
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, provider);

  const [totalSupplyWei, reserveWei, price18, committed18, availableUSD, block, net] =
    await Promise.all([
      lumina.totalSupply() as Promise<bigint>,
      lumina.balanceOf(cfg.BOND_VAULT) as Promise<bigint>,
      oracle.getLuminaPrice() as Promise<bigint>,
      bondVault.totalCommittedUSD() as Promise<bigint>,
      bondVault.availableCapacityUSD() as Promise<bigint>, // integer USD
      provider.getBlockNumber(),
      provider.getNetwork(),
    ]);

  const priceUsd = Number(price18) / 1e18;
  const reserveLumina = Number(reserveWei) / 1e18;
  const reserveUsd = reserveLumina * priceUsd;
  const committedUsd = Number(committed18) / 1e18; // totalCommittedUSD is 18-dec USD-wei
  const availUsd = Number(availableUSD);
  const maxCap = committedUsd + availUsd;
  const usedPct = maxCap > 0 ? (committedUsd / maxCap) * 100 : 0;

  return {
    luminaPrice: { usd: Number(priceUsd.toFixed(6)), source: "BondVault.priceOracle().getLuminaPrice()" },
    bondReserve: {
      lumina: reserveLumina.toFixed(2),
      usd: reserveUsd.toFixed(2),
      source: "LUMINA.balanceOf(bondVault)",
    },
    capacity: {
      usedPercent: `${usedPct.toFixed(2)}%`,
      committedUSD: committedUsd.toFixed(2),
      availableUSD: availUsd.toString(),
      source: "BondVault.totalCommittedUSD/availableCapacityUSD",
    },
    totalSupply: { lumina: (Number(totalSupplyWei) / 1e18).toLocaleString("en-US"), source: "LUMINA.totalSupply()" },
    chainStatus: { chainId: Number(net.chainId), name: "Base Sepolia", blockNumber: Number(block) },
    lastUpdated: new Date().toISOString(),
  };
}

statsRouter.get("/live-stats", async (_req, res, next) => {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
      return res.json(cache.data);
    }
    const data = await readChain();
    cache = { data, ts: Date.now() };
    return res.json(data);
  } catch (e) {
    // Fail-soft: serve last-known snapshot flagged stale; else 503.
    if (cache) {
      return res.json({ ...cache.data, stale: true });
    }
    return next(e);
  }
});
