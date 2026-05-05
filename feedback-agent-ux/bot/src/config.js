import { ethers } from 'ethers';

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  apiBase: process.env.LUMINA_API_BASE || 'https://lumina-api-production-ac85.up.railway.app',
  apiKey: req('LUMINA_API_KEY'),
  privateKey: req('BOT_PRIVATE_KEY'),
  rpcUrl: process.env.RPC_URL || 'https://sepolia.base.org',
  tickHedger: Number(process.env.TICK_HEDGER_SEC || 900) * 1000,
  tickYield: Number(process.env.TICK_YIELD_SEC || 1800) * 1000,
  tickTrigger: Number(process.env.TICK_TRIGGER_SEC || 300) * 1000,
  hedgerCoverUsd: Number(process.env.HEDGER_COVER_USD || 50),
  port: Number(process.env.PORT || 3000),
  dryRun: process.env.DRY_RUN === '1',
};

export const ASSET_USDC = ethers.id('USDC');

export const wallet = new ethers.Wallet(config.privateKey);
export const provider = new ethers.JsonRpcProvider(config.rpcUrl);
export const signer = wallet.connect(provider);

export const BOT_ADDRESS = wallet.address;
