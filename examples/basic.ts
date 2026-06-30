// Offline, zero-setup example: submit a tx and wait for confirmation against an
// inline fake ChainClient. No RPC, no funds, no keys with value.
//
//   npm install && npm run basic
//
// This is an isolated TypeScript project that depends on the *published*
// `walletsforce` package, exactly as a real consumer would.

import {
  WalletForcePool,
  LocalKeySigner,
  LegacyFeeOracle,
  type ChainClient,
} from "walletsforce";

// Well-known public Anvil/Hardhat test key #0 — NEVER use with real funds.
const signer = new LocalKeySigner(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

// A consumer-supplied ChainClient. Here it's a stub that "mines" the tx on the
// next confirm tick. In a real app this is `new ViemChainClient(publicClient)`
// (see testnet.ts). Typing it as ChainClient gets compile-time checking of the seam.
let broadcastHash: `0x${string}` | null = null;
const chainClient: ChainClient = {
  async getTransactionCount() {
    return 0;
  },
  async estimateGas() {
    return 21_000n;
  },
  async getBalance() {
    return 10n ** 18n;
  },
  async getBaseFeePerGas() {
    return null; // legacy chain
  },
  async sendRawTransaction(raw) {
    broadcastHash = `0x${"ab".repeat(32)}`;
    console.log("   broadcast raw tx:", raw.slice(0, 18) + "…");
    return broadcastHash;
  },
  async getTransactionReceipt() {
    return broadcastHash
      ? { status: "success", blockNumber: 100n, transactionHash: broadcastHash }
      : null;
  },
  async getBlockNumber() {
    return 100n;
  },
  classifyError() {
    return "fatal";
  },
};

const pool = new WalletForcePool({
  ownerId: "example",
  chainId: 1,
  signers: [signer],
  chainClient,
  feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000_000_000n }),
  confirmations: 1,
  confirmTickMs: 50,
});

console.log("signer:", signer.address);

// Subscribe to the lifecycle firehose (optional — for metrics / persistence).
pool.on("broadcast", (r) => console.log("event: broadcast", r.idempotencyKey, r.hash.slice(0, 12) + "…"));
pool.on("confirmed", (r) => console.log("event: confirmed", r.idempotencyKey));

const { account, nonce, hash } = await pool.submit(
  { to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  { idempotencyKey: "job-1" },
);
console.log(`submitted: account=${account} nonce=${nonce} hash=${hash.slice(0, 12)}…`);

// Register the waiter, then start the confirm loop.
const waiter = pool.waitForConfirmation("job-1");
pool.start();

const receipt = await waiter; // resolves on confirmed; throws on reverted/failed
console.log("landed:", receipt.status, "@ nonce", receipt.nonce);

await pool.stop();
console.log("\n✅ basic example complete");
