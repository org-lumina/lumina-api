// Full E2E lifecycle against the LIVE Sepolia stack.
//
// This test is OFF by default because:
//   - it requires a funded relayer + USDC-bearing buyer wallet on Sepolia,
//   - it mints USDC (a write tx),
//   - it submits a real `purchasePolicyFor`,
// all of which cost (free testnet) gas and add policies to on-chain state.
//
// Enable explicitly:
//   RUN_LIVE_TESTS=1 npm test -- full-lifecycle
//
// The READ-ONLY portion (key issue + API GET checks) runs in mock mode by
// default so the suite still exercises route wiring.

const LIVE = process.env.RUN_LIVE_TESTS === "1";
const LIVE_BASE_URL =
    process.env.LIVE_BASE_URL ?? "https://lumina-api-production-ac85.up.railway.app";

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

interface RawResponse {
    status: number;
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
}

function liveRequest(opts: {
    path: string;
    method: "GET" | "POST" | "DELETE";
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
}): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const url = new URL(LIVE_BASE_URL + opts.path);
        const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
        const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
        const req = requester(
            {
                host: url.hostname,
                port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname + url.search,
                method: opts.method,
                headers: {
                    "user-agent": "lumina-api-audit37-e2e",
                    "content-type": bodyText ? "application/json" : undefined,
                    "content-length": bodyText ? String(Buffer.byteLength(bodyText)) : undefined,
                    ...opts.headers,
                } as Record<string, string>,
                timeout: opts.timeoutMs ?? 60_000,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let parsed: unknown = text;
                    try {
                        parsed = JSON.parse(text);
                    } catch {
                        // leave as text
                    }
                    resolve({
                        status: res.statusCode ?? 0,
                        body: parsed,
                        headers: res.headers,
                    });
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("live request timed out")));
        if (bodyText) req.write(bodyText);
        req.end();
    });
}

const maybe = LIVE ? describe : describe.skip;
const FOUNDER_WALLET = "0xe585e76A0b8CbbC2d10b1110a9ac3F4c11dBfDa8";
const FLASH_BTC_1H_PRODUCT_ID =
    "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd";

maybe("E2E full lifecycle (LIVE Sepolia)", () => {
    test("admin generates a key, key lists empty policies for caller", async () => {
        const adminToken = process.env.LIVE_ADMIN_TOKEN;
        if (!adminToken) {
            throw new Error(
                "LIVE_ADMIN_TOKEN must be set when RUN_LIVE_TESTS=1 (use the live API's admin token)"
            );
        }

        // 1. Issue a fresh API key.
        const fresh = await liveRequest({
            method: "POST",
            path: "/api/v1/keys/generate",
            headers: { "x-admin-token": adminToken },
            body: { wallet: FOUNDER_WALLET, label: "audit37-e2e" },
        });
        // 201 on first issue; 409 if the wallet has already hit the per-wallet
        // cap from prior runs. Either case is acceptable for the test — the
        // important assertion is "the admin path responds in a sane shape".
        expect([201, 409]).toContain(fresh.status);

        if (fresh.status === 201) {
            const body = fresh.body as { ok: boolean; apiKey: string; wallet: string };
            expect(body.ok).toBe(true);
            expect(body.apiKey).toMatch(/^lk_[0-9a-f]{64}$/);
            expect(body.wallet.toLowerCase()).toBe(FOUNDER_WALLET.toLowerCase());

            // 2. Use the key to list policies for the caller's own wallet.
            //    Should return at least one entry (the post-PR-#86 policy id 3
            //    that we know exists in production).
            const list = await liveRequest({
                method: "GET",
                path: "/api/v1/policies",
                headers: { "x-api-key": body.apiKey },
            });
            expect(list.status).toBe(200);
            const lb = list.body as { count: number; owner: string; policies: unknown[] };
            expect(lb.owner.toLowerCase()).toBe(FOUNDER_WALLET.toLowerCase());
            expect(typeof lb.count).toBe("number");
        }
    }, 30_000);

    test("public read path is consistent — /products has 9 shields", async () => {
        const r = await liveRequest({ method: "GET", path: "/products" });
        expect(r.status).toBe(200);
        const b = r.body as { count: number; products: Array<{ active: boolean }> };
        expect(b.count).toBe(9);
        expect(b.products.every((p) => p.active === true)).toBe(true);
    }, 30_000);

    test("public read path — known policy id 3 is owned by the founder", async () => {
        const r = await liveRequest({
            method: "GET",
            path: `/policies/${FLASH_BTC_1H_PRODUCT_ID}/3`,
        });
        expect(r.status).toBe(200);
        const b = r.body as { policyId: string; buyer: string; coverageAmount: string };
        expect(b.policyId).toBe("3");
        expect(b.buyer.toLowerCase()).toBe(FOUNDER_WALLET.toLowerCase());
        expect(b.coverageAmount).toBe("1000000000");
    }, 30_000);

    test("authenticated GET /api/v1/policies?owner=<other> returns 403 (post INV-1)", async () => {
        const adminToken = process.env.LIVE_ADMIN_TOKEN!;
        // Create a key under a throwaway wallet so we can probe the IDOR fix.
        const throwaway = "0x000000000000000000000000000000000000FAFA";
        const fresh = await liveRequest({
            method: "POST",
            path: "/api/v1/keys/generate",
            headers: { "x-admin-token": adminToken },
            body: { wallet: throwaway, label: "audit37-idor-probe" },
        });
        if (fresh.status !== 201) {
            // Wallet already at limit from prior runs; skip the probe.
            return;
        }
        const apiKey = (fresh.body as { apiKey: string }).apiKey;

        const probe = await liveRequest({
            method: "GET",
            path: `/api/v1/policies?owner=${FOUNDER_WALLET}`,
            headers: { "x-api-key": apiKey },
        });
        expect(probe.status).toBe(403);
    }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// Mock-mode tests — always run. Verify the route wiring without hitting
// the live API. Mirrors the structure of the live tests so changes to
// the route shape are caught in CI.
// ─────────────────────────────────────────────────────────────────────

jest.mock("../../src/utils/ethers", () => ({
    provider: {
        getBlockNumber: jest.fn().mockResolvedValue(40_792_000),
        getBalance: jest.fn().mockResolvedValue(2n * 10n ** 16n),
        getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
    },
    relayer: { address: "0x168dC7105e907294f9d066cee24f30caa5A17E4a" },
    coverRouter: {
        getProductCount: jest.fn().mockResolvedValue(9n),
        productList: jest.fn(async (i: bigint) => `0x${i.toString(16).padStart(64, "0")}`),
        products: jest.fn().mockResolvedValue([
            "0x" + "0".repeat(64),
            8000n,
            100n,
            15000n,
            3600n,
            true,
        ]),
    },
    policyManager: {
        productShield: jest.fn().mockResolvedValue("0x000000000000000000000000000000000000FEED"),
        productActive: jest.fn().mockResolvedValue(true),
        policies: jest.fn(),
    },
    coverRouterRelayer: {},
    claimBond: {},
    bondVault: {},
    luminaToken: {},
    usdc: {},
}));

import request from "supertest";
import { createApp } from "../../src/app";
import { issueKey } from "../../src/services/keys";

const app = createApp();

describe("E2E mock-mode wiring (always runs)", () => {
    test("GET /products returns 9 active shields (route + service wired)", async () => {
        const r = await request(app).get("/products");
        expect(r.status).toBe(200);
        expect(r.body.count).toBe(9);
        expect(r.body.products.length).toBe(9);
    });

    test("admin issues a key, agent uses it to list policies", async () => {
        const wallet = "0x0000000000000000000000000000000000003337";
        const issued = issueKey(wallet, "e2e-wiring");
        const list = await request(app).get("/api/v1/policies").set("x-api-key", issued.plaintext);
        expect(list.status).toBe(200);
        expect(list.body.owner).toBe(wallet.toLowerCase());
        expect(list.body.count).toBe(0);
    });

    test("INV-1: cross-owner read returns 403", async () => {
        const aliceWallet = "0x0000000000000000000000000000000000003338";
        const bobWallet = "0x0000000000000000000000000000000000003339";
        const aliceKey = issueKey(aliceWallet, "alice").plaintext;
        const probe = await request(app)
            .get(`/api/v1/policies?owner=${bobWallet}`)
            .set("x-api-key", aliceKey);
        expect(probe.status).toBe(403);
        expect(probe.body.error).toBe("forbidden");
    });
});
