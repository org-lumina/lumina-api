# Phase 3 — Deploy UX Report

**Target**: Railway. Production URL: **https://lumina-agent-bot-production.up.railway.app**

---

## Was Railway deploy documented in Lumina docs?

**Indirectly.** The `lumina-api` repo has a `railway.toml` and a Dockerfile, so the pattern of "deploy this on Railway" is implied. But:

- No `/docs` page or skill explains how an *agent operator* should host their bot.
- No reference architecture ("the bot lives where you run it; here's a Railway template").
- No mention that the API host itself is Railway, which would have made the platform choice obvious.

For a brand-new agent dev, picking Railway was a guess based on observing `…-production-….up.railway.app` in the API host name.

---

## How long did the deploy take

| Step | Time |
|---|---|
| Detect Railway CLI is installed and authenticated | 30 s |
| `railway init --workspace <id> --name lumina-agent-bot` | 5 s |
| `railway link --project <id>` (interactive prompt despite flag) | 10 s |
| `railway add --service lumina-agent-bot --variables ...` ×9 | 20 s |
| `railway up --detach` (Docker build + upload) | ~25 s |
| First successful health probe (HTTP 200 on `/health`) | 25 s after build |
| **Total** | **~2 minutes** |

The bot wakes up on the first scheduler tick and immediately logs:
```json
{"strategy":"hedger","action":"skip","reason":"usdc < $1000","usdc":0}
{"strategy":"yield","action":"gap","reason":"No GET /api/v1/marketplace/listings on the API"}
{"strategy":"trigger","action":"skip","reason":"no policies owned"}
{"level":"info","msg":"bot up on :8080","dryRun":false,"bot":"0x25D245F735Ab6Ba178E258e1FcEB02F15Cf6dc3d"}
```

---

## Issues encountered

### ⚠ Critical: Railway CLI `--variables` flag echoes secrets in plaintext

When passing secrets via `railway add --variables "KEY=VALUE"`, the CLI's confirmation step **prints each variable line including the value** to stdout. This means:
- `BOT_PRIVATE_KEY` and `LUMINA_API_KEY` ended up in the Phase-3 transcript of this stress test.
- **Both secrets MUST be rotated** before the next sprint — see the final report.

This is a Railway-CLI UX problem (not a Lumina problem), but a Lumina deployment guide should warn agent operators to use `railway variable set --stdin` or equivalent for secret values, never `--variables`.

### Railway init/link are partially interactive even with all flags supplied

`railway init --workspace <id> --name lumina-agent-bot` still prints prompts ("Select a workspace: ..." then "Project Name: ...") that auto-resolve via the flags but visually look interactive. `railway link --project <id>` similarly prompts for environment despite the flag. Both eventually succeed, but a CI script would fail spec-conformance checks. Deploy guide should warn.

### `railway up` cannot create a service implicitly

The first attempt was `railway up --detach --service lumina-agent-bot` immediately after `railway init`. It returned `Service not found`. Resolution: `railway add --service lumina-agent-bot ...` first (which also seeds env vars), THEN `railway up`. Order matters; not obvious from CLI help.

### Domain assignment is a separate manual step

After `railway up`, the service has no public URL. Need `railway domain` to provision `lumina-agent-bot-production.up.railway.app`. Not a problem, but a fresh agent would not know to run it.

---

## Live verification

```bash
$ curl https://lumina-agent-bot-production.up.railway.app/health
{"ok":true,"bot":"0x25D245F735Ab6Ba178E258e1FcEB02F15Cf6dc3d","dryRun":false}

$ curl https://lumina-agent-bot-production.up.railway.app/agent-bot/log | jq length
4
```

The bot is autonomously running with 15-minute Hedger / 30-minute YieldFarmer / 5-minute TriggerHunter cycles, but every Hedger tick correctly halts at the safety rail because the live USDC balance is $0 (see the bot funding gap in Phase 1 §4 and Phase 4 §"Edge cases").

---

## Would a typical agent dev figure this out?

**With help** — given `railway init`, `railway add`, `railway up` is a 2-minute happy-path, but only after wading through the implicit-order issue and the secrets-echo issue. A 10-line `DEPLOY.md` from Lumina would close this entirely.

---

## Deploy artefact summary

| Artefact | Value |
|---|---|
| Railway project ID | `11c6dbf7-8fa8-4f9a-912f-d2708a0ecdda` |
| Railway service ID | `d237973a-e7cf-4904-9931-1d1f3e1af26b` |
| Railway service name | `lumina-agent-bot` |
| Public URL | `https://lumina-agent-bot-production.up.railway.app` |
| Build | Dockerfile (Node 20-alpine, `node src/index.js`) |
| Dry-run flag | `DRY_RUN=0` (LIVE) |
| Bot wallet | `0x25D245F735Ab6Ba178E258e1FcEB02F15Cf6dc3d` |
