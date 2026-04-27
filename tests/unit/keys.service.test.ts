import { issueKey } from "../../src/services/keys";
import { HttpError } from "../../src/middlewares/error";

describe("keys.service.issueKey", () => {
  const wallet = "0x000000000000000000000000000000000000FEED";

  it("issues a key for a fresh wallet", () => {
    const r = issueKey(wallet, "first");
    expect(r.plaintext).toMatch(/^lk_[0-9a-f]{64}$/);
    expect(r.tier).toBe("free");
    expect(r.label).toBe("first");
    expect(r.wallet.toLowerCase()).toBe(wallet.toLowerCase());
  });

  it("rejects invalid wallet address", () => {
    expect(() => issueKey("not-an-address")).toThrow(HttpError);
  });

  it("rejects when wallet already has 3 active keys", () => {
    const w = "0x000000000000000000000000000000000000ABCD";
    issueKey(w, "k1");
    issueKey(w, "k2");
    issueKey(w, "k3");
    expect(() => issueKey(w, "k4")).toThrow(/key_limit_reached|3 active/);
  });
});
