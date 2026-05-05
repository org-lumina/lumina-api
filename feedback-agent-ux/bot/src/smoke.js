import { config, BOT_ADDRESS, ASSET_USDC } from './config.js';
import { api } from './api.js';
import { getEth, getUsdc } from './onchain.js';

const log = (label, v) => console.log(`\n=== ${label} ===\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);

(async () => {
  log('config', { apiBase: config.apiBase, dryRun: config.dryRun, bot: BOT_ADDRESS });
  log('asset bytes32 (keccak256("USDC"))', ASSET_USDC);

  const h = await api.health();
  log('GET /health', h);

  if (h.ok) {
    log('on-chain ETH', await getEth());
    log('on-chain USDC (live)', await getUsdc(h.body.contracts.usdc));
  }

  const p = await api.products();
  log('GET /products', { count: p.body.count, first: p.body.products?.[0] });

  if (p.ok && p.body.products?.length) {
    const first = p.body.products[0];
    log('GET quote(50 USDC)', await api.quote(first.productId, '50000000'));
  }

  log('GET /api/v1/oracle/signer', await api.oracleSigner());
  log('GET /api/v1/policies?owner=BOT', await api.policiesByOwner(BOT_ADDRESS));
  log('GET /api/v1/bonds/BOT', await api.bonds(BOT_ADDRESS));
})();
