// Resilient Ponder supervisor — the definitive fix for the recurring indexer
// freeze. Replaces the bare `cd indexer && ponder start` arm.
//
// Three freeze modes are handled so the indexer can NEVER stay stuck:
//
//  1. Schema-ownership crash. Ponder locks its Postgres schema to a build id;
//     when a redeploy's build differs it crashes with
//     `MigrationError: Schema "X" was previously used by a different Ponder app`
//     instead of recovering. We detect that exact error in Ponder's output and
//     AUTO-HEAL: drop the (user) schema once, then respawn so Ponder rebuilds
//     clean and re-indexes. A normal restart (no ownership error) does NOT drop
//     → Ponder resumes from its checkpoint with no re-index.
//
//  2. Permanent death. The previous setup used `concurrently --restart-tries 5`,
//     so after 5 crashes the indexer arm stayed dead while the API kept running
//     (the classic "frozen at a fixed block" symptom). This supervisor instead
//     loops FOREVER with a capped backoff — it never gives up.
//
//  3. Silent sync stall. A flaky/slow RPC can leave Ponder running but not
//     advancing. A watchdog checks the synced block every minute; if it hasn't
//     moved for STALL_MS while there is real lag, it kills Ponder to force a
//     fresh resume.
//
// Pure Node + `pg` (already a root dependency). No new packages.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEXER_DIR = path.resolve(__dirname, "..", "indexer");

const SCHEMA = process.env.DATABASE_SCHEMA?.trim();
const DATABASE_URL = process.env.DATABASE_URL;
const RPC_URL = process.env.RPC_URL || process.env.RPC_URL_QUICKNODE;

const BACKOFF_MS = 5_000;
const WATCH_INTERVAL_MS = 60_000;
const STALL_MS = 8 * 60_000; // no sync progress this long + real lag ⇒ restart
const STALL_LAG_BLOCKS = 200;

const OWNERSHIP_RE = /previously used by a different Ponder app|MigrationError/i;

function log(msg) {
  console.log(`[supervisor] ${new Date().toISOString()} ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drop the user schema so Ponder treats it as fresh (auto-heal step 1). */
async function dropSchema() {
  if (!DATABASE_URL || !SCHEMA || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(SCHEMA)) {
    log(`cannot heal: DATABASE_URL/DATABASE_SCHEMA missing or invalid (schema=${SCHEMA})`);
    return;
  }
  const c = new Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    log(`auto-heal: dropped schema "${SCHEMA}" — Ponder will rebuild + re-index`);
  } finally {
    await c.end().catch(() => {});
  }
}

/** Best-effort synced block from Ponder's checkpoint (0 if not available yet). */
async function syncedBlock() {
  if (!DATABASE_URL || !SCHEMA) return 0;
  const c = new Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const r = await c.query(
      `SELECT latest_checkpoint FROM "${SCHEMA}"._ponder_checkpoint ORDER BY chain_id LIMIT 1`
    );
    // latest_checkpoint layout: blockTimestamp(10)+chainId(16)+blockNumber(16)+…
    // (same decode the API uses in utils/indexerDb.ts).
    const raw = r.rows?.[0]?.latest_checkpoint;
    if (raw && raw.length >= 42) {
      const bn = Number(BigInt(raw.slice(26, 42)));
      return Number.isFinite(bn) && bn > 0 ? bn : 0;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    await c.end().catch(() => {});
  }
}

/** Current chain head via JSON-RPC (0 on failure → disables stall check). */
async function headBlock() {
  if (!RPC_URL) return 0;
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const j = await res.json();
    return j?.result ? Number(BigInt(j.result)) : 0;
  } catch {
    return 0;
  }
}

/** Run `ponder start` once; resolve when it exits. Returns {ownership}. */
function runPonderOnce() {
  return new Promise((resolve) => {
    log("starting ponder");
    const child = spawn("npm", ["start"], {
      cwd: INDEXER_DIR,
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    let ownership = false;
    const onData = (buf) => {
      const s = buf.toString();
      process.stdout.write(s);
      if (OWNERSHIP_RE.test(s)) ownership = true;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let lastSynced = -1;
    let lastProgressAt = Date.now();
    const watch = setInterval(async () => {
      const [sb, hb] = await Promise.all([syncedBlock(), headBlock()]);
      if (sb > lastSynced) {
        lastSynced = sb;
        lastProgressAt = Date.now();
      }
      const lag = hb > 0 ? hb - sb : 0;
      if (Date.now() - lastProgressAt > STALL_MS && lag > STALL_LAG_BLOCKS) {
        log(`watchdog: no sync progress for ${Math.round(STALL_MS / 60000)}m, lag=${lag} → restarting ponder`);
        lastProgressAt = Date.now(); // avoid repeated kills before exit
        child.kill("SIGTERM");
      }
    }, WATCH_INTERVAL_MS);
    watch.unref?.();

    child.on("exit", (code, signal) => {
      clearInterval(watch);
      log(`ponder exited code=${code} signal=${signal} ownershipError=${ownership}`);
      resolve({ ownership });
    });
  });
}

async function main() {
  log(`booting (schema=${SCHEMA ?? "<unset>"}, db=${DATABASE_URL ? "set" : "MISSING"}, rpc=${RPC_URL ? "set" : "MISSING"})`);
  if (!DATABASE_URL) {
    log("DATABASE_URL missing — indexer cannot run; exiting (API stays up).");
    return;
  }
  // Infinite supervision loop: the indexer can never stay dead.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { ownership } = await runPonderOnce();
    if (ownership) {
      try {
        await dropSchema();
      } catch (e) {
        log(`auto-heal failed (will retry next loop): ${e?.message ?? e}`);
      }
    }
    await sleep(BACKOFF_MS);
  }
}

main().catch((e) => {
  log(`fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
