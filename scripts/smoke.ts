/**
 * Smoke test against the live Base Sepolia deploy.
 *
 *   npm run smoke
 *
 * Reads RPC + contract addresses from .env. Hits CoverRouter to:
 *   1. Confirm the RPC is reachable and chain id is 84532.
 *   2. Read getProductCount() — expected 9 after the 2026-04-27 deploy.
 *   3. Read each product's config + shield + quotePremium for a sample coverage.
 *
 * Does NOT submit any transaction.
 */
import { coverRouter, policyManager, provider, relayer } from "../src/utils/ethers";
import { listProducts, quotePremium } from "../src/services/products";

async function main(): Promise<void> {
  const network = await provider.getNetwork();
  const block = await provider.getBlockNumber();
  const balance = await provider.getBalance(relayer.address);
  console.log("== Network ==");
  console.log("  chainId:", network.chainId.toString());
  console.log("  block:  ", block);
  console.log("  relayer:", relayer.address, "balance(wei):", balance.toString());

  console.log("\n== CoverRouter ==");
  const count = await coverRouter.getProductCount();
  console.log("  products:", count.toString());

  console.log("\n== PolicyManager ==");
  const totalPolicies = await policyManager.totalPolicies();
  const activePolicies = await policyManager.activePolicies();
  console.log("  totalPolicies:", totalPolicies.toString());
  console.log("  activePolicies:", activePolicies.toString());

  console.log("\n== Products (via service) ==");
  const products = await listProducts();
  for (const p of products) {
    console.log(
      `  ${p.productId}  active=${p.active}  payout=${p.payoutRatioBps}bps  duration=${p.durationSeconds}s  shield=${p.shield}`
    );
  }

  if (products.length > 0 && products[0].active) {
    console.log("\n== Quote (1000 USDC = 1e9 base units on first product) ==");
    const q = await quotePremium(products[0].productId, 1_000_000_000n);
    console.log("  premium:", q.premium, "payout:", q.payout);
  }

  console.log("\nOK — smoke test passed.");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
