/**
 * Hand-written OpenAPI 3.0.3 spec for the Lumina Protocol API.
 *
 * This is the single source of truth that `GET /openapi.json` returns and
 * that Swagger UI renders at `/api-docs`. We hand-write rather than codegen
 * from zod because several route schemas use custom refinements (e.g.
 * `ethers.isAddress`) that don't translate cleanly to JSON Schema.
 *
 * When you add or change a route, update this file in lockstep.
 */

// `as const` would lock literal types and prevent us from typing this as a
// generic OpenAPI document; instead we keep it loosely typed and rely on the
// `swagger-ui-express` types accepting an `unknown`-shaped object.
type OpenAPIDocument = {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<Record<string, unknown>>;
  components: Record<string, unknown>;
  paths: Record<string, unknown>;
  tags?: Array<Record<string, unknown>>;
};

const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
});

const COMMON_ERROR_RESPONSES = {
  "400": errorResponse("Validation error or malformed request"),
  "429": errorResponse("Rate limit exceeded"),
  "500": errorResponse("Internal server error"),
};

const AUTH_ERROR_RESPONSES = {
  "401": errorResponse("Missing, malformed, or revoked API key"),
  "403": errorResponse("Authenticated but not allowed to access this resource"),
};

export const openapiDocument: OpenAPIDocument = {
  openapi: "3.0.3",
  info: {
    title: "Lumina Protocol API",
    version: "0.1.0",
    description:
      "Programmatic access to Lumina (Base Sepolia 84532). Discover canonical contract addresses via GET /health.\n\n" +
      "## Premium vs covered asset\n\n" +
      "Premium is **ALWAYS paid in USDC** across all products. The `asset` field on a product (`coveredAsset`) or on `POST /api/v1/policies` refers to the *covered asset* — what the policy insures against — **not** the payment token. Discover the covered asset via `GET /products` (`coveredAsset` field).\n\n" +
      "## Authentication\n\n" +
      "- Public endpoints (`/health`, `/products`, `/policies/...`) require no auth.\n" +
      "- Authenticated endpoints under `/api/v1/*` (except `/api/v1/agent/onboard`) require an `x-api-key` header. Obtain one via `POST /api/v1/agent/onboard` (signed by your wallet) or have an admin call `POST /api/v1/keys/generate`.\n" +
      "- Admin endpoints under `/api/v1/keys` require an `x-admin-token` header.\n\n" +
      "## Idempotency\n\n" +
      "`POST /api/v1/policies` honours an optional `Idempotency-Key` header. A repeated call with the same key (per agent) returns the cached response.\n\n" +
      "## Numeric encoding\n\n" +
      "All on-chain integer values (USDC base units, LUMINA wei, prices, etc.) are returned as decimal strings to avoid JavaScript Number precision loss.",
    contact: { url: "https://www.lumina-org.com" },
    license: { name: "Proprietary" },
  },
  servers: [
    {
      url: "https://lumina-api-production-ac85.up.railway.app",
      description: "Production (Base Sepolia testnet)",
    },
    {
      url: "http://localhost:8080",
      description: "Local dev",
    },
  ],
  tags: [
    { name: "discovery", description: "Service health & configuration discovery" },
    {
      name: "products",
      description:
        "Insurance product catalogue and quotes. Premium is ALWAYS paid in USDC across all products. The `asset` field on a product or purchase request refers to the covered asset — what the policy insures against — not the payment token.",
    },
    { name: "policies", description: "Buy and read insurance policies" },
    { name: "redeem", description: "Verify and record bond redemptions" },
    { name: "bonds", description: "List bonds (ERC-1155 epochs) for a wallet" },
    { name: "marketplace", description: "Secondary marketplace: list / buy / browse bonds" },
    { name: "oracle", description: "Off-chain price oracle signer" },
    { name: "keys", description: "Admin: API key issuance & revocation" },
    { name: "agent", description: "Self-service supervisor surface for agents/wallets" },
    { name: "webhooks", description: "Subscribe to event push (HMAC-signed POST callbacks)" },
    { name: "sandbox", description: "Public 'Try It' surface — pre-funded wallet, $1 cap" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Issued via POST /api/v1/agent/onboard or POST /api/v1/keys/generate. Format: lk_<64-hex>.",
      },
      AdminTokenAuth: {
        type: "apiKey",
        in: "header",
        name: "x-admin-token",
        description: "Pre-shared admin token from environment.",
      },
    },
    parameters: {
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description:
          "Optional per-agent idempotency key. Repeating a request with the same key returns the cached response.",
        schema: { type: "string", maxLength: 128 },
      },
    },
    schemas: {
      Bytes32: {
        type: "string",
        pattern: "^0x[0-9a-fA-F]{64}$",
        description: "32-byte 0x-prefixed hex string (e.g. a productId or txHash).",
        example: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
      Address: {
        type: "string",
        pattern: "^0x[a-fA-F0-9]{40}$",
        description: "Ethereum 0x-prefixed checksummed or lowercase address.",
        example: "0x0000000000000000000000000000000000000000",
      },
      DecimalString: {
        type: "string",
        pattern: "^\\d+$",
        description:
          "A non-negative integer encoded as a decimal string (used for token amounts, prices, and other on-chain bigint values).",
        example: "1000000",
      },
      Signature: {
        type: "string",
        pattern: "^0x[0-9a-fA-F]{130}$",
        description: "EIP-191 personal_sign signature (65 bytes / 130 hex chars + 0x).",
      },
      ISO8601: {
        type: "string",
        format: "date-time",
        description: "ISO-8601 UTC timestamp.",
        example: "2026-05-05T12:34:56.000Z",
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "string",
            description: "Machine-readable error code (e.g. validation_error, unauthenticated).",
            example: "validation_error",
          },
          message: {
            type: "string",
            description: "Human-readable explanation.",
          },
          details: {
            type: "array",
            description: "Per-field validation issues (zod path + message). Only present for validation_error.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                message: { type: "string" },
              },
            },
            nullable: true,
          },
        },
      },
      Health: {
        type: "object",
        required: ["status", "service", "chain", "relayer", "contracts"],
        properties: {
          status: { type: "string", example: "ok" },
          service: { type: "string", example: "lumina-api" },
          version: { type: "string", example: "0.1.0" },
          uptimeSeconds: { type: "integer", example: 12345 },
          chain: {
            type: "object",
            properties: {
              chainId: { type: "integer", example: 84532 },
              block: { type: "integer", example: 12345678 },
              rpcConnected: { type: "boolean" },
            },
          },
          relayer: {
            type: "object",
            properties: {
              address: { $ref: "#/components/schemas/Address" },
              balanceWei: { $ref: "#/components/schemas/DecimalString" },
            },
          },
          contracts: {
            type: "object",
            description: "Canonical contract addresses on the configured chain.",
            properties: {
              coverRouter: { $ref: "#/components/schemas/Address" },
              policyManager: { $ref: "#/components/schemas/Address" },
              bondVault: { $ref: "#/components/schemas/Address" },
              claimBond: { $ref: "#/components/schemas/Address" },
              marketplace: { $ref: "#/components/schemas/Address" },
              usdc: { $ref: "#/components/schemas/Address" },
              luminaToken: { $ref: "#/components/schemas/Address" },
            },
          },
        },
      },
      Product: {
        type: "object",
        required: [
          "productId",
          "name",
          "displayName",
          "shield",
          "coveredAsset",
          "paymentAsset",
          "coverageDescription",
          "payoutRatioBps",
          "triggerProbBps",
          "marginBps",
          "durationSeconds",
          "active",
        ],
        properties: {
          productId: { $ref: "#/components/schemas/Bytes32" },
          name: {
            type: "string",
            nullable: true,
            description:
              "Canonical keccak256 preimage of productId (e.g. 'FLASHBTC1H-001'). Null for products whose preimage is not registered server-side.",
            example: "FLASHBTC1H-001",
          },
          displayName: {
            type: "string",
            description: "Human-friendly label (e.g. 'Flash BTC 1h').",
            example: "Flash BTC 1h",
          },
          shield: { $ref: "#/components/schemas/Address" },
          coveredAsset: {
            type: "string",
            enum: ["USDC", "USDT", "BTC", "ETH"],
            description:
              "The asset whose event is being insured against. NOT the premium payment token.",
            example: "BTC",
          },
          paymentAsset: {
            type: "string",
            enum: ["USDC"],
            description: "Always 'USDC'. The token used to pay the premium.",
            example: "USDC",
          },
          coverageDescription: {
            type: "string",
            description:
              "One-line plain-English description of what this product insures against.",
            example: "Insures BTC against rapid price crashes within 1 hour",
          },
          payoutRatioBps: { type: "integer", description: "Payout / coverage ratio in basis points." },
          triggerProbBps: { type: "integer", description: "Trigger probability in basis points." },
          marginBps: { type: "integer", description: "Premium margin in basis points." },
          durationSeconds: { type: "integer", description: "Policy duration in seconds." },
          active: { type: "boolean" },
        },
      },
      ProductList: {
        type: "object",
        required: ["count", "products"],
        properties: {
          count: { type: "integer" },
          products: { type: "array", items: { $ref: "#/components/schemas/Product" } },
        },
      },
      Quote: {
        type: "object",
        required: ["productId", "coverageAmount", "premium", "payout"],
        properties: {
          productId: { $ref: "#/components/schemas/Bytes32" },
          coverageAmount: { $ref: "#/components/schemas/DecimalString" },
          premium: { $ref: "#/components/schemas/DecimalString" },
          payout: { $ref: "#/components/schemas/DecimalString" },
        },
      },
      Policy: {
        type: "object",
        required: [
          "productId",
          "policyId",
          "shield",
          "buyer",
          "holder",
          "coverageAmount",
          "payoutAmount",
          "premiumPaid",
          "createdAt",
          "expiresAt",
          "status",
          "triggered",
          "expired",
        ],
        properties: {
          productId: { $ref: "#/components/schemas/Bytes32" },
          productName: { type: "string", description: "Human-readable name derived from PRODUCT_ID preimage." },
          policyId: { $ref: "#/components/schemas/DecimalString" },
          shield: { $ref: "#/components/schemas/Address" },
          buyer: { $ref: "#/components/schemas/Address" },
          holder: { $ref: "#/components/schemas/Address" },
          coverageAmount: { $ref: "#/components/schemas/DecimalString" },
          payoutAmount: { $ref: "#/components/schemas/DecimalString" },
          premiumPaid: { $ref: "#/components/schemas/DecimalString", description: "USDC base units (6-dec)." },
          purchasedAt: { $ref: "#/components/schemas/DecimalString", description: "Unix seconds." },
          createdAt: { $ref: "#/components/schemas/DecimalString", description: "Unix seconds." },
          waitingEndsAt: {
            type: "string",
            nullable: true,
            description: "Unix-seconds string when the waiting period ends, or null.",
          },
          expiresAt: { $ref: "#/components/schemas/DecimalString", description: "Unix seconds." },
          status: { type: "string", enum: ["Waiting", "Active", "Triggered", "Expired", "Cancelled"] },
          triggered: { type: "boolean" },
          expired: { type: "boolean" },
          productActive: { type: "boolean" },
          priceSnapshot: {
            $ref: "#/components/schemas/DecimalString",
            description: "LUMINA/USD 18-dec snapshot at purchase. '0' for legacy V5.0 policies.",
          },
          triggeredAt: {
            type: "string",
            nullable: true,
            description: "Unix-seconds when triggered, or null.",
          },
          bondId: {
            type: "string",
            nullable: true,
            description: "BondVault epochId minted at trigger, or null.",
          },
        },
      },
      PurchasePolicyRequest: {
        type: "object",
        required: ["productId", "coverageAmount", "asset", "buyer"],
        properties: {
          productId: { $ref: "#/components/schemas/Bytes32" },
          coverageAmount: {
            allOf: [{ $ref: "#/components/schemas/DecimalString" }],
            description: "USDC base units (6 decimals). Minimum: 100000000 (= $100), enforced on-chain by CoverRouterV2.",
          },
          asset: {
            allOf: [{ $ref: "#/components/schemas/Bytes32" }],
            description:
              "Must match the product's coveredAsset (NOT the premium token, which is always USDC). See GET /products. Encoded as bytes32(stringRightPadded), e.g. keccak-pad of 'BTC'/'ETH'/'USDT'/'USDC'.",
          },
          buyer: { $ref: "#/components/schemas/Address" },
        },
      },
      PurchaseReceipt: {
        type: "object",
        required: ["ok", "txHash", "policyId", "buyer", "productId", "coverageAmount", "premiumPaid"],
        properties: {
          ok: { type: "boolean", example: true },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          blockNumber: { type: "integer", nullable: true },
          policyId: { $ref: "#/components/schemas/DecimalString" },
          buyer: { $ref: "#/components/schemas/Address" },
          productId: { $ref: "#/components/schemas/Bytes32" },
          coverageAmount: { $ref: "#/components/schemas/DecimalString" },
          premiumPaid: { $ref: "#/components/schemas/DecimalString" },
        },
      },
      PolicyListItem: {
        type: "object",
        description: "Local DB row for a policy minted via this API.",
        properties: {
          product_id: { $ref: "#/components/schemas/Bytes32" },
          policy_id: { type: "integer" },
          buyer: { $ref: "#/components/schemas/Address" },
          coverage_amount: { $ref: "#/components/schemas/DecimalString" },
          premium_paid: { $ref: "#/components/schemas/DecimalString" },
          tx_hash: { $ref: "#/components/schemas/Bytes32" },
          submitted_by: { type: "integer", description: "Internal agent id." },
          created_at: { type: "integer", description: "Unix milliseconds." },
        },
      },
      PolicyListResponse: {
        type: "object",
        required: ["owner", "count", "policies"],
        properties: {
          owner: { $ref: "#/components/schemas/Address" },
          count: { type: "integer" },
          policies: { type: "array", items: { $ref: "#/components/schemas/PolicyListItem" } },
        },
      },
      RedeemRequest: {
        type: "object",
        required: ["usdAmount", "txHash", "ownerAddress"],
        description: "Either `epochId` or its alias `bondId` MUST be provided.",
        properties: {
          epochId: { $ref: "#/components/schemas/DecimalString" },
          bondId: { $ref: "#/components/schemas/DecimalString" },
          usdAmount: { $ref: "#/components/schemas/DecimalString" },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          ownerAddress: { $ref: "#/components/schemas/Address" },
        },
      },
      RedeemResponse: {
        type: "object",
        required: [
          "success",
          "txHash",
          "epochId",
          "ownerAddress",
          "luminaReceived",
          "priceUsed",
          "blockNumber",
        ],
        properties: {
          success: { type: "boolean" },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          epochId: { $ref: "#/components/schemas/DecimalString" },
          ownerAddress: { $ref: "#/components/schemas/Address" },
          luminaReceived: { $ref: "#/components/schemas/DecimalString" },
          priceUsed: { $ref: "#/components/schemas/DecimalString" },
          blockNumber: { type: "integer" },
        },
      },
      Bond: {
        type: "object",
        required: [
          "bondId",
          "epochId",
          "balance",
          "faceValue",
          "createdAt",
          "maturityDate",
          "isMatured",
          "isRedeemed",
          "luminaEquivalent",
        ],
        properties: {
          bondId: { $ref: "#/components/schemas/DecimalString" },
          epochId: { $ref: "#/components/schemas/DecimalString" },
          balance: { $ref: "#/components/schemas/DecimalString", description: "Integer USD ($1 = 1 token)." },
          faceValue: { $ref: "#/components/schemas/DecimalString", description: "18-dec USD-wei." },
          createdAt: { $ref: "#/components/schemas/ISO8601" },
          maturityDate: { $ref: "#/components/schemas/ISO8601" },
          isMatured: { type: "boolean" },
          isRedeemed: { type: "boolean" },
          luminaEquivalent: {
            $ref: "#/components/schemas/DecimalString",
            description: "18-dec LUMINA wei at current price.",
          },
        },
      },
      BondsListResponse: {
        type: "object",
        required: ["wallet", "totalBonds", "bonds", "pagination"],
        properties: {
          wallet: { $ref: "#/components/schemas/Address" },
          totalBonds: { type: "integer" },
          bonds: { type: "array", items: { $ref: "#/components/schemas/Bond" } },
          pagination: {
            type: "object",
            properties: {
              limit: { type: "integer" },
              offset: { type: "integer" },
              hasMore: { type: "boolean" },
            },
          },
        },
      },
      ListListingRequest: {
        type: "object",
        required: ["txHash", "sellerAddress", "bondId", "amount", "totalPriceUsdc"],
        properties: {
          txHash: { $ref: "#/components/schemas/Bytes32" },
          sellerAddress: { $ref: "#/components/schemas/Address" },
          bondId: { $ref: "#/components/schemas/DecimalString" },
          amount: { $ref: "#/components/schemas/DecimalString" },
          totalPriceUsdc: { $ref: "#/components/schemas/DecimalString" },
        },
      },
      ListListingResponse: {
        type: "object",
        required: ["success", "txHash", "listingId", "blockNumber", "createdAt"],
        properties: {
          success: { type: "boolean" },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          listingId: { $ref: "#/components/schemas/DecimalString" },
          blockNumber: { type: "integer" },
          createdAt: { $ref: "#/components/schemas/ISO8601" },
        },
      },
      BuyListingRequest: {
        type: "object",
        required: ["txHash", "listingId", "buyerAddress", "amount", "totalPaidUsdc"],
        properties: {
          txHash: { $ref: "#/components/schemas/Bytes32" },
          listingId: { $ref: "#/components/schemas/DecimalString" },
          buyerAddress: { $ref: "#/components/schemas/Address" },
          amount: { $ref: "#/components/schemas/DecimalString" },
          totalPaidUsdc: { $ref: "#/components/schemas/DecimalString" },
        },
      },
      BuyListingResponse: {
        type: "object",
        required: [
          "success",
          "txHash",
          "listingId",
          "buyerAddress",
          "sellerAddress",
          "bondId",
          "amount",
          "totalPaidUsdc",
          "blockNumber",
          "executedAt",
        ],
        properties: {
          success: { type: "boolean" },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          listingId: { $ref: "#/components/schemas/DecimalString" },
          buyerAddress: { $ref: "#/components/schemas/Address" },
          sellerAddress: { $ref: "#/components/schemas/Address" },
          bondId: { $ref: "#/components/schemas/DecimalString" },
          amount: { $ref: "#/components/schemas/DecimalString" },
          totalPaidUsdc: { $ref: "#/components/schemas/DecimalString" },
          blockNumber: { type: "integer" },
          executedAt: { $ref: "#/components/schemas/ISO8601" },
        },
      },
      Listing: {
        type: "object",
        required: [
          "listingId",
          "seller",
          "bondId",
          "amount",
          "totalPriceUsdc",
          "txHash",
          "blockNumber",
          "createdAt",
          "status",
        ],
        properties: {
          listingId: { $ref: "#/components/schemas/DecimalString" },
          seller: { $ref: "#/components/schemas/Address" },
          bondId: { $ref: "#/components/schemas/DecimalString" },
          amount: { $ref: "#/components/schemas/DecimalString" },
          totalPriceUsdc: { $ref: "#/components/schemas/DecimalString" },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          blockNumber: { type: "integer" },
          createdAt: { $ref: "#/components/schemas/ISO8601" },
          listedAt: { $ref: "#/components/schemas/ISO8601" },
          status: { type: "string", enum: ["active", "sold", "cancelled"] },
        },
      },
      ListingsBrowseResponse: {
        type: "object",
        required: ["count", "total", "listings"],
        properties: {
          count: { type: "integer", description: "Number of listings in this page." },
          total: { type: "integer", description: "Total number of matching listings." },
          listings: { type: "array", items: { $ref: "#/components/schemas/Listing" } },
        },
      },
      MarketplaceStats: {
        type: "object",
        required: ["floor", "volume24h", "totalListings", "totalVolume"],
        description:
          "Macro stats over the local marketplace store. Cached 30s. Decimal-string amounts are USDC base units (6-dec).",
        properties: {
          floor: {
            $ref: "#/components/schemas/DecimalString",
            description: "Minimum totalPriceUsdc among active listings. \"0\" when the book is empty.",
          },
          volume24h: {
            $ref: "#/components/schemas/DecimalString",
            description: "Sum of totalPaidUsdc for purchases executed in the last 24h.",
          },
          totalListings: {
            type: "integer",
            description: "Number of currently-active listings.",
          },
          totalVolume: {
            $ref: "#/components/schemas/DecimalString",
            description: "Sum of totalPaidUsdc across the full purchase history.",
          },
        },
      },
      Trade: {
        type: "object",
        required: [
          "listingId",
          "buyer",
          "seller",
          "bondId",
          "amount",
          "totalPaidUsdc",
          "txHash",
          "blockNumber",
          "executedAt",
        ],
        properties: {
          listingId: { $ref: "#/components/schemas/DecimalString" },
          buyer: { $ref: "#/components/schemas/Address" },
          seller: { $ref: "#/components/schemas/Address" },
          bondId: { $ref: "#/components/schemas/DecimalString" },
          amount: { $ref: "#/components/schemas/DecimalString" },
          totalPaidUsdc: {
            $ref: "#/components/schemas/DecimalString",
            description: "USDC base units (6-dec). Includes buyer fee.",
          },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          blockNumber: { type: "integer" },
          executedAt: { $ref: "#/components/schemas/ISO8601" },
        },
      },
      MarketplaceHistoryResponse: {
        type: "object",
        required: ["count", "limit", "offset", "trades"],
        properties: {
          count: { type: "integer" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          trades: { type: "array", items: { $ref: "#/components/schemas/Trade" } },
        },
      },
      ListingDetail: {
        type: "object",
        required: [
          "listingId",
          "seller",
          "bondId",
          "amount",
          "totalPriceUsdc",
          "txHash",
          "blockNumber",
          "status",
          "createdAt",
        ],
        properties: {
          listingId: { $ref: "#/components/schemas/DecimalString" },
          seller: { $ref: "#/components/schemas/Address" },
          bondId: { $ref: "#/components/schemas/DecimalString" },
          amount: { $ref: "#/components/schemas/DecimalString" },
          totalPriceUsdc: { $ref: "#/components/schemas/DecimalString" },
          txHash: { $ref: "#/components/schemas/Bytes32" },
          blockNumber: { type: "integer" },
          status: { type: "string", enum: ["active", "executed", "cancelled"] },
          createdAt: { $ref: "#/components/schemas/ISO8601" },
        },
      },
      OracleSignProofRequest: {
        type: "object",
        required: ["asset"],
        properties: {
          asset: { type: "string", enum: ["BTC", "ETH"] },
        },
      },
      OracleSignProofResponse: {
        type: "object",
        required: [
          "asset",
          "assetBytes32",
          "price",
          "decimals",
          "verifiedAt",
          "feedUpdatedAt",
          "signer",
          "signature",
        ],
        properties: {
          asset: { type: "string", enum: ["BTC", "ETH"] },
          assetBytes32: { $ref: "#/components/schemas/Bytes32" },
          price: { $ref: "#/components/schemas/DecimalString" },
          decimals: { type: "integer" },
          verifiedAt: { type: "integer", description: "Unix seconds." },
          feedUpdatedAt: { type: "integer", description: "Unix seconds (Chainlink feed last update)." },
          signer: { $ref: "#/components/schemas/Address" },
          signature: { $ref: "#/components/schemas/Signature" },
        },
      },
      OracleSignerResponse: {
        type: "object",
        required: ["signer"],
        properties: {
          signer: { $ref: "#/components/schemas/Address" },
        },
      },
      KeyGenerateRequest: {
        type: "object",
        required: ["wallet"],
        properties: {
          wallet: { $ref: "#/components/schemas/Address" },
          label: { type: "string", maxLength: 64 },
        },
      },
      IssuedKey: {
        type: "object",
        required: ["ok", "keyId", "apiKey", "wallet", "tier", "createdAt"],
        properties: {
          ok: { type: "boolean", example: true },
          keyId: { type: "integer" },
          apiKey: {
            type: "string",
            description:
              "Plaintext API key. Returned ONCE — only the SHA-256 hash is stored server-side. Caller MUST persist it.",
            example: "lk_0123456789abcdef...",
          },
          wallet: { $ref: "#/components/schemas/Address" },
          tier: { type: "string", enum: ["free", "paid"] },
          label: { type: "string", nullable: true },
          createdAt: { type: "integer", description: "Unix milliseconds." },
          warning: { type: "string" },
        },
      },
      OnboardRequest: {
        type: "object",
        required: ["walletAddress", "signature", "timestamp"],
        description:
          "EIP-191 personal_sign of `\"Lumina onboarding for {walletAddress} at {timestamp}\"`. " +
          "Timestamp must be within ±300s of server time.",
        properties: {
          walletAddress: { $ref: "#/components/schemas/Address" },
          label: { type: "string", maxLength: 50 },
          signature: { $ref: "#/components/schemas/Signature" },
          timestamp: { type: "integer", description: "Unix seconds." },
        },
      },
      OnboardResponse: {
        allOf: [
          { $ref: "#/components/schemas/IssuedKey" },
          {
            type: "object",
            properties: {
              rateLimit: {
                type: "object",
                properties: {
                  free: { type: "object", properties: { rpm: { type: "integer" } } },
                  paid: { type: "object", properties: { rpm: { type: "integer" } } },
                },
              },
            },
          },
        ],
      },
      AgentKey: {
        type: "object",
        properties: {
          id: { type: "integer" },
          label: { type: "string", nullable: true },
          tier: { type: "string", enum: ["free", "paid"] },
          createdAt: { type: "integer", description: "Unix milliseconds." },
          revokedAt: { type: "integer", nullable: true },
        },
      },
      AgentKeysResponse: {
        type: "object",
        required: ["wallet", "keys"],
        properties: {
          wallet: { $ref: "#/components/schemas/Address" },
          keys: { type: "array", items: { $ref: "#/components/schemas/AgentKey" } },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["discovery"],
        summary: "Service health & contract addresses",
        description:
          "Returns service liveness, RPC chain status, the relayer address + balance, and the canonical contract addresses on the configured chain. Use this to discover where the protocol is deployed.",
        security: [],
        responses: {
          "200": {
            description: "Service is healthy.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Health" } },
            },
          },
          "429": errorResponse("Rate limit exceeded (public IP limiter)"),
          "500": errorResponse("RPC unavailable or internal error"),
        },
      },
    },
    "/products": {
      get: {
        tags: ["products"],
        summary: "List all insurance products",
        description: "Returns every product registered with CoverRouter, regardless of `active` flag.",
        security: [],
        responses: {
          "200": {
            description: "Product catalogue.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ProductList" } },
            },
          },
          "429": errorResponse("Rate limit exceeded (public IP limiter)"),
          "500": errorResponse("RPC error"),
        },
      },
    },
    "/products/{productId}": {
      get: {
        tags: ["products"],
        summary: "Get a single product",
        security: [],
        parameters: [
          {
            name: "productId",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/Bytes32" },
          },
        ],
        responses: {
          "200": {
            description: "Product configuration.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Product" } },
            },
          },
          "400": errorResponse("Invalid productId format"),
          "404": errorResponse("Product not found"),
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/products/{productId}/quote": {
      get: {
        tags: ["products"],
        summary: "Quote a premium for a coverage amount",
        description: "Returns the premium (USDC base units) and payout for the given coverageAmount.",
        security: [],
        parameters: [
          {
            name: "productId",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/Bytes32" },
          },
          {
            name: "coverageAmount",
            in: "query",
            required: true,
            description: "USDC base units (6 decimals).",
            schema: { $ref: "#/components/schemas/DecimalString" },
          },
        ],
        responses: {
          "200": {
            description: "Quote.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Quote" } },
            },
          },
          "400": errorResponse("Validation error"),
          "429": errorResponse("Rate limit exceeded"),
          "500": errorResponse("RPC error"),
        },
      },
    },
    "/policies/{productId}/{policyId}": {
      get: {
        tags: ["policies"],
        summary: "Read a policy by composite key",
        security: [],
        parameters: [
          {
            name: "productId",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/Bytes32" },
          },
          {
            name: "policyId",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/DecimalString" },
          },
        ],
        responses: {
          "200": {
            description: "Policy.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Policy" } },
            },
          },
          "400": errorResponse("Invalid path parameters"),
          "404": errorResponse("Policy not found"),
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/api/v1/policies": {
      post: {
        tags: ["policies"],
        summary: "Purchase a policy via the relayer",
        description:
          "Submits `purchasePolicyFor` from the API's relayer wallet on behalf of `buyer`. Pre-flights relayer authorization, the local pause flag, the global pause registry, and the product's `active` status before broadcasting. Honours `Idempotency-Key` for safe retries.",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PurchasePolicyRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Idempotent replay (same Idempotency-Key already processed).",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PurchaseReceipt" } },
            },
          },
          "201": {
            description: "Policy minted.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PurchaseReceipt" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
          "502": errorResponse("Transaction reverted on-chain"),
          "503": errorResponse("Relayer unauthorized, contract paused, or globally paused"),
        },
      },
      get: {
        tags: ["policies"],
        summary: "List policies owned by the calling agent's wallet",
        description:
          "Returns the local DB rows of policies minted via this API for the agent's wallet. Cross-owner reads are forbidden; an explicit `owner` query param must match the agent's wallet.",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "owner",
            in: "query",
            required: false,
            schema: { $ref: "#/components/schemas/Address" },
            description: "Optional. Must equal the calling key's wallet, otherwise 403.",
          },
        ],
        responses: {
          "200": {
            description: "Policies list.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PolicyListResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/redeem": {
      post: {
        tags: ["redeem"],
        summary: "Verify and record a BondVault.redeemBond transaction",
        description:
          "Verifier pattern: the user submits the redeem tx from their own wallet and the API verifies the receipt + `BondRedeemed` event. Either `epochId` or its alias `bondId` is required.",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RedeemRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Redemption verified and recorded.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RedeemResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
          "409": errorResponse("Redemption already registered for this txHash"),
          "502": errorResponse("RPC error or tx not found"),
        },
      },
    },
    "/api/v1/bonds/{wallet}": {
      get: {
        tags: ["bonds"],
        summary: "List bonds (ERC-1155 epochs) held by a wallet",
        description:
          "Enumerates EpochCreated events and computes balance/faceValue/luminaEquivalent per epoch. Cached for 60s per (wallet, includeRedeemed). Cross-wallet reads are allowed (data is publicly derivable).",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "wallet",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/Address" },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["active", "matured", "redeemed", "all"], default: "all" },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, default: 0 },
          },
        ],
        responses: {
          "200": {
            description: "Bonds list.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/BondsListResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
          "503": errorResponse("RPC failure listing bonds"),
        },
      },
    },
    "/api/v1/marketplace/list": {
      post: {
        tags: ["marketplace"],
        summary: "Verify and record a marketplace `list` transaction",
        description:
          "Verifier pattern: seller calls `LuminaBondMarketplace.list(...)` from their own wallet, then submits the txHash here. Validates the `Listed` event and the M-3 anti-spam price floor.",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ListListingRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Listing verified and recorded.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ListListingResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
          "409": errorResponse("Listing already registered for this txHash"),
          "502": errorResponse("RPC error"),
        },
      },
    },
    "/api/v1/marketplace/buy": {
      post: {
        tags: ["marketplace"],
        summary: "Verify and record a marketplace `executeBuy` transaction",
        description:
          "Verifier pattern: buyer calls `LuminaBondMarketplace.executeBuy(listingId)` from their own wallet, then submits the txHash here. Listing must be in `active` status locally and the `Bought` event fields must match the recorded listing.",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BuyListingRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Purchase verified and recorded.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/BuyListingResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
          "404": errorResponse("Listing not found"),
          "409": errorResponse("Duplicate purchase or listing not active"),
          "502": errorResponse("RPC error"),
        },
      },
    },
    "/api/v1/marketplace/listings": {
      get: {
        tags: ["marketplace"],
        summary: "Browse active marketplace listings",
        description:
          "Paginated, filterable view of currently-active listings. Useful for buyer UIs that need to discover bonds for sale.",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "minDiscountBps",
            in: "query",
            required: false,
            description: "Minimum discount vs face value in basis points (0–10000).",
            schema: { type: "integer", minimum: 0, maximum: 10000 },
          },
          {
            name: "maxPriceUsdc",
            in: "query",
            required: false,
            description: "Maximum total listing price (USDC base units, decimal string).",
            schema: { $ref: "#/components/schemas/DecimalString" },
          },
          {
            name: "sortBy",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["price-asc", "price-desc", "createdAt-desc", "listedAt-desc"],
              default: "createdAt-desc",
            },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, default: 0 },
          },
        ],
        responses: {
          "200": {
            description: "Listings page.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ListingsBrowseResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/marketplace/stats": {
      get: {
        tags: ["marketplace"],
        summary: "Marketplace macro stats",
        description:
          "Floor price, 24h volume, active-listing count and lifetime volume — aggregated over the local verifier-pattern store. Cached 30s server-side.",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Stats snapshot.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MarketplaceStats" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/marketplace/history": {
      get: {
        tags: ["marketplace"],
        summary: "Paginated marketplace trade history",
        description:
          "Returns completed trades (newest first) recorded by the verifier-pattern POST /buy. Cached 30s by `(limit, offset)`.",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, default: 0 },
          },
        ],
        responses: {
          "200": {
            description: "History page.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MarketplaceHistoryResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/marketplace/listings/{listingId}": {
      get: {
        tags: ["marketplace"],
        summary: "Fetch a single listing by id",
        description:
          "Direct fetch by on-chain listingId. Returns the full DB row (active or finalized).",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "listingId",
            in: "path",
            required: true,
            description: "On-chain listing id (positive integer string).",
            schema: { $ref: "#/components/schemas/DecimalString" },
          },
        ],
        responses: {
          "200": {
            description: "Listing detail.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ListingDetail" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
          "404": errorResponse("Listing not found"),
        },
      },
    },
    "/api/v1/oracle/sign-proof": {
      post: {
        tags: ["oracle"],
        summary: "Produce a signed price proof",
        description:
          "Reads the current Chainlink price for the requested asset, then signs an `(asset, price, verifiedAt)` payload with the API's oracle key. The signature can be submitted on-chain to LuminaOracleV2.",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OracleSignProofRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Signed proof.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/OracleSignProofResponse" } },
            },
          },
          ...COMMON_ERROR_RESPONSES,
          ...AUTH_ERROR_RESPONSES,
          "503": errorResponse("Chainlink feed unavailable"),
        },
      },
    },
    "/api/v1/oracle/signer": {
      get: {
        tags: ["oracle"],
        summary: "Return the oracle signer's address",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Signer address.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/OracleSignerResponse" } },
            },
          },
          ...AUTH_ERROR_RESPONSES,
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/api/v1/keys/generate": {
      post: {
        tags: ["keys"],
        summary: "Admin: issue a new API key",
        description:
          "Admin-only. Returns the plaintext key ONCE — only the SHA-256 hash is stored. The wallet's `MAX_KEYS_PER_WALLET=3` cap is enforced.",
        security: [{ AdminTokenAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/KeyGenerateRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Key issued.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/IssuedKey" } },
            },
          },
          "400": errorResponse("Validation error or wallet at MAX_KEYS_PER_WALLET"),
          "401": errorResponse("Missing or invalid x-admin-token"),
          "429": errorResponse("Rate limit exceeded (admin limiter)"),
        },
      },
    },
    "/api/v1/keys/{id}": {
      delete: {
        tags: ["keys"],
        summary: "Admin: revoke a key by id",
        security: [{ AdminTokenAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
          },
        ],
        responses: {
          "204": { description: "Key revoked." },
          "400": errorResponse("Invalid id"),
          "401": errorResponse("Missing or invalid x-admin-token"),
          "404": errorResponse("Key not found or already revoked"),
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/api/v1/auth/me": {
      get: {
        tags: ["agent"],
        summary: "Return the wallet associated with the calling API key",
        description:
          "Lightweight introspection used by the SDK to auto-discover the calling wallet so methods like `bonds.list()` and `policies.list()` can default to the right wallet without the caller threading it through every call. NEVER returns the secret — only the wallet, an 11-char prefix of the key for log/UI disambiguation, and the tier.",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Identity of the calling key.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["wallet", "apiKeyPrefix", "tier"],
                  properties: {
                    wallet: { $ref: "#/components/schemas/Address" },
                    apiKeyPrefix: { type: "string", example: "lk_a1b2c3d4" },
                    tier: { type: "string", enum: ["free", "paid"] },
                  },
                },
              },
            },
          },
          ...AUTH_ERROR_RESPONSES,
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/api/v1/agent/onboard": {
      post: {
        tags: ["agent"],
        summary: "Self-service onboarding (signed by wallet)",
        description:
          "Lets a wallet self-mint its first API key without admin involvement. The wallet proves ownership by signing `\"Lumina onboarding for {walletAddress} at {timestamp}\"` (EIP-191 personal_sign). Timestamp must be within ±5 minutes of server time. Capped at 10 attempts per IP per hour.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OnboardRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Key issued.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/OnboardResponse" } },
            },
          },
          "400": errorResponse("Validation error or stale timestamp"),
          "401": errorResponse("Signature could not be recovered or does not match walletAddress"),
          "429": errorResponse("Onboarding rate limit (10/hour/IP) exceeded"),
        },
      },
    },
    "/api/v1/agent/keys": {
      get: {
        tags: ["agent"],
        summary: "List the calling wallet's API keys",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Keys list (no plaintext — only metadata).",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AgentKeysResponse" } },
            },
          },
          ...AUTH_ERROR_RESPONSES,
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/api/v1/agent/keys/{keyId}": {
      delete: {
        tags: ["agent"],
        summary: "Revoke one of the calling wallet's keys",
        description: "Owner-only. Returns 204 on success, 200 with `{ alreadyRevoked: true }` if already revoked.",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "keyId",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
          },
        ],
        responses: {
          "200": {
            description: "Key was already revoked (idempotent).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    alreadyRevoked: { type: "boolean" },
                  },
                },
              },
            },
          },
          "204": { description: "Key revoked." },
          "400": errorResponse("Invalid keyId"),
          ...AUTH_ERROR_RESPONSES,
          "404": errorResponse("Key not found for this wallet"),
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/api/v1/webhooks": {
      post: {
        tags: ["webhooks"],
        summary: "Create a webhook subscription",
        description:
          "Register a URL to receive POST callbacks for the calling wallet's events. The response includes a 32-byte hex secret used by the sender for HMAC-SHA256 signing — STORE IT NOW, it is not returned again. Receivers verify with `X-Lumina-Signature` header (hex of HMAC-SHA256(body, secret)).",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string", format: "uri", example: "https://my-bot.example.com/webhooks/lumina" },
                  events: {
                    oneOf: [
                      { type: "string", enum: ["*"] },
                      {
                        type: "array",
                        items: {
                          type: "string",
                          enum: [
                            "policy_purchased",
                            "policy_triggered",
                            "bond_minted",
                            "bond_redeemed",
                            "listing_created",
                            "listing_purchased",
                          ],
                        },
                        minItems: 1,
                      },
                    ],
                    default: "*",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Subscription created. The `secret` field is shown ONLY here.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    id: { type: "integer" },
                    url: { type: "string", format: "uri" },
                    events: { type: "array", items: { type: "string" } },
                    secret: { type: "string", description: "32-byte hex (64 chars). Used to verify HMAC. Stored once." },
                    warning: { type: "string" },
                  },
                },
              },
            },
          },
          "400": errorResponse("Invalid url or events"),
          ...AUTH_ERROR_RESPONSES,
          "409": errorResponse("Duplicate URL for this wallet"),
          "429": errorResponse("Rate limit exceeded"),
        },
      },
      get: {
        tags: ["webhooks"],
        summary: "List the calling wallet's webhook subscriptions",
        description: "Secrets are NEVER returned by this endpoint — only at creation.",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Subscriptions list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    wallet: { type: "string" },
                    count: { type: "integer" },
                    webhooks: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "integer" },
                          url: { type: "string", format: "uri" },
                          events: { type: "array", items: { type: "string" } },
                          createdAt: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          ...AUTH_ERROR_RESPONSES,
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/api/v1/webhooks/{id}": {
      delete: {
        tags: ["webhooks"],
        summary: "Deactivate a subscription",
        description: "Owner-only (the API key's wallet must own the subscription).",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
          },
        ],
        responses: {
          "204": { description: "Subscription deactivated." },
          "400": errorResponse("Invalid id"),
          ...AUTH_ERROR_RESPONSES,
          "404": errorResponse("Subscription not found or not yours"),
          "429": errorResponse("Rate limit exceeded"),
        },
      },
    },
    "/sandbox/info": {
      get: {
        tags: ["sandbox"],
        summary: "Sandbox configuration",
        description: "Returns whether the sandbox is enabled and the per-purchase cap. Public, IP-rate-limited at 10/h.",
        security: [],
        responses: {
          "200": {
            description: "Sandbox info.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    enabled: { type: "boolean" },
                    sandboxWallet: { type: "string", nullable: true },
                    coverageCapUsdc: { type: "string" },
                    asset: {
                      type: "object",
                      properties: {
                        symbol: { type: "string", example: "USDC" },
                        bytes32: { type: "string" },
                      },
                    },
                    defaultProductId: { type: "string" },
                    defaultProductName: { type: "string" },
                    rateLimit: {
                      type: "object",
                      properties: {
                        perIp: { type: "integer" },
                        windowSeconds: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
          "429": errorResponse("Rate limit exceeded (10/h/IP on the sandbox surface)"),
        },
      },
    },
    "/sandbox/try": {
      post: {
        tags: ["sandbox"],
        summary: "Execute a $1 demo policy purchase",
        description:
          "No API key required. Coverage and buyer are fixed by the server (cap = SANDBOX_COVER_USDC, buyer = SANDBOX_WALLET). Useful for first-call demos and 'Try It' widgets. IP-rate-limited at 10/h. 503 if SANDBOX_WALLET is not configured.",
        security: [],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  productId: {
                    type: "string",
                    description: "bytes32 productId. Defaults to FLASHBTC1H-001 if omitted.",
                    pattern: "^0x[0-9a-fA-F]{64}$",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Demo policy purchased.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    sandbox: { type: "boolean", example: true },
                    productId: { type: "string" },
                    policyId: { type: "string" },
                    buyer: { type: "string" },
                    coverageAmount: { type: "string" },
                    premiumPaid: { type: "string" },
                    txHash: { type: "string" },
                    blockExplorer: { type: "string", format: "uri" },
                  },
                },
              },
            },
          },
          "400": errorResponse("Invalid productId"),
          "429": errorResponse("Rate limit exceeded (10/h/IP)"),
          "503": errorResponse("Sandbox disabled (SANDBOX_WALLET unset)"),
        },
      },
    },
  },
};
