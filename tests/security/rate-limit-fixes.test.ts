// Verifies the three audit #36 fixes:
//
//   PUB-RL-1  — public read routes IP-rate-limited (120/min/IP)
//   AUTH-FLOOD — /api/v1/* IP-rate-limited BEFORE auth (60/min/IP)
//   IDEM-TTL  — idempotency rows older than 7 days are swept on boot
//
// The first two are observable through HTTP behaviour; the third is
// observable through the DB helpers directly.

// [Audit #36 fixes] Override the env BEFORE any module imports so the
// rate-limit middleware caches these values (instead of the 5 000 default
// the rest of the test suite uses to avoid cross-test interference).
// jest.mock() is hoisted to the very top by ts-jest, so we set env right
// after it but before any `import` from src/.
process.env.RATE_LIMIT_PUBLIC_IP_RPM = "120";
process.env.RATE_LIMIT_AUTH_IP_RPM = "60";

jest.mock("../../src/utils/ethers", () => ({
    provider: {
        getBlockNumber: jest.fn().mockResolvedValue(1),
        getBalance: jest.fn().mockResolvedValue(0n),
        getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
    },
    relayer: { address: "0x0000000000000000000000000000000000000001" },
    coverRouter: {
        getProductCount: jest.fn().mockResolvedValue(0n),
    },
    policyManager: {},
    coverRouterRelayer: {},
    claimBond: {},
    bondVault: {},
    luminaToken: {},
    usdc: {},
}));

import request from "supertest";
import { createApp } from "../../src/app";
import {
    getDb,
    findIdempotency,
    saveIdempotency,
    findOrCreateAgent,
    sweepIdempotency,
    IDEMPOTENCY_TTL_MS,
} from "../../src/db/database";

const app = createApp();

// ─────────────────────────────────────────────────────────────────────
// PUB-RL-1: public route IP rate-limit (120 / min / IP)
// ─────────────────────────────────────────────────────────────────────
describe("PUB-RL-1 fix: public routes IP-rate-limited", () => {
    test("121st request from same IP returns 429", async () => {
        // Use a unique X-Forwarded-For so this test does not interfere with
        // others running through the shared in-memory store.
        const ip = "203.0.113.1";

        let last200 = 0;
        for (let i = 0; i < 120; i++) {
            const r = await request(app).get("/products").set("X-Forwarded-For", ip);
            if (r.status === 200) last200++;
        }
        expect(last200).toBe(120);

        const after = await request(app).get("/products").set("X-Forwarded-For", ip);
        expect(after.status).toBe(429);
        expect(after.body.error).toBe("rate_limited");
    }, 60_000);

    test("a second IP keeps its full budget", async () => {
        // The first test exhausted 203.0.113.1; a second IP must still get 200.
        const r = await request(app).get("/products").set("X-Forwarded-For", "203.0.113.2");
        expect(r.status).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────
// AUTH-FLOOD: /api/v1/* IP-rate-limited BEFORE auth (60 / min / IP)
// ─────────────────────────────────────────────────────────────────────
describe("AUTH-FLOOD fix: /api/v1/* IP-limited before auth", () => {
    test("60 failed-auth attempts then 61st returns 429 (not 401)", async () => {
        const ip = "203.0.113.10";

        for (let i = 0; i < 60; i++) {
            const r = await request(app)
                .post("/api/v1/policies")
                .set("X-Forwarded-For", ip)
                .set("x-api-key", "lk_" + i.toString().padStart(64, "0"))
                .send({});
            // Either 401 (bogus key reached auth) or 429 (limiter tripped early).
            // The point of this fix is that LATER requests must hit 429.
            expect([401, 429]).toContain(r.status);
        }
        const blocked = await request(app)
            .post("/api/v1/policies")
            .set("X-Forwarded-For", ip)
            .set("x-api-key", "lk_" + "f".repeat(64))
            .send({});
        expect(blocked.status).toBe(429);
        expect(blocked.body.error).toBe("rate_limited");
    }, 60_000);

    test("a different IP retains its full /api/v1/* budget", async () => {
        const r = await request(app)
            .post("/api/v1/policies")
            .set("X-Forwarded-For", "203.0.113.11")
            .set("x-api-key", "lk_" + "0".repeat(64))
            .send({});
        // Either 401 (bogus key) or 200/201 (valid key) — must NOT be 429.
        expect(r.status).not.toBe(429);
    });

    test("ordering: limiter trips before authMiddleware (limiter response, not auth response)", async () => {
        // Same IP as the first AUTH-FLOOD test was already exhausted.
        // Confirm the response body shape matches the limiter's, not auth's.
        const r = await request(app)
            .post("/api/v1/policies")
            .set("X-Forwarded-For", "203.0.113.10")
            .send({});
        expect(r.status).toBe(429);
        expect(r.body.error).toBe("rate_limited");
        // Auth's 401 carries `error: "missing_api_key"`; we must NOT see that.
        expect(r.body.error).not.toBe("missing_api_key");
    });
});

// ─────────────────────────────────────────────────────────────────────
// IDEM-TTL: idempotency sweep
// ─────────────────────────────────────────────────────────────────────
describe("IDEM-TTL fix: idempotency rows older than 7 days are swept", () => {
    test("sweepIdempotency deletes rows past the TTL and keeps fresh ones", () => {
        const d = getDb();
        const agent = findOrCreateAgent("0x000000000000000000000000000000000000A1B2");

        // Insert a fresh row through the public helper.
        const freshKey = "fresh-" + Date.now();
        saveIdempotency(freshKey, agent.id, '{"ok":true,"id":"fresh"}');

        // Insert an old row by directly manipulating created_at.
        const staleKey = "stale-" + Date.now();
        saveIdempotency(staleKey, agent.id, '{"ok":true,"id":"stale"}');
        const past = Date.now() - IDEMPOTENCY_TTL_MS - 1000;
        d.prepare("UPDATE idempotency SET created_at = ? WHERE key = ?").run(past, staleKey);

        // Pre-state: both rows visible.
        expect(findIdempotency(freshKey, agent.id)).toBeDefined();
        expect(findIdempotency(staleKey, agent.id)).toBeDefined();

        const removed = sweepIdempotency(d);
        expect(removed).toBeGreaterThanOrEqual(1);

        // Post-state: stale gone, fresh kept.
        expect(findIdempotency(staleKey, agent.id)).toBeUndefined();
        expect(findIdempotency(freshKey, agent.id)).toBeDefined();
    });

    test("sweepIdempotency on an empty table returns 0", () => {
        const d = getDb();
        d.prepare("DELETE FROM idempotency").run();
        expect(sweepIdempotency(d)).toBe(0);
    });

    test("IDEMPOTENCY_TTL_MS is exactly 7 days", () => {
        expect(IDEMPOTENCY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
});
