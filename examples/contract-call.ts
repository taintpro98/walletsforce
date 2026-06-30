// Offline example: submit a CONTRACT CALL.
//
//   npm install && npm run contract-call
//
// walletsforce is ABI-agnostic — it does NOT encode calls. You encode the
// calldata yourself (here with viem's encodeFunctionData) and pass it as the
// `data` field of the tx request; `to` is the contract address. The pool then
// owns nonce / gas / fees / sign / broadcast / confirm.
//
// Runs against an inline fake ChainClient, so it needs no RPC, funds, or real keys.

import { encodeFunctionData, parseAbi, decodeFunctionData } from "viem";
import {
  WalletForcePool,
  LocalKeySigner,
  Eip1559FeeOracle,
  type ChainClient,
} from "walletsforce";

// 1. Encode the contract call -> calldata. (This is the part walletsforce leaves to you.)
const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const amount = 1_000_000n; // e.g. 1 USDC (6 decimals)

const data = encodeFunctionData({
  abi: erc20,
  functionName: "transfer",
  args: [recipient, amount],
});
console.log("encoded calldata:", data.slice(0, 26) + "…");

// 2. A fake ChainClient that "mines" the tx on the next confirm tick (no network).
let broadcastHash: `0x${string}` | null = null;
const chainClient: ChainClient = {
  async getTransactionCount() {
    return 0;
  },
  async estimateGas() {
    return 60_000n; // a token transfer costs more than a plain send
  },
  async getBalance() {
    return 10n ** 18n;
  },
  async getBaseFeePerGas() {
    return 20_000_000_000n; // 20 gwei base fee -> exercises the eip1559 oracle
  },
  async sendRawTransaction(_raw) {
    broadcastHash = `0x${"cc".repeat(32)}`;
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

const signer = new LocalKeySigner(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const pool = new WalletForcePool({
  ownerId: "contract-call-example",
  chainId: 84532,
  signers: [signer],
  chainClient,
  feeOracle: new Eip1559FeeOracle({ priorityFeeWei: 1_000_000_000n }), // 1 gwei tip
  confirmations: 1,
  confirmTickMs: 50,
});

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // some ERC-20 contract

console.log(`calling transfer(${recipient}, ${amount}) on token ${TOKEN}`);

pool.start();

// 3. Submit the contract call: `to` = the contract, `data` = the encoded call.
const idempotencyKey = "erc20-transfer-1";
const { hash, fees } = await pool.submit(
  { to: TOKEN, data }, // value omitted -> non-payable call
  { idempotencyKey },
);
console.log("submitted contract call:", hash.slice(0, 14) + "…", "fees:", fees.type);

// 4. Confirm — correlate by idempotencyKey, never by hash.
const receipt = await pool.waitForConfirmation(idempotencyKey);
console.log("landed:", receipt.status);

// Sanity: the calldata we built decodes back to the call we intended.
const { functionName, args } = decodeFunctionData({ abi: erc20, data });
console.log("decoded:", functionName, args);

await pool.stop();
console.log("\n✅ contract-call example complete");
