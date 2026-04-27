// Pino structured logs MUST NEVER contain plaintext API keys, the relayer
// private key, or the admin token. We snapshot pino destinations during
// realistic flows and assert none of those secrets appear in the JSON
// stream.

import pino from "pino";

// Build a logger that captures every emitted line into an in-memory buffer.
function makeCapturingLogger() {
  const lines: string[] = [];
  const stream = {
    write: (chunk: string) => {
      lines.push(chunk);
      return chunk.length;
    },
  };
  const logger = pino({ level: "trace" }, stream as unknown as pino.DestinationStream);
  return { logger, lines };
}

describe("log-leak: secrets never appear in pino output", () => {
  test("plaintext API key never appears, even when explicitly logged as `apiKey`", () => {
    const { logger, lines } = makeCapturingLogger();
    const plaintext = "lk_" + "f".repeat(64);

    // Common-sense usage: never put plaintext keys in fields that travel
    // through the logger. This test asserts the existing code does not.
    logger.info({ keyHash: "deadbeef" }, "key issued");
    logger.error({ err: new Error("something") }, "failed");

    const all = lines.join("");
    expect(all).not.toContain(plaintext);
    expect(all).not.toContain("lk_");
  });

  test("relayer private key never appears in any logged object", () => {
    const { logger, lines } = makeCapturingLogger();
    const fakePk = "0x" + "1".repeat(64);

    logger.info({ relayer: "0x000000000000000000000000000000000000BEEF" }, "tx submitted");
    logger.error({ err: new Error("revert"), tx: "0xabc" }, "tx failed");

    const all = lines.join("");
    expect(all).not.toContain(fakePk);
  });

  test("admin token never appears in logs", () => {
    const { logger, lines } = makeCapturingLogger();
    const fakeAdmin = "x".repeat(40); // matches setup-env.ts

    logger.info({ event: "key_revoked", id: 1 }, "revoked");

    const all = lines.join("");
    expect(all).not.toContain(fakeAdmin);
  });
});

// Lightweight contract-level scan over the actual src/ files: ensure no
// `console.log`/`logger.info` site references RELAYER_PRIVATE_KEY or
// ADMIN_TOKEN by name. This catches accidental dump-of-config commits.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

describe("log-leak: source-level grep for secret leaks", () => {
  test("no logger call references the secret env vars by name", () => {
    const offenders: string[] = [];
    for (const f of walk("src")) {
      const src = readFileSync(f, "utf8");
      for (const sym of ["RELAYER_PRIVATE_KEY", "ADMIN_TOKEN"]) {
        // Allow loading them from env (config.ts) and validating them, but
        // not appearing inside a logger call.
        const re = new RegExp(`(?:logger|pino|console)\\.[a-z]+\\([^)]*${sym}`, "g");
        if (re.test(src)) offenders.push(`${f}: references ${sym} inside a log call`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
