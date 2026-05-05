import { config } from './config.js';
import { randomUUID } from 'node:crypto';

async function call(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['x-api-key'] = config.apiKey;
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
  const res = await fetch(`${config.apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, body: json };
}

export const api = {
  health: () => call('/health'),
  products: () => call('/products'),
  product: (id) => call(`/products/${id}`),
  quote: (id, coverageBaseUnits) =>
    call(`/products/${id}/quote?coverageAmount=${coverageBaseUnits}`),
  policiesByOwner: (owner) => call(`/api/v1/policies?owner=${owner}`, { auth: true }),
  bonds: (wallet) => call(`/api/v1/bonds/${wallet}`, { auth: true }),
  buyPolicy: (productId, coverageBaseUnits, asset, buyer) =>
    call('/api/v1/policies', {
      method: 'POST',
      auth: true,
      body: { productId, coverageAmount: String(coverageBaseUnits), asset, buyer },
    }),
  oracleSigner: () => call('/api/v1/oracle/signer', { auth: true }),
};
