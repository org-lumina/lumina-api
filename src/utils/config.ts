import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  RPC_URL: z.string().url(),
  // [Sprint F] Optional fallback RPCs. When set, ethers wraps the primary +
  // these into a FallbackProvider so a single provider outage doesn't take
  // the API down. Public Base mainnet (https://mainnet.base.org) is added
  // automatically as last-resort if RPC_URL_PUBLIC is unset.
  RPC_URL_QUICKNODE: z.string().url().optional(),
  RPC_URL_PUBLIC: z.string().url().optional(),
  // [Mainnet 2026-05-28] Default flipped from Base Sepolia (84532) to Base
  // mainnet (8453). Override only for the testnet sandbox stack.
  CHAIN_ID: z.coerce.number().int().positive().default(8453),

  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "RELAYER_PRIVATE_KEY must be 0x-prefixed 32-byte hex"),

  ADMIN_TOKEN: z.string().min(32, "ADMIN_TOKEN must be at least 32 chars"),

  LUMINA_TOKEN: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  CLAIM_BOND: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  BOND_VAULT: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  POLICY_MANAGER: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  COVER_ROUTER: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  MARKETPLACE: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  USDC: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  // [Sprint USDC Mock — Phase 5] Free-mintable mock USDC used by the faucet.
  // The protocol's canonical premium token (`USDC`) on mainnet is Circle's
  // non-mintable `0x833589f…`. The faucet uses a separate permissionless
  // USDC on the Base mainnet sandbox to fund agents + founder for
  // testnet exploration. The default below is the Sepolia USDC — set to a
  // zero address on mainnet builds where the faucet is disabled, or override
  // for an alternate sandbox.
  MOCK_USDC_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  // Amount minted per faucet claim, in 6-dec USDC base units.
  // Default: 10,000 USDC (`10_000 * 1e6`).
  FAUCET_USDC_AMOUNT: z
    .string()
    .regex(/^\d+$/)
    .default("10000000000"),
  LUMINA_ORACLE_V2: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  ORACLE_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "ORACLE_PRIVATE_KEY must be 0x-prefixed 32-byte hex"),
  BTC_PRICE_FEED: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  ETH_PRICE_FEED: z.string().regex(/^0x[0-9a-fA-F]{40}$/),


  DB_PATH: z.string().default("./lumina.db"),

  RATE_LIMIT_FREE_RPM: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_PAID_RPM: z.coerce.number().int().positive().default(100),
  // [Audit #36 fixes] IP-keyed limits for the public surface and the auth
  // entry point. Configurable so test runs can crank them up to keep test
  // isolation between cases.
  RATE_LIMIT_PUBLIC_IP_RPM: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_IP_RPM: z.coerce.number().int().positive().default(60),

  // Sandbox / "Try It" widget. Optional — when SANDBOX_WALLET is unset
  // the sandbox endpoints respond 503 sandbox_disabled. Funded externally
  // (cron tops it up with USDC); the API merely consumes from it. The
  // wallet address is the buyer-of-record on every sandbox purchase.
  SANDBOX_WALLET: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  // Per-purchase cap for the sandbox, in USDC base units (6-dec). Default
  // $100 = the on-chain minimum enforced by CoverRouterV2 (`coverageAmount
  // < 100e6` reverts InvalidCoverage / 0x2340cc3a). Lower values would make
  // /sandbox/try fail every time.
  SANDBOX_COVER_USDC: z
    .string()
    .regex(/^\d+$/)
    .default("100000000"),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

// For tests
export function resetConfig(): void {
  cached = undefined;
}
