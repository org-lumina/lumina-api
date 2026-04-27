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

// Use in-memory SQLite for unit tests so they don't pollute disk.
process.env.DB_PATH = ":memory:";
