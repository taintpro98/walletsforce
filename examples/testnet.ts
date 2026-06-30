// Real on-chain example: send a tx on a testnet using ViemChainClient.
//
// Prerequisites:
//   - A testnet RPC URL (e.g. Base Sepolia from any RPC provider)
//   - A private key whose address holds some testnet gas (use a faucet)
//   - DO NOT use a key that controls real funds.
//
// Run:
//   npm install
//   RPC_URL="https://sepolia.base.org" \
//   PRIVATE_KEY="0x..." \
//   TO="0x...recipient..." \
//   CHAIN_ID=84532 \
//   npm run testnet
//
// Sends a 0-value tx (to itself by default) — enough to exercise the full
// route -> sign -> broadcast -> confirm path on a live chain.

import { createPublicClient, http } from "viem";
import {
  WalletForcePool,
  LocalKeySigner,
  Eip1559FeeOracle,
  ViemChainClient,
} from "walletsforce";

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "84532"); // Base Sepolia default

if (!RPC_URL || !PRIVATE_KEY) {
  console.error("Set RPC_URL and PRIVATE_KEY env vars. See the comment at the top of this file.");
  process.exit(1);
}

const signer = new LocalKeySigner(PRIVATE_KEY);
const to = (process.env.TO ?? signer.address) as `0x${string}`;

const publicClient = createPublicClient({ transport: http(RPC_URL) });

const pool = new WalletForcePool({
  ownerId: "testnet-example",
  chainId: CHAIN_ID,
  signers: [signer],
  chainClient: new ViemChainClient(publicClient),
  feeOracle: new Eip1559FeeOracle({ priorityFeeWei: 1_000_000_000n }), // 1 gwei tip
  confirmations: 1,
  confirmTickMs: 4_000,
  stuckAfterMs: 30_000,
  maxAttempts: 5,
});

pool.on("broadcast", (r) => console.log(`broadcast: ${r.hash} (nonce ${r.nonce})`));
pool.on("replaced", (r) => console.log(`replaced (fee bump): ${r.hash}`));
pool.on("confirmed", (r) => console.log(`confirmed: ${r.hash}`));

console.log(`from ${signer.address} -> to ${to} on chain ${CHAIN_ID}`);

pool.start();

const idempotencyKey = `demo-${Date.now()}`;
const { hash } = await pool.submit({ to, value: 0n }, { idempotencyKey });
console.log("submitted, current hash:", hash);

try {
  // Correlate by idempotencyKey, NOT hash — a fee-bumped replacement changes the hash.
  const receipt = await pool.waitForConfirmation(idempotencyKey);
  console.log(`✅ confirmed: ${receipt.hash}`);
} catch (err) {
  console.error("❌ tx did not confirm:", (err as Error).message);
} finally {
  await pool.stop();
}
