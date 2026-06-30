// Resource profiler: how much CPU / RAM does *walletsforce itself* cost the caller?
//
// It removes the network entirely (in-memory fake ChainClient) so the only work
// measured is the library's: routing, zod validation, the nonce lane, the in-flight
// map, and signing. It runs each bench with a fake signer (pure orchestration) and
// with LocalKeySigner (real secp256k1) so you can attribute the signing cost.
//
//   npm run profile                                   # plain report
//   node --expose-gc      --import tsx profile.ts      # accurate heap baselines + leak check
//   node --cpu-prof --cpu-prof-dir=./profiles --import tsx profile.ts   # V8 CPU profile
//   /usr/bin/time -l      node --import tsx profile.ts # whole-process peak RSS (macOS)
//   SNAPSHOT=1 node --expose-gc --import tsx profile.ts # writes a .heapsnapshot at peak
//
// Env: N (ops, default 50000), DATA_BYTES (calldata size, default 100).

import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import {
  WalletForcePool,
  LocalKeySigner,
  LegacyFeeOracle,
  type ChainClient,
  type Signer,
  type SignableTx,
  type Address,
  type Hash,
  type Hex,
} from "walletsforce";

const N = Number(process.env.N ?? "50000");
const DATA_BYTES = Number(process.env.DATA_BYTES ?? "100");
const SNAPSHOT = process.env.SNAPSHOT === "1";
const hasGc = typeof globalThis.gc === "function";

const ADDR = "0x000000000000000000000000000000000000dEaD" as Address;
const CALLDATA = ("0x" + "ab".repeat(DATA_BYTES)) as Hex; // realistic contract-call payload

// --- in-memory chain: instant, no I/O ---------------------------------------
class FastChain implements ChainClient {
  async getTransactionCount() { return 0; }
  async estimateGas() { return 21_000n; }
  async getBalance() { return 10n ** 18n; }
  async getBaseFeePerGas() { return null; }
  async sendRawTransaction() { return ("0x" + "11".repeat(32)) as Hash; }
  // confirm path: report mined+confirmed immediately
  async getTransactionReceipt() { return { status: "success" as const, blockNumber: 1n, transactionHash: ("0x" + "11".repeat(32)) as Hash }; }
  async getBlockNumber() { return 10n; }
  classifyError() { return "fatal" as const; }
}

class FakeSigner implements Signer {
  constructor(readonly address: Address) {}
  async signTransaction(tx: SignableTx): Promise<Hex> { return ("0x" + tx.nonce.toString(16)) as Hex; }
}

const gc = () => { if (hasGc) { globalThis.gc!(); globalThis.gc!(); } };
const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
const fmt = (n: number) => n.toLocaleString("en-US");

function makePool(signer: Signer, opts: { maxInflight: number }) {
  return new WalletForcePool({
    ownerId: "profile",
    chainId: 1,
    signers: [signer],
    chainClient: new FastChain(),
    feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000_000_000n }),
    confirmations: 1,
    confirmTickMs: 1,
    maxInflightPerAccount: opts.maxInflight,
  });
}

const req = () => ({ to: ADDR, data: CALLDATA });

// === Bench A: submit hot path (CPU + bytes per in-flight entry) ==============
// No confirm loop. Submits accumulate in-flight, so the heap delta / N is the
// retained cost per in-flight tx (dominated by the kept signed tx + calldata).
async function benchSubmit(label: string, signer: Signer) {
  // warm up the JIT on a throwaway pool so the measured pool holds exactly N in-flight
  const warm = makePool(signer, { maxInflight: 3_000 });
  for (let i = 0; i < 2_000; i++) await warm.submit(req(), { idempotencyKey: `w${i}` });

  const pool = makePool(signer, { maxInflight: N + 1 });
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();

  for (let i = 0; i < N; i++) await pool.submit(req(), { idempotencyKey: `k${i}` });

  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  gc();
  const heapDelta = process.memoryUsage().heapUsed - heap0;
  const cpuUs = cpu.user + cpu.system;

  if (SNAPSHOT && signer instanceof LocalKeySigner) {
    const f = v8.writeHeapSnapshot();
    console.log(`  wrote heap snapshot at peak in-flight: ${f}`);
  }

  console.log(`\n[submit hot path — ${label}]`);
  console.log(`  ops:               ${fmt(N)}  (each: route + validate + sign + broadcast)`);
  console.log(`  throughput:        ${fmt(Math.round(N / (wallMs / 1000)))} ops/sec`);
  console.log(`  wall:              ${(wallMs * 1000 / N).toFixed(2)} µs/op`);
  console.log(`  cpu:               ${(cpuUs / N).toFixed(2)} µs/op  (user+system)`);
  console.log(`  retained heap:     ${mb(heapDelta)} MB for ${fmt(N)} in-flight  ->  ${Math.round(heapDelta / N)} bytes/entry`);
  console.log(`  pool.stats():      inflight=${fmt(pool.stats().wallets[0].inflightCount)} stickyKeys=${pool.stats().stickyKeys}`);
}

// === Bench B: submit -> confirm cycle (bounded memory) =======================
// Each round fills then fully settles, so heap must return to baseline (no leak).
async function benchBoundedMemory() {
  const ROUNDS = 20;
  const BATCH = Math.max(1, Math.floor(N / ROUNDS));
  const pool = makePool(new FakeSigner(ADDR), { maxInflight: BATCH + 1 });
  pool.start();

  let maxRss = 0;
  const sampler = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage().rss); }, 5);

  gc();
  const heap0 = process.memoryUsage().heapUsed;

  for (let r = 0; r < ROUNDS; r++) {
    await Promise.all(
      Array.from({ length: BATCH }, (_, i) => {
        const key = `r${r}-${i}`;
        const done = pool.waitForConfirmation(key);     // register before submit
        return pool.submit(req(), { idempotencyKey: key }).then(() => done);
      }),
    );
  }

  clearInterval(sampler);
  gc();
  const heapDelta = process.memoryUsage().heapUsed - heap0;
  await pool.stop();

  console.log(`\n[bounded memory — submit→confirm, ${fmt(ROUNDS * BATCH)} cycles in ${ROUNDS} rounds]`);
  console.log(`  heap after vs baseline: ${mb(heapDelta)} MB  (≈0 ⇒ in-flight state is released on settle)`);
  console.log(`  peak process RSS:       ${mb(maxRss)} MB`);
  console.log(`  pool.stats() at end:    inflight=${pool.stats().wallets[0].inflightCount} stickyKeys=${pool.stats().stickyKeys}`);
}

async function main() {
  console.log(`walletsforce resource profile — N=${fmt(N)}, calldata=${DATA_BYTES}B, gc=${hasGc ? "exposed" : "NOT exposed (run with --expose-gc for accurate heap)"}`);
  await benchSubmit("fake signer (orchestration only)", new FakeSigner(ADDR));
  await benchSubmit("LocalKeySigner (real secp256k1)", new LocalKeySigner("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"));
  await benchBoundedMemory();
  console.log("\n✅ profile complete");
}

main().catch((e) => { console.error(e); process.exit(1); });
