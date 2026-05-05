# Skill: Get bonds owned (by holder)

> 🔄 **Addresses are dynamic.** Always fetch the latest from `GET /health` (e.g. `https://lumina-api-production-ac85.up.railway.app/health`) instead of trusting hardcoded values below. The on-chain addresses shown here are accurate as of 2026-05-05 (Base Sepolia 84532) but verify before use.

Both audiences. List the ClaimBond holdings of any wallet.

---

## 👤 For Humans

**Difficulty**: ⭐ · **Time**: ~20 seconds

### What this does

ClaimBonds are ERC-1155 tokens (1 token = $1 face value). All bonds maturing the same month share an `epochId` — they're fungible within an epoch. This skill shows you all your bonds, grouped by maturity date.

### Step by step

1. **Connect your wallet** in `/app`
2. Go to `/app/human/portfolio`
3. Click the **"My Bonds"** tab
4. Each row: epoch ID, face value (in $), maturity date, status (HOLDING / MATURED), and a Redeem button when matured

### What you'll see when it works

Rows like: `#202805 · $5,000 · 2028-05-15 · HOLDING`

### Common issues

- **Empty list with bonds you should have** → wrong wallet connected
- **Slow load** → public RPC throttle; try again

### What to do next

- Bond shows MATURED → see [Redeem matured bond](./redeem-bond.md)
- Want to sell early? → see [List bond](./list-bond.md)

---

## 🤖 For AI Agents

**Type**: read · **Difficulty**: ⭐⭐

### What this does

Two paths: (1) on-chain via `BondsMinted` events (`to` IS indexed → efficient filter); (2) REST via `GET /api/v1/bonds/:wallet` (auth required).

### Ready-to-use LLM prompt

```
You are an AI agent enumerating Lumina ClaimBond holdings (Base Sepolia).

YOUR GOAL: For a given wallet, return the (epochId, balance, matured) for
every bond it holds.

CONTEXT:
- ClaimBond: 0x3d2F5DB2505367D00ef81c51AD3cA66159271730  (ERC-1155)
- Event: BondsMinted(uint256 indexed epochId, address indexed to, uint256 usdAmount)
  → both epochId and `to` are INDEXED, so topic filter on `to` works directly
- balanceOf(account, epochId) returns INTEGER DOLLARS (1 token = $1, no decimals)
- isMatured(epochId) → bool

INSTRUCTIONS:
1. getLogs(ClaimBond, BondsMinted, args:{ to: wallet }) → list of epochIds
2. For each unique epochId:
   - balanceOf(wallet, epochId)  → current balance (after burns/transfers)
   - isMatured(epochId)          → can redeem now?
3. Filter balance > 0 (drop fully-redeemed/sold positions)

WHEN TO STOP:
- Success: array of { epochId, balance, matured } with balance > 0
```

### HTTP examples

#### On-chain (events + reads)

```typescript
const mints = await client.getLogs({
  address: '0x3d2F5DB2505367D00ef81c51AD3cA66159271730',
  event: parseAbiItem('event BondsMinted(uint256 indexed epochId, address indexed to, uint256 usdAmount)'),
  args: { to: wallet },
  fromBlock: 'earliest',
})
const epochs = [...new Set(mints.map(m => m.args.epochId))]

const balances = await Promise.all(epochs.map(e => 
  client.readContract({ address: CLAIM_BOND, abi, functionName: 'balanceOf', args: [wallet, e] })
))
```

#### REST API (agent-only)

```bash
curl https://lumina-api-production-ac85.up.railway.app/api/v1/bonds/0xWALLET \
  -H "x-api-key: $LUMINA_API_KEY"
```

Query params: `?status=active|matured|redeemed|all`, `?limit=100`, `?offset=0`.

### Important: bond units

- `balanceOf(holder, epochId)` returns **INTEGER DOLLARS** (count of $1 bonds)
- `getHolderFaceValue(holder, epochId)` returns **count × 1e18** (18-dec USD-wei)
- Use `balanceOf` directly when calling `redeemBond` (units must match) — see [redeem-bond](./redeem-bond.md)

### Related skills

- [Watch triggers](./watch-triggers.md)
- [Redeem bond](./redeem-bond.md)
- [List bond on marketplace](./list-bond.md)

## Source

- Event: `LUMINA-PROTOCOL/src/bonds/ClaimBond.sol:34` — `event BondsMinted` (`to` indexed)
- ERC-1155 balanceOf: inherited
- Face value: `ClaimBond.sol:120` — `getFaceValue` returns `1e18` (= $1 in 18-dec)
- API: `lumina-api/src/routes/bonds.ts:24` — `bondsAuthRouter.get("/:wallet", …)`
