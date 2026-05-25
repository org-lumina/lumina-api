import { Router } from "express";
import { z } from "zod";
import { ethers, parseEther } from "ethers";
import { provider, relayer } from "../utils/ethers";
import { getMockUsdcContract } from "../utils/usdcContract";
import { publicIpLimiter } from "../middlewares/rateLimit";
import { HttpError } from "../middlewares/error";
import { logger } from "../utils/logger";
import { loadConfig } from "../utils/config";
import { withLock, RELAYER_TX_LOCK_KEY } from "../utils/lock";
import {
  lastClaimByWallet,
  lastClaimByIp,
  countClaimsLast24h,
  insertClaim,
} from "../utils/faucetDb";

/**
 * Sprint L (original) + Sprint USDC Mock (Phase 5) — Public testnet faucet.
 *
 * POST /api/v1/faucet/claim   { wallet }
 * GET  /api/v1/faucet/status
 *
 * Mints `FAUCET_USDC_AMOUNT` of MockUSDC (default 10,000 mUSDC) + sends
 * 0.05 Sepolia ETH to the requested wallet. Gated by:
 *   - 1 claim per wallet / 24h        (SQLite faucet_claims)
 *   - 1 claim per IP / 24h            (SQLite faucet_claims)
 *   - Daily global cap of 50 claims   (caps relayer drain — ETH only,
 *                                      mUSDC is permissionless mintable)
 *   - Pre-check of relayer ETH        (returns 503 cleanly if low)
 *
 * Sprint USDC Mock (Phase 5) migration: the faucet now calls
 * `mockUsdc.mint(to, amount)` instead of `usdc.transfer(to, amount)` so
 * the relayer no longer needs a pre-funded mUSDC balance. The protocol's
 * canonical USDC (Circle bridged, non-mintable) remains used by the
 * normal policy-purchase path — only the faucet uses the mintable mock.
 *
 * No auth, no captcha — testnet only; humans and AI agents both call it.
 */

export const faucetRouter = Router();

const cfg = loadConfig();

const ETH_PER_CLAIM_WEI = parseEther("0.05");
const ETH_GAS_BUFFER_WEI = parseEther("0.001"); // +1 mETH headroom for gas
const USDC_PER_CLAIM = BigInt(cfg.FAUCET_USDC_AMOUNT); // default 10_000 * 1e6 = 10,000 mUSDC
const DAILY_CAP = 50;
const RATE_LIMIT_WINDOW_S = 86400; // 24h

const ClaimBodySchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "wallet must be 0x-prefixed 40-char hex"),
});

// In-process serialisation for ALL claim requests. The lock is GLOBAL (single
// key) — not per-wallet or per-IP — to close the audit HIGH-1 race:
//
//   Two concurrent requests for the same wallet from different IPs (or the
//   same IP with different wallets) would otherwise hold disjoint locks,
//   both pass the `lastClaimByWallet`/`lastClaimByIp` checks (because
//   neither has committed `insertClaim` yet), and both fire transferences —
//   draining the relayer twice for the same wallet.
//
// [MR-H02] The key is now the SHARED `RELAYER_TX_LOCK_KEY` (utils/lock.ts) —
// not a faucet-specific key — so the faucet and the policy-purchase path
// (`purchaseViaRelayer`) serialise against each other. Both sign & broadcast
// from the SAME relayer wallet, hence share one pending-nonce sequence; a
// faucet-private key would let a concurrent purchase collide on that nonce.
//
// Single global lock is fine for the testnet load (50 claims/day cap = ~2/h),
// adds zero practical latency, and eliminates the race entirely. If we
// ever scale to a multi-instance deploy, replace with either a SQLite
// IMMEDIATE-locked transaction wrapping check+insert or an external locker
// (Redis SETNX). Single-instance scope is documented in tracking/sprint-l-faucet.md.

faucetRouter.post("/faucet/claim", publicIpLimiter, async (req, res, next) => {
  try {
    const parsed = ClaimBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0].message, "invalid_request");
    }
    const wallet = parsed.data.wallet;
    const walletLower = wallet.toLowerCase();

    // Express has `trust proxy = 1` set in app.ts, so `req.ip` reflects the
    // X-Forwarded-For chain that Railway populates. Fall back to socket addr
    // if for any reason `req.ip` is undefined.
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

    // [Audit HIGH-1] Global lock (see GLOBAL_LOCK_KEY comment above): a
    // per-(wallet|ip) lock would let "wallet W from IP X" + "wallet W from IP Y"
    // race past the rate-limit check. Global serialisation closes the gap.
    await withLock(RELAYER_TX_LOCK_KEY, async () => {
      // ── Cap + rate-limit checks (all read inside the lock) ──
      const now = Math.floor(Date.now() / 1000);

      const claimsToday = countClaimsLast24h();
      if (claimsToday >= DAILY_CAP) {
        throw new HttpError(
          503,
          `Daily faucet cap of ${DAILY_CAP} reached. Try again later.`,
          "daily_cap_reached"
        );
      }

      const lastWallet = lastClaimByWallet(walletLower);
      if (lastWallet && lastWallet.claimed_at + RATE_LIMIT_WINDOW_S > now) {
        const retryAfter = lastWallet.claimed_at + RATE_LIMIT_WINDOW_S - now;
        res.set("Retry-After", retryAfter.toString());
        throw new HttpError(
          429,
          `Wallet already claimed in last 24h. Retry in ${Math.ceil(retryAfter / 3600)}h.`,
          "wallet_rate_limited"
        );
      }

      const lastIp = lastClaimByIp(ip);
      if (lastIp && lastIp.claimed_at + RATE_LIMIT_WINDOW_S > now) {
        const retryAfter = lastIp.claimed_at + RATE_LIMIT_WINDOW_S - now;
        res.set("Retry-After", retryAfter.toString());
        throw new HttpError(
          429,
          `IP already claimed in last 24h. Retry in ${Math.ceil(retryAfter / 3600)}h.`,
          "ip_rate_limited"
        );
      }

      // ── Pre-flight: relayer must have enough ETH for the two tx + gas ──
      // mUSDC has no pre-funding requirement: `mockUsdc.mint(to, amount)`
      // is permissionless on the deployed mock (Phase 5 mUSDC at
      // `MOCK_USDC_ADDRESS`).
      const relayerEth = await provider.getBalance(relayer.address);
      if (relayerEth < ETH_PER_CLAIM_WEI + ETH_GAS_BUFFER_WEI) {
        throw new HttpError(
          503,
          "Faucet temporarily out of ETH. Contact team.",
          "out_of_eth"
        );
      }

      // ── Send the two on-chain ops SEQUENTIALLY ──
      // mUSDC mint first: more critical for the user (without mUSDC they
      // can't buy policies). If mint fails, ETH never goes out and they
      // retry without burning their 24h cooldown. ETH second: confirms the
      // claim — and even if it reverts after the mint succeeded, the user
      // is not blocked (Sepolia ETH is abundant from public faucets).
      logger.info({ wallet: walletLower, ip }, "[faucet] dispatching mint + eth");

      const mockUsdc = getMockUsdcContract(relayer);
      const usdcTx = await mockUsdc.mint(wallet, USDC_PER_CLAIM);
      await usdcTx.wait(1);

      const ethTx = await relayer.sendTransaction({
        to: wallet,
        value: ETH_PER_CLAIM_WEI,
      });
      await ethTx.wait(1);

      insertClaim({
        wallet: walletLower,
        ip,
        ethTxHash: ethTx.hash,
        usdcTxHash: usdcTx.hash,
      });

      logger.info(
        { wallet: walletLower, ip, ethTxHash: ethTx.hash, usdcTxHash: usdcTx.hash },
        "[faucet] claim successful"
      );

      // 10000 * 1e6 / 1e6 = "10000" — formatted in whole USDC for the response.
      const usdcAmountWhole = (USDC_PER_CLAIM / 1_000_000n).toString();

      res.json({
        success: true,
        ethTxHash: ethTx.hash,
        usdcTxHash: usdcTx.hash,
        ethAmount: "0.05",
        usdcAmount: usdcAmountWhole,
        mockUsdcAddress: cfg.MOCK_USDC_ADDRESS,
        nextEligibleAt: new Date((now + RATE_LIMIT_WINDOW_S) * 1000).toISOString(),
      });
    });
  } catch (err) {
    next(err);
  }
});

faucetRouter.get("/faucet/status", publicIpLimiter, async (_req, res, next) => {
  try {
    const relayerEth = await provider.getBalance(relayer.address);

    const claimsToday = countClaimsLast24h();
    const enabled =
      relayerEth >= ETH_PER_CLAIM_WEI + ETH_GAS_BUFFER_WEI &&
      claimsToday < DAILY_CAP;

    res.json({
      relayerEthBalance: ethers.formatEther(relayerEth),
      // mUSDC is permissionless mintable, so the relayer's balance is not
      // a constraint. Included as `null` for clarity and to flag the
      // architectural change from the original Sprint L semantics.
      relayerUsdcBalance: null,
      mockUsdcAddress: cfg.MOCK_USDC_ADDRESS,
      usdcPerClaim: (USDC_PER_CLAIM / 1_000_000n).toString(),
      ethPerClaim: "0.05",
      cooldownHours: 24,
      claimsLast24h: claimsToday,
      dailyCap: DAILY_CAP,
      enabled,
    });
  } catch (err) {
    next(err);
  }
});
