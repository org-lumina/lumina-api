import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive().default(84532),

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
  // (cron tops it up with mUSDC); the API merely consumes from it. The
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
