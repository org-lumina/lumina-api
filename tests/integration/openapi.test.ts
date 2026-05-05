// OpenAPI spec + Swagger UI surface tests.
//
// These don't hit any RPC or DB code, but creating the Express app instantiates
// the route modules which transitively import ../../src/utils/ethers. We stub
// the ethers utility so we don't open a JsonRpcProvider against the placeholder
// URL during test setup.

jest.mock("../../src/utils/ethers", () => {
  const noopContract = { target: "0x0000000000000000000000000000000000000000" };
  return {
    provider: {},
    relayer: { address: "0x000000000000000000000000000000000000BEEF" },
    coverRouter: noopContract,
    coverRouterRelayer: noopContract,
    policyManager: noopContract,
    claimBond: noopContract,
    bondVault: noopContract,
    marketplace: noopContract,
    luminaToken: noopContract,
    usdc: noopContract,
    getGlobalPauseRegistry: jest.fn().mockResolvedValue(undefined),
    getShield: jest.fn().mockReturnValue(noopContract),
  };
});

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("GET /openapi.json", () => {
  it("returns a 200 JSON document with openapi=3.0.3 and a non-empty paths object", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.openapi).toBe("3.0.3");
    expect(typeof res.body.paths).toBe("object");
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(0);
  });

  it("documents the core endpoints", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.paths["/health"]).toBeDefined();
    expect(res.body.paths["/health"].get).toBeDefined();
    expect(res.body.paths["/products"]).toBeDefined();
    expect(res.body.paths["/api/v1/policies"].post).toBeDefined();
    expect(res.body.paths["/api/v1/marketplace/listings"].get).toBeDefined();
  });

  it("declares the shared component schemas", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    const schemas = res.body.components?.schemas ?? {};
    expect(schemas.Bytes32).toBeDefined();
    expect(schemas.Address).toBeDefined();
    expect(schemas.Error).toBeDefined();
  });

  it("declares both security schemes", async () => {
    const res = await request(app).get("/openapi.json");
    const sec = res.body.components?.securitySchemes ?? {};
    expect(sec.ApiKeyAuth).toMatchObject({ type: "apiKey", in: "header", name: "x-api-key" });
    expect(sec.AdminTokenAuth).toMatchObject({ type: "apiKey", in: "header", name: "x-admin-token" });
  });
});

describe("GET /api-docs", () => {
  it("renders Swagger UI HTML", async () => {
    const res = await request(app).get("/api-docs/").redirects(1);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    // swagger-ui-express's customSiteTitle option overrides the default
    // "<title>Swagger UI</title>" header, so we assert on the unmistakable
    // markup the renderer always emits: the swagger-ui mount node and the
    // swagger-ui-bundle.js script tag.
    expect(res.text).toMatch(/id="swagger-ui"/);
    expect(res.text).toMatch(/swagger-ui-bundle\.js/);
    // And the customSiteTitle we configured.
    expect(res.text).toMatch(/Lumina API/);
  });
});
