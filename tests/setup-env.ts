// Test-only env. Real values are mocked via jest.mock().
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
// Tests don't actually listen — supertest hits app directly. Use a real
// non-zero value so zod's `.positive()` validation passes.
process.env.PORT = "3001";

process.env.RPC_URL = "https://example.invalid/rpc";
process.env.CHAIN_ID = "84532";
process.env.RELAYER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
process.env.ADMIN_TOKEN = "x".repeat(40);

process.env.LUMINA_TOKEN = "0x17db45491561F7538e4E14449DCC34799758465D";
process.env.CLAIM_BOND = "0x5304f6732a51995651f1B666525CFeC5Af74A541";
process.env.BOND_VAULT = "0x1747CDA7F84BEc4f2002ff0dcdb3c51c1C02cf6A";
process.env.POLICY_MANAGER = "0x04f94Bc24aAA87aDFA643EE1e55a35C683f30804";
process.env.COVER_ROUTER = "0x60447F880Fad94fe1E17DBe9A0Cb39923bC9f316";
process.env.MARKETPLACE = "0x863A7fB4A676106db4b03449b01AC5615c6C9D51";
process.env.USDC = "0x63D340AE7229BB464bC801f225651341ebcD3693";

// Oracle V2 signer config (added by oracle-signer-service sprint).
// Tests don't actually call the oracle — these placeholder values just
// satisfy the zod env schema in `src/utils/config.ts:25-30`.
process.env.LUMINA_ORACLE_V2 = "0x8cAbC4645a3981FF59d39328f9F65FdFD19Bd194";
process.env.ORACLE_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000002";
process.env.BTC_PRICE_FEED = "0x2aDC8718F0b7Efb18a07aBc7595F1364730bb99E";
process.env.ETH_PRICE_FEED = "0x2a370A7dAE38aF7EECA20C9438Bd5154889cdc5e";

// Use in-memory SQLite for unit tests so they don't pollute disk.
process.env.DB_PATH = ":memory:";

// [Audit #36 fixes] Crank the IP-keyed limits high enough that no single
// test file accumulates enough requests to trip them under the default IP
// (supertest sends 127.0.0.1 unless X-Forwarded-For is set, and the
// MemoryStore is shared per-process). Tests in tests/security/rate-limit-fixes
// override these with `RATE_LIMIT_PUBLIC_IP_RPM=120` / `..._AUTH_IP_RPM=60`
// via X-Forwarded-For-isolated IPs and lower per-test caps.
process.env.RATE_LIMIT_PUBLIC_IP_RPM = "5000";
process.env.RATE_LIMIT_AUTH_IP_RPM = "5000";
