# walletsforce

A general-purpose, in-memory **EVM account pool**. Give it a set of signer
accounts and a chain; call `submit(tx)`. It routes the tx to an account,
serializes that account's nonce lane, signs, broadcasts, confirms, and replaces
stuck txs — so your service stops managing nonce lanes and just says "send this".

N accounts = N independent nonce lanes ⇒ you break the single-account
sequential-nonce throughput ceiling, with head-of-line blocking confined to one
lane.

> Architecture, the full component contract, and the seam interfaces are
> documented below — see [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the landscape
> diagram and every component interface in one place.

---

## Install

```bash
npm install walletsforce viem zod
```

`viem` and `zod` are runtime dependencies and are installed automatically; they
are listed above only to make the peer footprint explicit.

walletsforce is **ESM-only** (`"type": "module"`). Import it from an ES module
or a TypeScript project targeting ESM.

---

## The contract (read this first)

| walletsforce **guarantees** | **you** own |
|---|---|
| correct, gap-free nonce per account | a durable journal (your own store) |
| single-writer per account (static partition) | idempotency / dedupe on your business unit |
| no in-process duplicate sends | exactly-once effect across a crash |
| receipt tracking + stuck-tx replacement | replaying unconfirmed txs after restart (`reattach`) |

walletsforce **persists nothing**. Durability is wired through events-out
(`on(...)`) and reattach-in (`reattach(...)`) onto *your* store. See
[Durability & crash recovery](#durability--crash-recovery).

---

## Quick start

```ts
import {
  WalletForcePool,
  LocalKeySigner,
  LegacyFeeOracle,
  ViemChainClient,
} from "walletsforce";

// 1. The owned account set — one nonce lane each. More accounts = more throughput.
const signers = [process.env.KEY_A, process.env.KEY_B, process.env.KEY_C].map(
  (k) => new LocalKeySigner(k as `0x${string}`),
);

// 2. The three pluggable seams.
const chainClient = new ViemChainClient(publicClient); // see note below
const feeOracle = new LegacyFeeOracle({ minGasPriceWei: 5_000_000_000n });

// 3. Construct the pool (one pool per chain).
const pool = new WalletForcePool({
  ownerId: "worker-1",
  chainId: 84005,
  signers,
  chainClient,
  feeOracle,
  confirmations: 1,
  stuckAfterMs: 30_000,
  maxAttempts: 5,
});

pool.start();

// 4. Submit. Resolves on BROADCAST (mempool), not on confirmation.
const key = "packet-14361";
const { account, nonce, hash } = await pool.submit(
  { to: contractAddress, data: calldata },
  { idempotencyKey: key },
);

// 5a. Wait for THIS tx (the common case). Correlates by idempotencyKey, NOT hash.
//     Resolves on confirmed; throws on reverted/failed.
const rec = await pool.waitForConfirmation(key);
console.log("landed", rec.hash);

// 5b. Or consume the firehose for all txs (metrics, DB sync, logging).
pool.on("confirmed", (rec) => console.log("landed", rec.hash));
pool.on("reverted", (rec) => console.warn("reverted", rec.hash));
```

> **Don't wait on `hash`.** A stuck tx is replaced by re-signing the *same nonce*
> with bumped fees, so its hash changes. The stable identifier across the whole
> lifecycle is your **`idempotencyKey`** — wait and correlate on that. The `hash`
> from `submit()` is only the *current* broadcast hash (good for an explorer link).

`submit(req, opts)`:
- `req`: `{ to, data?, value?, gasLimit? }` — the pool fills in nonce, gas, fees.
- `opts.idempotencyKey` (**required**): your dedupe key; echoed on every event.
- `opts.orderingKey` (optional): see [Ordered vs unordered](#ordered-vs-unordered).
- `opts.metadata` (optional): opaque, echoed back on events.

---

## The three seams

You supply one implementation of each. Defaults ship for two of them.

### `Signer` — custody

```ts
import { LocalKeySigner } from "walletsforce";
const signer = new LocalKeySigner("0x<private-key>"); // dev / low-value
```

For production, implement `Signer` over a KMS/HSM/remote service:

```ts
interface Signer {
  readonly address: `0x${string}`;
  signTransaction(tx: SignableTx): Promise<`0x${string}`>; // raw signed tx
}
```

### `FeeOracle` — gas pricing + bump policy

```ts
import { LegacyFeeOracle, Eip1559FeeOracle } from "walletsforce";

// Legacy chains / a gas floor (e.g. besu QBFT skips ~0-gas txs):
new LegacyFeeOracle({ minGasPriceWei: 5_000_000_000n });

// EIP-1559: maxFee = baseFee * headroom + tip
new Eip1559FeeOracle({ priorityFeeWei: 1_500_000_000n });
```

### `ChainClient` — read RPC + broadcast

`ViemChainClient` is a ready-to-use default over a viem `Client` (pass anything
created with `createPublicClient`). It uses the tree-shakeable `viem/actions`, so
it works with any viem client. Or provide your own `ChainClient`:

```ts
import { createPublicClient, http } from "viem";
import { ViemChainClient } from "walletsforce";

const chainClient = new ViemChainClient(
  createPublicClient({ transport: http(process.env.RPC_URL) }),
);
```

The interface, if you implement your own:

```ts
interface ChainClient {
  getTransactionCount(addr, tag): Promise<number>;
  estimateGas(tx): Promise<bigint>;
  getBalance(addr): Promise<bigint>;
  getBaseFeePerGas(): Promise<bigint | null>;
  sendRawTransaction(raw): Promise<`0x${string}`>;
  getTransactionReceipt(hash): Promise<Receipt | null>;
  getBlockNumber(): Promise<bigint>;
  classifyError(err): "nonce-drift" | "transient" | "revert" | "fatal";
}
```

The default `classifyRpcError` helper is exported if you wrap your own client.
Decorators compose: wrap with failover / rate-limiting as needed.

---

## Ordered vs unordered

Whether a stream of txs must land in order is expressed entirely by `orderingKey`.

```ts
// UNORDERED — fan freely across the whole pool (e.g. DVN verify(), order-independent):
await pool.submit({ to, data }, { idempotencyKey: packetId });

// ORDERED — pin to ONE account, FIFO (e.g. executor delivery, per-pathway ordered):
await pool.submit(
  { to, data },
  { idempotencyKey: jobGuid, orderingKey: `${srcEid}-${dstEid}` },
);
```

All requests sharing an `orderingKey` go through the same account in nonce order.
Different keys spread across the pool. Cross-key order is **not** guaranteed.

---

## Durability & crash recovery

walletsforce holds state in memory only. To survive a restart, mirror lifecycle
events into your own store and replay them on boot.

```ts
// Persist on every transition (write-ahead: persist on "broadcast" first).
pool.on("broadcast", (rec) => myStore.upsert(rec)); // {idempotencyKey, account, nonce, hash, fees, ...}
pool.on("replaced", (rec) => myStore.upsert(rec)); // hash changed
pool.on("confirmed", (rec) => myStore.markDone(rec));
pool.on("reverted", (rec) => myStore.markReverted(rec));
pool.on("failed", (rec) => myStore.markFailed(rec));

// On boot, before submitting new work, replay anything left in flight.
for (const rec of await myStore.loadActive()) {
  pool.reattach(rec); // {idempotencyKey, account, nonce, hash, fees, orderingKey?}
}
```

Dedupe (exactly-once effect) is **yours**: check `myStore` for the
`idempotencyKey` before calling `submit`.

No store of your own? Use the bundled `InMemoryStore` for dev — but it's
unbounded and crash-unsafe, so don't ship it for a long-running service.

---

## Auto-refill drained accounts

Set `minBalanceWei` and the pool marks any account below it unhealthy (the router
drops it from rotation) and fires `onLowBalance`. To **refill** automatically,
pass a `funder` — the bundled `TreasuryFunder` tops drained accounts up from a
treasury account each tick:

```ts
import { WalletForcePool, TreasuryFunder, LegacyFeeOracle } from "walletsforce";

const feeOracle = new LegacyFeeOracle({ minGasPriceWei: 1_000_000_000n });

const pool = new WalletForcePool({
  …,
  feeOracle,
  minBalanceWei: 10n ** 17n,        // 0.1 — below this, an account is unhealthy
  funder: new TreasuryFunder({
    signer: treasurySigner,         // a SEPARATE account holding gas
    chainClient,
    feeOracle,
    chainId: 84005,
    targetBalanceWei: 5n * 10n ** 17n, // top up to 0.5 (set above minBalanceWei)
    minTreasuryWei: 10n ** 18n,        // never spend the treasury below 1.0
  }),
});
```

`TreasuryFunder` serializes its sends on its own nonce lane, sends at most one
top-up per recipient until it lands (no double-funding), and refuses to spend the
treasury below `minTreasuryWei` (logging instead). Top-up is fire-and-forget: the
account becomes usable again once the next tick observes the higher balance.

---

## Multiple chains

A pool is single-chain. Use the registry:

```ts
import { PoolRegistry } from "walletsforce";

const registry = new PoolRegistry();
registry.register(84005, poolA);
registry.register(54013, poolB);

await registry.get(dstEid).submit(req, opts);
```

---

## Memory

In-memory state is intentionally small and **bounded** on every axis:

- `inflight` per account — every entry reaches a terminal state
  (`confirmed`/`reverted`/`failed`) and is deleted; a tx that never mines is
  retried up to `maxAttempts`, then `failed` and removed. The largest per-entry
  cost is the retained tx (incl. **calldata**), kept only so a stuck tx can be
  re-signed at the same nonce — released the instant it settles.
- **`maxInflightPerAccount`** (default `512`) — the backpressure lever. It caps
  *queued + unconfirmed* txs per account; `submit` **throws** above it, so a
  producer that outruns the chain can't grow memory without bound. Lower it for
  tighter memory; raise it for burstier load. Handle the throw (retry/queue).
- sticky routing bindings — ref-counted; evicted when an ordering key has no
  active work, so the map is bounded by *active* keys, not all keys ever seen.
- `waitForConfirmation` — keyed by `idempotencyKey` (O(1) dispatch, one small
  entry per active waiter), not per-call event listeners.

zod `.parse` (at `submit`/`reattach`) and the routing snapshot are *transient*
allocations — GC'd immediately, they don't affect steady-state footprint.

Watch for leaks via `pool.stats()`:

```ts
const { wallets, stickyKeys } = pool.stats();
// gauge stickyKeys and sum(wallets[].inflightCount) — a real leak climbs monotonically.
```

---

## API surface

```ts
class WalletForcePool {
  start(): void;
  stop(): Promise<void>;
  submit(req, opts): Promise<{ account; nonce; hash; fees }>; // resolves on broadcast
  waitForConfirmation(idempotencyKey): Promise<TxEventRecord>; // resolves confirmed / rejects reverted|failed
  reattach(tx): void;
  on(event, cb): void;   // "broadcast"|"mined"|"confirmed"|"reverted"|"replaced"|"failed"
  off(event, cb): void;
  wallets(): WalletState[];
  stats(): { wallets; stickyKeys };
}
```

---

## Status

The core engine is implemented and usable. What works today vs. what's still a
stub:

| Area | Status |
|---|---|
| Types, config, facade, events | ✅ implemented |
| Nonce lane (mutex + reseed) | ✅ implemented |
| `submit` pipeline (gas → fees → sign → broadcast) | ✅ implemented |
| Confirm / replace / give-up loop (`confirmTick`) | ✅ implemented (bounded) |
| In-flight cap (`maxInflightPerAccount`) backpressure | ✅ implemented |
| Sticky routing + ref-counted eviction | ✅ implemented |
| `start()`/`stop()` Supervisor (single loop, backoff, boot nonce-reseed) | ✅ implemented |
| Balance refresh + health (inline BalanceMonitor) | ✅ implemented |
| `LocalKeySigner`, `LegacyFeeOracle`, `Eip1559FeeOracle`, `InMemoryStore` | ✅ implemented |
| `ViemChainClient` RPC methods | ✅ implemented (over `viem/actions`) |
| `Funder` (treasury top-up via `TreasuryFunder`) | ✅ implemented |
| Durable `PoolStore` adapter (SQLite) | ⏳ TODO (`InMemoryStore` only) |
