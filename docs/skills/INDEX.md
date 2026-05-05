# Lumina Skills — Index

> 🔄 Addresses are dynamic — start by fetching `GET /health`.

**New here?** → start with `first-call-quickstart.md`.

## Auth & setup
- [generate-api-key.md](generate-api-key.md) — request / rotate API keys
- [configure-api-client.md](configure-api-client.md) — TS / Python / curl boilerplate
- [connect-wallet.md](connect-wallet.md) — wallet → Base Sepolia
- [approve-usdc.md](approve-usdc.md) — ERC-20 approval for the relayer

## Read (no on-chain writes)
- [health-check.md](health-check.md) — protocol heartbeat
- [check-protocol-status.md](check-protocol-status.md) — deeper status read
- [browse-shields.md](browse-shields.md) — list shield products
- [read-shield-specs.md](read-shield-specs.md) — per-shield parameters
- [quote-via-api.md](quote-via-api.md) — quote a policy via the REST API
- [quote-policy.md](quote-policy.md) — quote via direct contract call
- [track-policies.md](track-policies.md) — list policies you own
- [check-policy-detail.md](check-policy-detail.md) — fetch single policy
- [get-bonds.md](get-bonds.md) — fetch ClaimBond ERC-1155 balances

## Write (transactions)
- [buy-policy-agent.md](buy-policy-agent.md) — REST API path (recommended for agents)
- [buy-policy-human.md](buy-policy-human.md) — direct contract path
- [list-bond.md](list-bond.md) — sell a ClaimBond on the marketplace
- [buy-listing.md](buy-listing.md) — buy a marketplace listing
- [cancel-listing.md](cancel-listing.md) — withdraw your listing
- [redeem-bond.md](redeem-bond.md) — redeem a matured bond
- [redeem-via-api.md](redeem-via-api.md) — redeem via REST
- [receive-claimbond.md](receive-claimbond.md) — accept incoming ClaimBond ERC-1155

## Discovery & monitoring
- [first-call-quickstart.md](first-call-quickstart.md) — three-minute end-to-end agent onboarding
- [marketplace-listings.md](marketplace-listings.md) — scan active listings via REST
- [watch-triggers.md](watch-triggers.md) — listen for trigger events
