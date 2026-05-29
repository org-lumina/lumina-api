import { ethers } from "ethers";

const TEST_PRIVKEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_ADDR = ethers.computeAddress(TEST_PRIVKEY);
const ORACLE_ADDR = "0x0000000000000000000000000000000000000000";

process.env.PORT = "3000";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.RPC_URL = "https://base-mainnet-rpc.publicnode.com";
process.env.CHAIN_ID = "8453";
process.env.RELAYER_PRIVATE_KEY = TEST_PRIVKEY;
process.env.ADMIN_TOKEN = "x".repeat(64);
process.env.LUMINA_TOKEN = "0x0000000000000000000000000000000000000001";
process.env.CLAIM_BOND = "0x0000000000000000000000000000000000000002";
process.env.BOND_VAULT = "0x0000000000000000000000000000000000000003";
process.env.POLICY_MANAGER = "0x0000000000000000000000000000000000000004";
process.env.COVER_ROUTER = "0x0000000000000000000000000000000000000005";
process.env.MARKETPLACE = "0x0000000000000000000000000000000000000006";
process.env.USDC = "0x0000000000000000000000000000000000000007";
process.env.LUMINA_ORACLE_V2 = ORACLE_ADDR;
process.env.ORACLE_PRIVATE_KEY = TEST_PRIVKEY;
process.env.BTC_PRICE_FEED = "0x000000000000000000000000000000000000B7C0";
process.env.ETH_PRICE_FEED = "0x000000000000000000000000000000000000E70F";

import { signPriceProof, getSignerAddress, getDomain, getTypes } from "../../src/services/oracleSigner";

describe("oracleSigner", () => {
  it("getSignerAddress returns the address derived from ORACLE_PRIVATE_KEY", () => {
    expect(getSignerAddress().toLowerCase()).toBe(TEST_ADDR.toLowerCase());
  });

  it("domain is pinned to LuminaOracle/2/8453/<oracle addr>", () => {
    const d = getDomain();
    expect(d.name).toBe("LuminaOracle");
    expect(d.version).toBe("2");
    expect(d.chainId).toBe(8453);
    expect(d.verifyingContract).toBe(ORACLE_ADDR);
  });

  it("signs a PriceProof and the recovered signer matches getSignerAddress", async () => {
    const proof = {
      price: 65000_00000000n, // 65k USD * 1e8
      asset: ethers.encodeBytes32String("BTC"),
      verifiedAt: 1730000000,
    };
    const signed = await signPriceProof(proof);
    const recovered = ethers.verifyTypedData(
      getDomain(),
      getTypes(),
      proof,
      signed.signature,
    );
    expect(recovered.toLowerCase()).toBe(getSignerAddress().toLowerCase());
  });

  it("signature changes when verifiedAt changes (no determinism leak)", async () => {
    const base = {
      price: 1000n,
      asset: ethers.encodeBytes32String("ETH"),
      verifiedAt: 1730000000,
    };
    const a = await signPriceProof(base);
    const b = await signPriceProof({ ...base, verifiedAt: base.verifiedAt + 1 });
    expect(a.signature).not.toBe(b.signature);
  });
});
