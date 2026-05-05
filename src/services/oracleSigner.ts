import { Wallet, type TypedDataDomain, type TypedDataField } from "ethers";
import { loadConfig } from "../utils/config";

export interface PriceProof {
  price: bigint;
  asset: string;
  verifiedAt: number;
}

export interface SignedPriceProof extends PriceProof {
  signature: string;
}

const cfg = loadConfig();

const DOMAIN: TypedDataDomain = {
  name: "LuminaOracle",
  version: "2",
  chainId: cfg.CHAIN_ID,
  verifyingContract: cfg.LUMINA_ORACLE_V2,
};

const TYPES: Record<string, TypedDataField[]> = {
  PriceProof: [
    { name: "price", type: "int256" },
    { name: "asset", type: "bytes32" },
    { name: "verifiedAt", type: "uint256" },
  ],
};

const wallet = new Wallet(cfg.ORACLE_PRIVATE_KEY);

export async function signPriceProof(proof: PriceProof): Promise<SignedPriceProof> {
  const signature = await wallet.signTypedData(DOMAIN, TYPES, {
    price: proof.price,
    asset: proof.asset,
    verifiedAt: proof.verifiedAt,
  });
  return { ...proof, signature };
}

export function getSignerAddress(): string {
  return wallet.address;
}

export function getDomain(): TypedDataDomain {
  return { ...DOMAIN };
}

export function getTypes(): Record<string, TypedDataField[]> {
  return JSON.parse(JSON.stringify(TYPES));
}
