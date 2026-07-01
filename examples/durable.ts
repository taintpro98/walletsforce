// Durability demo: a SQLite-backed store survives a crash. We submit a tx (which is
// write-ahead-persisted before broadcast), throw away the pool WITHOUT confirming it
// (simulating a crash), then build a fresh pool over the SAME sqlite file and call
// restore() — the in-flight tx is re-tracked and rebroadcast, ready for the supervisor
// to confirm. Nothing here touches a real chain (inline fake ChainClient).
//
//   npm run durable
//
// The only difference from basic.ts is the substrate's store: instead of the default
// in-memory store, we select the SQLite store via the factory:
//   createSubstrate(config, { store: { kind: "sqlite", path } })

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WalletForcePool,
  Supervisor,
  createSubstrate,
  LocalKeySigner,
  LegacyFeeOracle,
  type ChainClient,
  type WalletConfig,
} from "walletsforce";

const signer = new LocalKeySigner(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

// A fake chain that "mines" whatever was last broadcast, on the next confirm tick.
let broadcastHash: `0x${string}` | null = null;
const chainClient: ChainClient = {
  async getTransactionCount() { return 0; },
  async estimateGas() { return 21_000n; },
  async getBalance() { return 10n ** 18n; },
  async getBaseFeePerGas() { return null; },
  async sendRawTransaction(raw) { broadcastHash = `0x${"cd".repeat(32)}`; void raw; return broadcastHash; },
  async getTransactionReceipt() {
    return broadcastHash ? { status: "success", blockNumber: 10n, transactionHash: broadcastHash } : null;
  },
  async getBlockNumber() { return 10n; },
  classifyError() { return "fatal"; },
};

const dbPath = join(tmpdir(), "walletsforce-durable-demo.sqlite");
rmSync(dbPath, { force: true }); // fresh start for the demo

const config: WalletConfig = {
  ownerId: "durable-demo",
  chainId: 1,
  signers: [signer],
  chainClient,
  feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000_000_000n }),
  confirmations: 1,
};

console.log(`sqlite store: ${dbPath}\n`);

// ── Process 1: submit a tx, then "crash" before it confirms ──────────────────
{
  const substrate = createSubstrate(config, { store: { kind: "sqlite", path: dbPath } });
  const pool = new WalletForcePool(config, substrate);
  await pool.start(); // restore() — nothing yet
  const { account, nonce, hash } = await pool.submit(
    { to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    { idempotencyKey: "durable-job-1" },
  );
  console.log(`[proc 1] submitted job -> account=${account} nonce=${nonce} hash=${hash.slice(0, 12)}…`);
  console.log(`[proc 1] in-flight now: ${(await pool.wallets())[0].inflightCount}`);
  console.log(`[proc 1] 💥 crash — no supervisor ran, tx never confirmed\n`);
  // NOTE: we do NOT stop the supervisor (there is none) — we just drop the pool.
  // The write-ahead row is already durable in sqlite.
}

// ── Process 2: fresh pool over the SAME file recovers the in-flight tx ────────
{
  const substrate = createSubstrate(config, { store: { kind: "sqlite", path: dbPath } });
  const pool = new WalletForcePool(config, substrate);
  const supervisor = new Supervisor({ ...config, confirmTickMs: 20 }, substrate);

  const restored = await pool.start(); // restore() from sqlite: re-tracks + rebroadcasts
  console.log(`[proc 2] restore() re-tracked ${restored} transaction(s) from sqlite`);
  console.log(`[proc 2] in-flight after restore: ${(await pool.wallets())[0].inflightCount}`);

  const waiter = pool.waitForConfirmation("durable-job-1");
  supervisor.start();
  const receipt = await waiter; // the recovered tx confirms
  console.log(`[proc 2] recovered job confirmed: status=${receipt.status} nonce=${receipt.nonce}`);

  await supervisor.stop();
  await pool.stop();
}

rmSync(dbPath, { force: true });
console.log("\n✅ durable (sqlite) crash-recovery demo complete");
