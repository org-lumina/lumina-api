# Skill: Health check

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

**For**: AI Agents · **Type**: read · **Difficulty**: ⭐

---

## What this does

Public, unauthenticated endpoint for monitors and uptime probes. Returns service status. Use it before sending real requests, in your bot's startup sequence, or in your monitoring stack.

## Ready-to-use LLM prompt

```
You are an AI agent verifying Lumina API health (Base Sepolia).

YOUR GOAL: Confirm the API is reachable before issuing real calls.

CONTEXT:
- API base URL: https://lumina-api-production-ac85.up.railway.app
- Endpoint: GET /health
- Auth: NONE (public)
- Use this on startup AND as a periodic probe

INSTRUCTIONS:
1. GET /health
2. If 200 → continue with real flow
3. If non-200 → wait + retry; if 3 consecutive failures, alert operator

WHEN TO STOP:
- Success: HTTP 200
- Block: 3 consecutive non-200 → API outage; escalate
```

## HTTP examples

### curl

```bash
curl -i https://lumina-api-production-ac85.up.railway.app/health
```

### TypeScript

```typescript
const res = await fetch('https://lumina-api-production-ac85.up.railway.app/health')
if (!res.ok) throw new Error('Lumina API unhealthy')
const status = await res.json()
```

### Python

```python
import requests
res = requests.get('https://lumina-api-production-ac85.up.railway.app/health', timeout=5)
res.raise_for_status()
```

## Response schema

Returns JSON status. No personally identifiable data — safe to log.

## Error codes

| HTTP | Meaning | Retry? |
|---|---|---|
| 200 | Healthy | — |
| 5xx | API down or restarting | Yes, with backoff |

## Use cases

- **Bot startup**: gate everything else behind a successful health check
- **Periodic probe**: ping every 30s or 1m; trigger an alert if 3 in a row fail
- **Status page**: external uptime services (UptimeRobot, BetterStack, etc.) point here
- **Smoke test**: quick "is the API alive?" check from a CI pipeline

## Rate limits

`publicIpLimiter` per IP. Don't pound it — once per 30s is plenty.

## Related skills

- [Configure API client](./configure-api-client.md)
- [Quote via API](./quote-via-api.md)

## Source

- Endpoint: `lumina-api/src/routes/health.ts:8` — `healthRouter.get("/", …)`
- Mount: `src/app.ts:20` — `app.use("/health", publicIpLimiter, healthRouter)`
