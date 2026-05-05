import { Contract, ethers } from "ethers";
import { provider } from "../utils/ethers";
import { loadConfig } from "../utils/config";
import { HttpError } from "../middlewares/error";

const cfg = loadConfig();

const AGGREGATOR_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

interface FeedConfig {
  address: string;
  asset: string; // bytes32
}

const ASSET_BTC = ethers.encodeBytes32String("BTC");
const ASSET_ETH = ethers.encodeBytes32String("ETH");

const FEEDS: Record<string, FeedConfig> = {
  BTC: { address: cfg.BTC_PRICE_FEED, asset: ASSET_BTC },
  ETH: { address: cfg.ETH_PRICE_FEED, asset: ASSET_ETH },
};

export interface CurrentPrice {
  price: bigint;
  asset: string;
  decimals: number;
  updatedAt: number;
}

export async function getCurrentPrice(symbol: string): Promise<CurrentPrice> {
  const upper = symbol.toUpperCase();
  const feed = FEEDS[upper];
  if (!feed) {
    throw new HttpError(400, `Unsupported asset: ${symbol}`, "unsupported_asset");
  }
  const aggregator = new Contract(feed.address, AGGREGATOR_V3_ABI, provider);
  const [decimals, round] = await Promise.all([
    aggregator.decimals() as Promise<bigint>,
    aggregator.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
  ]);
  const [, answer, , updatedAt] = round;
  return {
    price: answer,
    asset: feed.asset,
    decimals: Number(decimals),
    updatedAt: Number(updatedAt),
  };
}
