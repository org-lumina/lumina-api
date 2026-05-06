import { config, ASSET_USDC, BOT_ADDRESS } from './config.js';
import { api } from './api.js';
import { record, isPaused, isShieldDisabled, noteShieldFail, noteShieldOk, noteOk, noteError } from './state.js';
import { getEth, getUsdc } from './onchain.js';

let healthCache = null;
async function health() {
  if (!healthCache || Date.now() - healthCache.at > 60_000) {
    const h = await api.health();
    if (!h.ok) throw new Error(`health failed: ${h.status}`);
    healthCache = { at: Date.now(), data: h.body };
  }
  return healthCache.data;
}

function dollarsToBase(usd) { return BigInt(Math.round(usd * 1_000_000)); }

export async function runHedger() {
  if (isPaused()) return record({ strategy: 'hedger', action: 'skip', reason: 'paused' });
  const h = await health();
  const eth = await getEth();
  if (eth < 0.01) {
    return record({ strategy: 'hedger', action: 'skip', reason: 'gas balance < 0.01 ETH', eth });
  }
  const usdc = await getUsdc(h.contracts.usdc);
  if (usdc < 1000) {
    return record({ strategy: 'hedger', action: 'skip', reason: 'usdc < $1000', usdc });
  }

  const products = (await api.products()).body.products || [];
  const owned = (await api.policiesByOwner(BOT_ADDRESS)).body.policies || [];
  const ownedShields = new Set(owned.filter(p => p.active).map(p => p.shield));

  for (const p of products) {
    if (!p.active) continue;
    if (ownedShields.has(p.shield)) {
      record({ strategy: 'hedger', action: 'skip', shield: p.shield, reason: 'already covered' });
      continue;
    }
    if (isShieldDisabled(p.shield)) {
      record({ strategy: 'hedger', action: 'skip', shield: p.shield, reason: 'temporarily disabled' });
      continue;
    }

    const cover = dollarsToBase(config.hedgerCoverUsd);
    const q = await api.quote(p.productId, cover.toString());
    if (!q.ok) {
      noteShieldFail(p.shield); noteError();
      record({ strategy: 'hedger', action: 'quote_fail', shield: p.shield, status: q.status, body: q.body });
      continue;
    }
    const premiumUsd = Number(q.body.premium) / 1e6;

    if (config.dryRun) {
      record({ strategy: 'hedger', action: 'dry_buy', shield: p.shield, productId: p.productId,
               coverUsd: config.hedgerCoverUsd, premiumUsd, reason: 'DRY_RUN=1' });
      noteShieldOk(p.shield); noteOk();
      continue;
    }

    const r = await api.buyPolicy(p.productId, cover.toString(), ASSET_USDC, BOT_ADDRESS);
    if (r.ok) {
      noteShieldOk(p.shield); noteOk();
      record({ strategy: 'hedger', action: 'bought', shield: p.shield, productId: p.productId,
               coverUsd: config.hedgerCoverUsd, premiumUsd, response: r.body });
    } else {
      noteShieldFail(p.shield); noteError();
      record({ strategy: 'hedger', action: 'buy_fail', shield: p.shield, status: r.status, body: r.body });
    }
  }
}

export async function runYieldFarmer() {
  if (isPaused()) return record({ strategy: 'yield', action: 'skip', reason: 'paused' });
  record({
    strategy: 'yield',
    action: 'gap',
    reason: 'No GET /api/v1/marketplace/listings on the API; on-chain Listed event scan would be needed (out of scope for this spike).',
  });
}

export async function runTriggerHunter() {
  if (isPaused()) return record({ strategy: 'trigger', action: 'skip', reason: 'paused' });
  const policies = (await api.policiesByOwner(BOT_ADDRESS)).body.policies || [];
  if (!policies.length) {
    return record({ strategy: 'trigger', action: 'skip', reason: 'no policies owned' });
  }
  for (const p of policies) {
    record({
      strategy: 'trigger',
      action: 'check',
      policyId: p.policyId,
      reason: 'on-chain submitTrigger flow is not fully documented (oracle proof + CoverRouter call). Logged for ops.',
    });
  }
}
