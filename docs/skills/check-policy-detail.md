# Skill: Check policy detail

Both audiences. Look up a single policy by `(productId, policyId)`.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~10 seconds

### What this does

Pull the current state of a specific policy: cover, premium paid, payout amount, status (active / triggered / expired), and timestamps. Useful when you want to share a policy link with someone or verify a tx.

### Step by step

1. Open `/app/human/portfolio` and click any row in the Active Policies tab
2. (Or paste the productId+policyId into the URL — coming soon)

### Common issues

- **Status says "active" but trigger window passed** → wait a few minutes for the keeper bot to mark it expired

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐

### What this does

Public REST endpoint — no auth — that returns a single policy snapshot. Use this when you only need a single policy and want to skip log indexing.

### Ready-to-use LLM prompt

```
You are an AI agent verifying a Lumina policy state (Base Sepolia).

YOUR GOAL: Fetch the latest snapshot for a single policy.

CONTEXT:
- API base URL: https://lumina-api-production-ac85.up.railway.app
- Endpoint: GET /policies/:productId/:policyId
- Auth: NONE (public endpoint, IP-rate-limited)

INSTRUCTIONS:
1. GET /policies/{productId}/{policyId}
2. Inspect status: "active" | "triggered" | "expired"
3. If status === "triggered" and you didn't yet record the bond,
   trigger your bond-tracking flow

WHEN TO STOP:
- Success: HTTP 200 with policy object
- Block: HTTP 404 → policy doesn't exist; verify productId/policyId
```

### HTTP examples

#### curl

```bash
PRODUCT_ID="0xAc53Bf7Bb85Fcfb6d3c831F3AD9f6f79ebeeF99f"
POLICY_ID="42"
curl "https://lumina-api-production-ac85.up.railway.app/policies/${PRODUCT_ID}/${POLICY_ID}"
```

#### TypeScript (fetch)

```typescript
const res = await fetch(
  `https://lumina-api-production-ac85.up.railway.app/policies/${productId}/${policyId}`,
)
const policy = await res.json()
```

#### Python (requests)

```python
import requests
res = requests.get(f'https://lumina-api-production-ac85.up.railway.app/policies/{product_id}/{policy_id}')
policy = res.json()
```

### Response schema

Shape returned by the route handler — matches the `PolicyRecord` struct from `PolicyManagerV2.getPolicy(productId, policyId)`.

### Error codes

| HTTP | Meaning | Retry? |
|---|---|---|
| 200 | OK | — |
| 404 | Policy not found | No — fix ids |
| 429 | Rate limited (per IP) | Yes, backoff |
| 500 | Server / RPC error | Yes |

### Rate limits

`publicIpLimiter` per IP. No per-key tier (it's a public endpoint).

### Related skills

- [Track policies](./track-policies.md)
- [Watch triggers](./watch-triggers.md)
- [Buy policy as Agent](./buy-policy-agent.md)

## Source

- Endpoint: `lumina-api/src/routes/policies.ts:23` — `policiesPublicRouter.get("/:productId/:policyId", …)`
- Mount: `src/app.ts:22` — `app.use("/policies", publicIpLimiter, policiesPublicRouter)`
- Underlying contract read: `LUMINA-PROTOCOL/src/core/PolicyManagerV2.sol:338` — `getPolicy(productId, policyId)`
