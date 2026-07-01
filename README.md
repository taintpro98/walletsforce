# walletsforce

**Send lots of transactions to an EVM chain, fast, from many wallets — without
babysitting nonces.** Give it a set of signer accounts and a chain; call
`submit(tx)`. It picks a wallet, orders that wallet's nonces, signs, broadcasts,
waits for confirmation, and replaces stuck txs — so your service stops managing
nonce bookkeeping and just says "send this".

## The problem it solves

On an EVM chain, every account sends transactions through a **nonce** — a
strictly sequential counter (0, 1, 2, …). The chain will not mine nonce 5 until
nonce 4 is in. So **one wallet can only push transactions one-at-a-time, in
order**: if the tx at nonce 4 gets stuck (underpriced gas, dropped from the
mempool), *everything behind it is blocked too* — this is head-of-line blocking.
That single-wallet sequential-nonce limit is a hard ceiling on how many txs per
second you can land. And doing it by hand is fiddly: you have to track the next
nonce, avoid gaps and collisions, price gas, detect stuck txs, re-sign them with
a higher fee, and not lose the in-flight ones if your process crashes.

**walletsforce turns that into a pool of wallets.** Each wallet is one
independent nonce lane, so **N wallets = N transactions in flight at once** — you
break the single-wallet ceiling, and a stuck tx only blocks its own lane, not the
others. All the fiddly parts (nonce ordering, gas, fees, broadcast, confirmation,
stuck-tx replacement, crash recovery) are handled for you behind `submit(tx)`.

> See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the landscape diagram and every
> component interface in one place, and [`examples/`](./examples) for runnable
> demos (`basic`, `contract-call`, `local`, `funder`, `durable`, `testnet`).

---

## Prerequisites

- **Node ≥ 18** for the in-memory path; **Node ≥ 22.5** if you use the SQLite store
  (it relies on the built-in `node:sqlite`).
- An **ESM project** (`"type": "module"`) — walletsforce is ESM-only.
- **`viem`** installed alongside it (it's a peer dependency — see [Install](#install)).
- An **EVM JSON-RPC endpoint** to read from and broadcast to (an `RPC_URL`).
- **One or more signer accounts, each funded with native gas** — a mnemonic to derive
  lanes from (the usual way), or individual private keys / a KMS. Each account is one
  nonce lane and must hold gas to send.

---

## Install

```bash
npm install walletsforce viem
```

`viem` is a **peer dependency** (you provide it, so there's one copy). `zod` is a
regular dependency and installs automatically.

---

## Quick start

```ts
import {
  WalletForcePool,
  Supervisor,
  createSubstrate,
  deriveHDSigners,
  LegacyFeeOracle,
  ViemChainClient,
  type WalletConfig,
} from "walletsforce";
import { createPublicClient, http } from "viem";

// 1. The owned account set — one nonce lane each. More accounts = more throughput.
//    Derive N accounts from ONE mnemonic (BIP-44 m/44'/60'/0'/0/i) — the usual way.
//    (For individual keys / KMS, use `new LocalKeySigner(pk)` or your own Signer.)
const signers = deriveHDSigners(process.env.MNEMONIC!, 10); // 10 lanes from one seed

// 2. Shared identity + account inputs (the three seams live here too).
const config: WalletConfig = {
  ownerId: "worker-1",
  chainId: 84005,
  signers,
  chainClient: new ViemChainClient(createPublicClient({ transport: http(process.env.RPC_URL) })),
  feeOracle: new LegacyFeeOracle({ minGasPriceWei: 5_000_000_000n }),
  confirmations: 1,
  stuckAfterMs: 30_000,
  maxAttempts: 5,
};

// 3. Build the shared substrate ONCE, inject into both.
//    in-memory (one pod). For durability: { store: { kind: "sqlite", path: "wf.sqlite" } }
const substrate = createSubstrate(config);
const pool = new WalletForcePool(config, substrate);
const supervisor = new Supervisor({ ...config, confirmTickMs: 4_000 }, substrate);

await pool.start();   // boot reconcile: rebuild from the store (no-op for a fresh in-mem store)
supervisor.start();   // start the confirm / replace / refresh loop

// 4. Submit. Resolves on BROADCAST (mempool), not on confirmation.
const key = "packet-14361";
const { account, nonce, hash } = await pool.submit(
  { to: contractAddress, data: calldata },
  { idempotencyKey: key },
);

// 5a. Wait for THIS tx (common case). Correlates by idempotencyKey, NOT hash.
//     Resolves on confirmed; throws on reverted/failed. Pass a timeout to bound the wait.
const rec = await pool.waitForConfirmation(key, { timeoutMs: 120_000 });
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
- `req`: `{ to, data?, value?, gasLimit? }` — the pool fills in nonce, gas (unless you
  set `gasLimit`), and fees.
- `opts.idempotencyKey` (**required**): your dedupe key; echoed on every event.
- `opts.orderingKey` (optional): see [Ordered vs unordered](#ordered-vs-unordered).
- `opts.metadata` (optional): opaque, echoed back on events. Must be JSON-serializable
  if you use a durable store (it's persisted as JSON).

---

## Mental model

walletsforce is three things you wire together:

- **`WalletForcePool`** — the **submit** surface: route → nonce → gas → fees → sign
  → broadcast. Reactive; has no background loop.
- **`Supervisor`** — the **reconcile** loop: on a timer it confirms/replaces stuck
  txs and refreshes balances (and refills, if you give it a funder). You start it.
- **`Substrate`** — the shared runtime both run over: **cache** (fast working set:
  nonce lanes, in-flight, routing), **store** (durable record), **event bus**
  (`on`/`waitForConfirmation`), and the **account set**. Built **once** with
  `createSubstrate(config)` and injected into both, so a submit and its
  confirmation meet over one working set.

Two deployment shapes fall out of this:

| Mode | Cache / Store / Bus | Topology |
|---|---|---|
| **individual** (default) | in-memory | one process runs Pool **and** Supervisor |
| **group** | shared (Redis / SQL) | many submit pods run Pools; **one** pod runs the Supervisor |

Run the Supervisor in exactly **one** place per account set — the tick must not
run concurrently on many pods.

---

## The contract

| walletsforce **guarantees** | **you** own |
|---|---|
| correct, gap-free nonce per account | idempotency / dedupe on your business unit |
| single-writer per account (static partition) | exactly-once *effect* across a crash |
| no in-process duplicate sends | choosing durability: in-memory (default) or a durable store |
| receipt tracking + stuck-tx replacement | running the Supervisor in exactly one place (group mode) |

Durability is a **choice**: with the default in-memory store nothing survives a
crash; inject the **SQLite store** (or your own `PoolStore`) and the pool
write-aheads before broadcast and rebuilds on boot via `restore()`. See
[Durability](#durability--crash-recovery).

---

## Config split

Config carries **policy**; the substrate carries the **injected runtime**. Policy is
split by who reads it:

- **`WalletConfig`** (shared) — `ownerId`, `chainId`, `signers`, `chainClient`,
  `feeOracle`, `confirmations`, `stuckAfterMs`, `maxAttempts`, `maxInflightPerAccount`,
  `logger`. Both Pool and Supervisor build their account set from this.
- **`WalletPoolConfig`** = `WalletConfig` + `selector` (routing).
- **`SupervisorConfig`** = `WalletConfig` + `confirmTickMs`, `minBalanceWei`,
  `onLowBalance`. The auto-refill **`funder` is not config** — it's a caller-owned
  service (holds a treasury signer), injected as the Supervisor's 3rd argument.

---

## The three seams

You supply one implementation of each. Defaults ship for two of them.

### `Signer` — custody

```ts
import { LocalKeySigner, deriveHDSigners } from "walletsforce";
const signer = new LocalKeySigner("0x<private-key>");          // dev / low-value
const signers = deriveHDSigners(mnemonic, 10);                 // 10 lanes from one seed (BIP-44)
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
new LegacyFeeOracle({ minGasPriceWei: 5_000_000_000n });   // legacy chains / a gas floor
new Eip1559FeeOracle({ priorityFeeWei: 1_500_000_000n });  // maxFee = baseFee*headroom + tip
```

### `ChainClient` — read RPC + broadcast

`ViemChainClient` is a ready default over a viem `Client` (anything from
`createPublicClient`). It uses the tree-shakeable `viem/actions`, so it's robust
across viem minors. Or implement your own:

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

---

## Ordered vs unordered

Whether a stream of txs must land in order is expressed entirely by `orderingKey`.

```ts
// UNORDERED — fan freely across the whole pool:
await pool.submit({ to, data }, { idempotencyKey: packetId });

// ORDERED — pin to ONE account, FIFO:
await pool.submit({ to, data }, { idempotencyKey: jobGuid, orderingKey: `${srcEid}-${dstEid}` });
```

All requests sharing an `orderingKey` go through the same account in nonce order.
Different keys spread across the pool. Cross-key order is **not** guaranteed.

---

## Durability & crash recovery

The store is a pluggable **`PoolStore`**, selected via `createStore` (or passed as an
instance). The pool writes **store-first** (write-ahead before broadcast), and
`pool.start()` (= `restore()`) rebuilds the cache from the store on boot and
re-broadcasts anything left in flight.

```ts
// Durable: a SQLite-backed store survives a crash.
const substrate = createSubstrate(config, { store: { kind: "sqlite", path: "wf.sqlite" } });
const pool = new WalletForcePool(config, substrate);

const restored = await pool.start(); // rebuilds from wf.sqlite; returns # of txs re-tracked
```

- **`{ kind: "memory" }`** (default) — nothing survives a crash; unbounded history is
  dropped (terminal txs are evicted). Fine for dev / stateless workers.
- **`{ kind: "sqlite", path }`** — durable; terminal rows retained as history; WAL
  mode for throughput. Node ≥ 22.5.
- **Bring your own** — implement `PoolStore` (e.g. Postgres for group mode) and pass
  the instance: `createSubstrate(config, { store: myPgStore })`.

You can still mirror the event firehose into an external system, and `reattach()`
resumes tracking a tx you signed/broadcast elsewhere:

```ts
pool.on("broadcast", (rec) => metrics.record(rec));
await pool.reattach({ idempotencyKey, account, nonce, hash, fees, orderingKey });
```

Dedupe (exactly-once *effect*) is still **yours**: check for the `idempotencyKey`
before calling `submit`.

---

## Auto-refill drained accounts

Set `minBalanceWei` (Supervisor config) and any account below it is marked unhealthy
(the router drops it) and fires `onLowBalance`. To **refill** automatically, inject a
`funder` as the Supervisor's 3rd argument — the bundled `TreasuryFunder` tops drained
accounts up from a treasury account each tick:

```ts
import { Supervisor, TreasuryFunder } from "walletsforce";

const supervisor = new Supervisor(
  { ...config, confirmTickMs: 4_000, minBalanceWei: 10n ** 17n }, // 0.1 -> unhealthy below this
  substrate,
  new TreasuryFunder({
    signer: treasurySigner,             // a SEPARATE account holding gas
    chainClient,
    feeOracle,
    chainId: 84005,
    targetBalanceWei: 5n * 10n ** 17n,  // top up to 0.5 (above minBalanceWei)
    minTreasuryWei: 10n ** 18n,         // never spend the treasury below 1.0
  }),
);
```

`TreasuryFunder` serializes its sends on its own nonce lane, sends at most one top-up
per recipient until it lands, and refuses to spend the treasury below `minTreasuryWei`.
The account becomes usable again once the next tick observes the higher balance.

---

## Multiple chains

A pool is single-chain — one `(config, substrate, pool, supervisor)` per chain. The
registry maps chain id → pool:

```ts
import { PoolRegistry } from "walletsforce";

const registry = new PoolRegistry();
registry.register(84005, poolA);
registry.register(54013, poolB);

await registry.get(dstEid).submit(req, opts);
```

---

## Memory

In-memory state is intentionally small and **bounded**:

- `inflight` per account — every entry reaches terminal and is dropped from the cache;
  a tx that never mines is retried up to `maxAttempts`, then `failed` and removed.
- **`maxInflightPerAccount`** (default `512`) — backpressure: `submit` **throws** above
  the cap, so a producer that outruns the chain can't grow memory without bound.
- sticky routing bindings — ref-counted; evicted when an ordering key has no active work.
- `waitForConfirmation` — keyed by `idempotencyKey` (O(1) dispatch); pass `timeoutMs` so
  a key that never settles can't wait (or leak) forever.

Watch for leaks via `pool.stats()`:

```ts
const { wallets, stickyKeys } = await pool.stats();
// gauge stickyKeys and sum(wallets[].inflightCount) — a real leak climbs monotonically.
```

---

## API surface

```ts
// Build the shared runtime once, inject into both.
createSubstrate(config, opts?): Substrate;   // { cache, store, bus, accounts }
createStore(cfg): PoolStore;                  // { kind: "memory" } | { kind: "sqlite", path }

class WalletForcePool {
  constructor(config: WalletPoolConfig, substrate: Substrate);
  start(): Promise<number>;                   // = restore(): rebuild from store; returns # restored
  stop(): Promise<void>;                      // graceful (reactive pool; nothing to flush)
  submit(req, opts): Promise<{ account; nonce; hash; fees }>; // resolves on broadcast
  waitForConfirmation(key, { timeoutMs? }?): Promise<TxEventRecord>; // confirmed / rejects reverted|failed|timeout
  reattach(tx): Promise<void>;
  restore(): Promise<number>;
  on(event, cb) / off(event, cb);             // "broadcast"|"mined"|"confirmed"|"replaced"|"reverted"|"failed"
  wallets(): Promise<WalletState[]>;
  stats(): Promise<{ wallets; stickyKeys }>;
}

class Supervisor {
  constructor(config: SupervisorConfig, substrate: Substrate, funder?: Funder);
  start(): void;                              // start the reconcile/refill loop
  stop(): Promise<void>;                      // stop scheduling; lets the in-flight tick finish
}
```

> **Status vs event.** `TxStatus` is what a row is *persisted* as
> (`pending|broadcast|mined|confirmed|reverted|failed`). `TxEvent` is what you
> *observe* (`broadcast|mined|confirmed|replaced|reverted|failed`) — no `pending`
> (internal write-ahead), and `replaced` is emit-only (a fee-bump notification).

---

## Status

| Area | Status |
|---|---|
| Types, config, facade, events, nonce lane | ✅ implemented |
| `submit` pipeline (gas → fees → sign → broadcast) | ✅ implemented |
| Confirm / replace / give-up loop (`Supervisor`) | ✅ implemented (bounded) |
| In-flight cap backpressure + sticky routing/eviction | ✅ implemented |
| Pool / Supervisor / Substrate split (individual + group-ready) | ✅ implemented |
| `LocalKeySigner`, `deriveHDSigners`, `Legacy`/`Eip1559FeeOracle` | ✅ implemented |
| `ViemChainClient` (over `viem/actions`) | ✅ implemented |
| `Funder` / `TreasuryFunder` (treasury top-up) | ✅ implemented |
| `PoolStore`: `InMemoryStore` + **`SqliteStore`** (WAL, crash recovery) | ✅ implemented |
| Group mode: Redis cache / Redis event bus / SQL store, Supervisor leader-lease | ⏳ TODO (interfaces defined) |
