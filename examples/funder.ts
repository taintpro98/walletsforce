// Auto-refill demo against a LOCAL chain: a pool whose signer starts with ZERO
// balance gets topped up automatically by a TreasuryFunder, from a funded
// treasury account.
//
//   1. start a local chain:  docker compose -f docker-compose.local.yml up -d chain
//   2. run this:             npm run funder
//
// Requires walletsforce >= 0.1.0 (TreasuryFunder). Until 0.1.0 is published, the
// examples project is linked to the local build (see README: "test local changes").

import { createPublicClient, http, formatEther } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  WalletForcePool,
  LocalKeySigner,
  LegacyFeeOracle,
  ViemChainClient,
  TreasuryFunder,
} from "walletsforce";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "31337");

// Treasury = local dev account #0 (rich, public test key). Pool signer = a brand-new
// account with ZERO balance — exactly the thing the funder exists to rescue.
const TREASURY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const treasury = new LocalKeySigner(TREASURY_KEY);
const signer = new LocalKeySigner(generatePrivateKey());

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const chainClient = new ViemChainClient(publicClient);
const feeOracle = new LegacyFeeOracle({ minGasPriceWei: 1_000_000_000n });

// A tiny logger so we can see the funder's activity.
const logger = {
  debug() {},
  info: (m: string) => console.log(`  [funder] ${m}`),
  warn: (m: string) => console.warn(`  [funder] ${m}`),
  error: (m: string, e?: unknown) => console.error(`  [funder] ${m}`, e ?? ""),
};

const pool = new WalletForcePool({
  ownerId: "funder-demo",
  chainId: CHAIN_ID,
  signers: [signer],
  chainClient,
  feeOracle,
  confirmations: 1,
  confirmTickMs: 1_000,
  minBalanceWei: 1n * 10n ** 17n, // 0.1 — below this, the signer is unhealthy
  funder: new TreasuryFunder({
    signer: treasury,
    chainClient,
    feeOracle,
    chainId: CHAIN_ID,
    targetBalanceWei: 5n * 10n ** 17n, // top up to 0.5 (above minBalanceWei)
    minTreasuryWei: 1n * 10n ** 18n, // never spend the treasury below 1.0
    logger,
  }),
});

const balOf = (a: `0x${string}`) => publicClient.getBalance({ address: a });

console.log(`chain ${CHAIN_ID} @ ${RPC_URL}`);
console.log(`pool signer:  ${signer.address}`);
console.log(`treasury:     ${treasury.address}`);
console.log(`\nsigner balance before: ${formatEther(await balOf(signer.address))} ETH`);

pool.start(); // the supervisor sees the drained signer and the funder tops it up

// Wait until the pool has both refilled the account AND re-observed it as healthy
// (the health flag flips on the tick *after* the balance recovers).
let funded = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (pool.wallets()[0]?.healthy) {
    funded = true;
    break;
  }
}

console.log(`signer balance after:  ${formatEther(await balOf(signer.address))} ETH`);
console.log(`signer healthy now:    ${pool.wallets()[0]?.healthy}`);

await pool.stop();
console.log(funded ? "\n✅ funder auto-refilled the drained account" : "\n❌ account was not refilled in time");
process.exit(funded ? 0 : 1);
