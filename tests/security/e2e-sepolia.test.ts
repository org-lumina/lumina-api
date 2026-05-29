// E2E checks against the LIVE Sepolia API on Railway. These tests are
// skipped unless `RUN_LIVE_TESTS=1` is set in the environment, because
// they hit a real network and may flake on transient issues.
//
// Set:  RUN_LIVE_TESTS=1 npm test -- e2e-sepolia

const LIVE_BASE_URL =
  process.env.LIVE_BASE_URL ?? "https://lumina-api-production-ac85.up.railway.app";
const LIVE = process.env.RUN_LIVE_TESTS === "1";

// Built-in https module — no extra dep required.
import { request as httpsRequest } from "node:https";

interface LiveResponse {
  status: number;
  body: unknown;
}

function liveGet(path: string): Promise<LiveResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(LIVE_BASE_URL + path);
    const req = httpsRequest(
      {
        host: url.hostname,
        path: url.pathname + url.search,
        method: "GET",
        headers: { "user-agent": "lumina-api-audit-tests" },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // leave as text
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("live request timed out")));
    req.end();
  });
}

const maybe = LIVE ? describe : describe.skip;

maybe("live Sepolia: read-only smoke", () => {
  test("GET /health returns 200 with chainId 8453", async () => {
    const res = await liveGet("/health");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
    const body = res.body as { status: string; chain: { chainId: number } };
    expect(body.status).toBe("ok");
    expect(body.chain.chainId).toBe(8453);
  });

  test("GET /products returns the 9 shields registered on the live deploy", async () => {
    const res = await liveGet("/products");
    expect(res.status).toBe(200);
    const body = res.body as { count: number; products: Array<{ active: boolean }> };
    expect(body.count).toBe(9);
    expect(body.products.every((p) => p.active === true)).toBe(true);
  });

  test("GET /products/:id/quote returns a non-zero premium for FlashBTC1H + 1 000 USDC", async () => {
    const FLASH_BTC_1H = "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd";
    const res = await liveGet(`/products/${FLASH_BTC_1H}/quote?coverageAmount=1000000000`);
    expect(res.status).toBe(200);
    const body = res.body as { premium: string; payout: string };
    expect(BigInt(body.premium)).toBeGreaterThan(0n);
    expect(BigInt(body.payout)).toBeGreaterThan(0n);
  });

  test("GET /policies/<flash-btc>/3 returns the post-fix policy with buyer = deployer", async () => {
    const FLASH_BTC_1H = "0xe87625ef7415a58c92f2639b16d176521429aac002386dddf1e47e419dfeaddd";
    const res = await liveGet(`/policies/${FLASH_BTC_1H}/3`);
    expect(res.status).toBe(200);
    const body = res.body as { policyId: string; buyer: string; coverageAmount: string };
    expect(body.policyId).toBe("3");
    expect(body.coverageAmount).toBe("1000000000");
    expect(body.buyer.toLowerCase()).toBe("0xe585e76a0b8cbbc2d10b1110a9ac3f4c11dbfda8");
  });
});
