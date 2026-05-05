// One-shot live probe: hit POST /api/v1/policies once with the canonical
// schema and capture the raw response. Used to prove the live-mode failure mode.
import { config, ASSET_USDC, BOT_ADDRESS } from './config.js';
import { api } from './api.js';

(async () => {
  const products = (await api.products()).body.products;
  const p = products[0];
  const cover = '50000000';
  const q = await api.quote(p.productId, cover);
  console.log('quote:', q.body);
  const r = await api.buyPolicy(p.productId, cover, ASSET_USDC, BOT_ADDRESS);
  console.log('buy status:', r.status);
  console.log('buy body:', JSON.stringify(r.body, null, 2));
})();
