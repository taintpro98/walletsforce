// Multi-signer demo against a LOCAL chain: a pool with 10 signers fans many
// contract calls across 10 independent nonce lanes — the whole point of
// walletsforce. We fire a burst of Counter.increment() calls and show how they
// spread across the accounts.
//
//   1. bring up the local stack:  docker compose -f docker-compose.local.yml up -d chain
//                                 docker compose -f docker-compose.local.yml run --rm deploy
//   2. run this:                  npm run local
//
// Addresses + ABIs are loaded from deployments/local.json (published by the deploy
// service). This script never deploys anything itself.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, http, encodeFunctionData, type Abi } from "viem";
import {
  WalletForcePool,
  Supervisor,
  createSubstrate,
  deriveHDSigners,
  LegacyFeeOracle,
  ViemChainClient,
  type WalletConfig,
} from "walletsforce";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// Standard local-node dev mnemonic (Hardhat & Anvil share it). Its first accounts
// are pre-funded with test ETH. PUBLIC — never use with real funds.
const MNEMONIC = "test test test test test test test test test test test junk";
const SIGNER_COUNT = 10;
const BURST = 20; // contract calls to fan out across the pool

// --- load deployed addresses + ABIs from the deploy artifact ----------------
type Deployed = { address: `0x${string}`; abi: Abi };
type Deployments = { chainId: number; contracts: Record<"Counter" | "DemoToken", Deployed> };

const here = dirname(fileURLToPath(import.meta.url));
const deploymentsPath = join(here, "deployments", "local.json");
let deployments: Deployments;
try {
  deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));
} catch {
  console.error(
    `Could not read ${deploymentsPath}.\nBring up the local stack first:\n  docker compose -f docker-compose.local.yml up --build`,
  );
  process.exit(1);
}
const { Counter } = deployments.contracts;

// --- 10 signers, derived from the dev mnemonic (one seed → the whole pool) ---
const signers = deriveHDSigners(MNEMONIC, SIGNER_COUNT);

const publicClient = createPublicClient({ transport: http(RPC_URL) });
// Pool and Supervisor share ONE substrate (cache + store + bus) in this process.
const config: WalletConfig = {
  ownerId: "local-multi",
  chainId: deployments.chainId,
  signers, // ← 10 nonce lanes
  chainClient: new ViemChainClient(publicClient),
  feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000_000_000n }),
  confirmations: 1,
};
const substrate = createSubstrate(config);
const pool = new WalletForcePool(config, substrate);
// confirmTickMs is a supervisor concern — let the burst broadcast before the first tick.
const supervisor = new Supervisor({ ...config, confirmTickMs: 2_000 }, substrate);

console.log(`chain ${deployments.chainId} @ ${RPC_URL}`);
console.log(`pool with ${signers.length} signers:`);
for (const s of signers) console.log(`  ${s.address}`);

await pool.start();  // boot reconcile (restore from store) before submitting
supervisor.start();

const readCount = () =>
  publicClient.readContract({ address: Counter.address, abi: Counter.abi, functionName: "count" }) as Promise<bigint>;
const callData = encodeFunctionData({ abi: Counter.abi, functionName: "increment" });

const before = await readCount();
console.log(`\nfiring ${BURST} increment() calls across the pool…`);

// The router routes to the least-in-flight account, and an account's in-flight
// count registers once its tx broadcasts. So we await each submit (its broadcast)
// before issuing the next: the router then observes the growing load and spreads
// the calls round-robin across the lanes. (A fully-concurrent burst would route on
// a stale all-zero snapshot and pile onto one account.) Confirmations still happen
// in parallel across lanes — we collect the waiters and await them together.
const accounts: string[] = [];
const waiters: Promise<unknown>[] = [];
for (let i = 0; i < BURST; i++) {
  const key = `inc-${i}`;
  waiters.push(pool.waitForConfirmation(key)); // register before submit — never miss the event
  const { account } = await pool.submit({ to: Counter.address, data: callData }, { idempotencyKey: key });
  accounts.push(account.toLowerCase());
}
await Promise.all(waiters);

const results = accounts;
const after = await readCount();

// Tally how many calls each signer handled — shows the load spread over the lanes.
const perAccount = new Map<string, number>();
for (const a of results) perAccount.set(a, (perAccount.get(a) ?? 0) + 1);

console.log(`\ndistribution across accounts (${perAccount.size} of ${signers.length} used):`);
for (const s of signers) {
  const n = perAccount.get(s.address.toLowerCase()) ?? 0;
  console.log(`  ${s.address}  ${"█".repeat(n)} ${n}`);
}
console.log(`\nCounter.count: ${before} -> ${after}  (+${after - before})`);

await supervisor.stop();
await pool.stop();
console.log("\n✅ 10-signer fan-out demo complete");
